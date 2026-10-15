//! Windows paste-back: restore the previous foreground window, send Ctrl+V.
//!
//! The awkward part is not the keystroke, it is the focus. Windows only lets
//! the process that currently owns the foreground give it away, which is
//! exactly our situation -- the panel has focus when the user presses Enter.
//! Even so `SetForegroundWindow` can be refused, so nothing here trusts it:
//! the keystroke is only sent once `GetForegroundWindow` actually reports the
//! target, and a timeout reports failure rather than typing into whatever
//! happens to be focused instead.

use super::PasteStatus;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
    VIRTUAL_KEY, VK_C, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT, VK_V,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowThreadProcessId, IsWindow, SetForegroundWindow,
};

/// The window that had focus when the panel was last opened.
///
/// Stored as `isize` because `HWND` is a raw pointer and therefore not `Send`,
/// and this is read from a different thread than the one that wrote it. The
/// handle is re-validated with `IsWindow` before use -- the app may well have
/// been closed while the panel was up.
static PREVIOUS: Mutex<Option<isize>> = Mutex::new(None);

/// How long to wait for the focus change to land before giving up. Generous
/// enough for a loaded machine, short enough that a failure still feels
/// immediate.
const FOREGROUND_TIMEOUT: Duration = Duration::from_millis(400);
const POLL_STEP: Duration = Duration::from_millis(10);

pub fn remember_foreground() {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return;
    }

    // Our own panel is never the paste target. Without this, toggling the panel
    // while it is already focused would overwrite the real target with itself.
    if is_own_window(hwnd) {
        return;
    }

    if let Ok(mut guard) = PREVIOUS.lock() {
        *guard = Some(hwnd.0 as isize);
    }
}

/// True when the window belongs to this process.
fn is_own_window(hwnd: HWND) -> bool {
    let mut pid: u32 = 0;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid == std::process::id()
}

pub fn support() -> PasteStatus {
    PasteStatus { supported: true, pasted: false, reason: None }
}

pub fn paste_into_previous() -> PasteStatus {
    paste_into_previous_inner(false)
}

/// As `paste_into_previous`, but only sends the keystroke once UI Automation
/// confirms the focused control in the target window is a password box. Any
/// other answer -- a plain text field, a control UIA cannot describe, an error
/// -- sends nothing, and the password stays on the clipboard to place by hand.
pub fn paste_password_into_previous() -> PasteStatus {
    paste_into_previous_inner(true)
}

fn paste_into_previous_inner(require_password: bool) -> PasteStatus {
    let Some(raw) = PREVIOUS.lock().ok().and_then(|g| *g) else {
        return PasteStatus::failed("nothing was focused when the panel opened");
    };

    let target = HWND(raw as *mut std::ffi::c_void);
    if !unsafe { IsWindow(Some(target)) }.as_bool() {
        return PasteStatus::failed("the window you copied from has closed");
    }

    if !focus(target) {
        return PasteStatus::failed(
            "could not focus the previous window; the item is on your clipboard",
        );
    }

    if require_password {
        match focused_is_password(target) {
            Ok(true) => {}
            Ok(false) => {
                return PasteStatus::failed(
                    "Nothing typed: the focused field isn't a password field. The password \
                     was copied for 30 seconds -- click the password field and press Ctrl+V.",
                )
            }
            Err(e) => {
                tracing::debug!(error = %e, "could not inspect the focused control");
                return PasteStatus::failed(
                    "Nothing typed: couldn't confirm the focused field is a password field. \
                     The password was copied for 30 seconds -- press Ctrl+V to paste it.",
                );
            }
        }
    }

    match send_paste() {
        Ok(()) => PasteStatus::pasted(),
        Err(reason) => PasteStatus::failed(reason),
    }
}

/// Brings `target` to the foreground and waits until Windows agrees that it is
/// there. Returns false rather than pressing on, because sending Ctrl+V to an
/// unknown window is worse than not pasting at all.
fn focus(target: HWND) -> bool {
    unsafe {
        let _ = SetForegroundWindow(target);
    }
    if wait_for_foreground(target) {
        return true;
    }

    // Second attempt: borrow the target thread's input state so the foreground
    // change is allowed. This is the long-standing workaround for the cases
    // where a bare SetForegroundWindow is refused.
    let target_thread = unsafe { GetWindowThreadProcessId(target, None) };
    if target_thread == 0 {
        return false;
    }
    let this_thread = unsafe { GetCurrentThreadId() };
    if target_thread == this_thread {
        return false;
    }

    unsafe {
        if !AttachThreadInput(this_thread, target_thread, true).as_bool() {
            return false;
        }
        let _ = SetForegroundWindow(target);
        let ok = wait_for_foreground(target);
        let _ = AttachThreadInput(this_thread, target_thread, false);
        ok
    }
}

fn wait_for_foreground(target: HWND) -> bool {
    let deadline = Instant::now() + FOREGROUND_TIMEOUT;
    loop {
        if unsafe { GetForegroundWindow() }.0 == target.0 {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(POLL_STEP);
    }
}

/// Asks UI Automation whether the control with keyboard focus is a password
/// box, and whether it belongs to `target`'s process -- a focus that drifted to
/// some other window between the focus check and now must not pass.
///
/// Runs on a `spawn_blocking` thread, so COM is initialised here and balanced
/// before returning. `S_FALSE` (already initialised on this thread) still needs
/// the matching `CoUninitialize`; `RPC_E_CHANGED_MODE` does not.
fn focused_is_password(target: HWND) -> Result<bool, String> {
    let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    let initialised = hr.is_ok();
    let result = (|| -> windows::core::Result<bool> {
        let uia: IUIAutomation =
            unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)? };
        let el = unsafe { uia.GetFocusedElement()? };

        let mut target_pid: u32 = 0;
        unsafe { GetWindowThreadProcessId(target, Some(&mut target_pid)) };
        if unsafe { el.CurrentProcessId()? } as u32 != target_pid {
            return Ok(false);
        }
        Ok(unsafe { el.CurrentIsPassword()? }.as_bool())
    })();
    if initialised {
        unsafe { CoUninitialize() };
    }
    result.map_err(|e| e.to_string())
}

fn key(vk: VIRTUAL_KEY, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: if up { KEYEVENTF_KEYUP } else { Default::default() },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// Ctrl down, V down, V up, Ctrl up -- in one `SendInput` call so nothing can
/// interleave between the modifier and the key.
fn send_paste() -> Result<(), String> {
    // The usual cause of a failure is UIPI: a window running elevated will not
    // accept synthetic input from a process that is not.
    if send_ctrl_chord(VK_V) {
        Ok(())
    } else {
        Err("Windows blocked the keystroke (an elevated window?); the item is on your clipboard"
            .to_string())
    }
}

fn send_ctrl_chord(vk: VIRTUAL_KEY) -> bool {
    let inputs = [
        key(VK_CONTROL, false),
        key(vk, false),
        key(vk, true),
        key(VK_CONTROL, true),
    ];

    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    sent as usize == inputs.len()
}

fn modifiers_held() -> bool {
    [VK_CONTROL, VK_MENU, VK_SHIFT, VK_LWIN, VK_RWIN]
        .iter()
        .any(|vk| unsafe { GetAsyncKeyState(vk.0 as i32) } as u16 & 0x8000 != 0)
}

/// Copies the selection in the focused window for the capture shortcut.
///
/// The shortcut that triggered this is still physically held when it fires.
/// Sending Ctrl+C on top of a held Ctrl+Alt would arrive as Ctrl+Alt+C -- the
/// capture shortcut itself -- and either retrigger it or be read by the target
/// app as something else entirely. So wait until every modifier is up, and if
/// they never are, send nothing rather than guess.
pub fn copy_selection() -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_millis(600);
    while modifiers_held() {
        if Instant::now() >= deadline {
            return Err("modifier keys were still held; release them and try again".to_string());
        }
        std::thread::sleep(POLL_STEP);
    }
    if send_ctrl_chord(VK_C) {
        Ok(())
    } else {
        Err("Windows blocked the keystroke (an elevated window?)".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Manual probe, not part of the suite: focus a field in another window,
    /// then run `cargo test uia_probe -- --ignored --nocapture` within the
    /// `CLIPTACK_PROBE_DELAY_MS` window. Prints what the password guard would see.
    #[test]
    #[ignore]
    fn uia_probe() {
        let delay = std::env::var("CLIPTACK_PROBE_DELAY_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        std::thread::sleep(Duration::from_millis(delay));
        let fg = unsafe { GetForegroundWindow() };
        let mut fg_pid = 0u32;
        unsafe { GetWindowThreadProcessId(fg, Some(&mut fg_pid)) };

        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let uia: IUIAutomation =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).unwrap();
            let el = uia.GetFocusedElement().unwrap();
            println!(
                "PROBE fg_pid={fg_pid} focused_pid={:?} name={:?} class={:?} is_password={:?}",
                el.CurrentProcessId(),
                el.CurrentName().map(|s| s.to_string()),
                el.CurrentClassName().map(|s| s.to_string()),
                el.CurrentIsPassword().map(|b| b.as_bool()),
            );
        }
        println!("PROBE guard={:?}", focused_is_password(fg));
    }
}
