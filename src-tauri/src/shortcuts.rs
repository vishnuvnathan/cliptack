//! The global shortcuts: open the panel, and two optional ones -- copy-and-save
//! the current selection, and hide or show every sticky.
//!
//! Both are stored as strings in settings.json and parsed here, once, into
//! `Shortcut` values. Everything that can go wrong with a user-chosen key --
//! unparsable, no modifier, already owned by another app, colliding with the
//! other shortcut -- is reported as a message the settings panel can show,
//! and a failed change leaves the previous bindings registered.

use crate::settings::CaptureMode;
use crate::settings::Settings;
use crate::state::AppState;
use crate::window;
use std::str::FromStr;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

pub const DEFAULT_TOGGLE: &str = "CommandOrControl+Shift+KeyV";
// Not Ctrl+Shift+C: Windows Terminal and browser devtools both claim it.
pub const DEFAULT_CAPTURE: &str = "CommandOrControl+Alt+KeyC";

/// How long a capture press keeps the gate open. Covers waiting for the user to
/// let go of the modifiers (up to 600ms), the target app's copy, and one 400ms
/// clipboard poll, with headroom for a slow app.
const ARM_WINDOW: Duration = Duration::from_millis(2500);

/// A shortcut with no modifier would swallow an ordinary key system-wide, so it
/// is refused outright rather than registered.
pub fn parse(s: &str) -> Result<Shortcut, String> {
    let shortcut =
        Shortcut::from_str(s).map_err(|e| format!("\"{s}\" is not a valid shortcut ({e})"))?;
    if shortcut.mods.is_empty() {
        return Err(format!("\"{s}\" needs a modifier key (Ctrl, Alt or Shift)"));
    }
    Ok(shortcut)
}

/// Whether two shortcut strings mean the same key combination, regardless of
/// spelling (`Ctrl` vs `CommandOrControl`, key case).
pub fn same(a: &str, b: &str) -> bool {
    matches!((parse(a), parse(b)), (Ok(a), Ok(b)) if a == b)
}

/// What is registered with the OS right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Active {
    pub toggle: Shortcut,
    /// `Some` only while capture mode is `Shortcut`.
    pub capture: Option<Shortcut>,
    /// `Some` only once the user has picked a key for it.
    pub stickies: Option<Shortcut>,
}

/// Strict: an invalid string is an error here. Used for what the user just
/// typed. Values read from disk go through `Settings::sanitize` first.
pub fn resolve(settings: &Settings) -> Result<Active, String> {
    let toggle = parse(&settings.toggle_shortcut)?;
    let capture = parse(&settings.capture_shortcut)?;
    if toggle == capture {
        return Err("The open-panel shortcut and the capture shortcut must be different".into());
    }
    let stickies = match settings.stickies_shortcut.as_str() {
        "" => None,
        s => Some(parse(s)?),
    };
    if stickies == Some(toggle) {
        return Err("The hide-stickies shortcut and the open-panel shortcut must be different".into());
    }
    if stickies == Some(capture) {
        return Err("The hide-stickies shortcut and the capture shortcut must be different".into());
    }
    Ok(Active {
        toggle,
        capture: (settings.capture_mode == CaptureMode::Shortcut).then_some(capture),
        stickies,
    })
}

fn wanted(active: &Active) -> Vec<Shortcut> {
    let mut v = vec![active.toggle];
    v.extend(active.capture);
    v.extend(active.stickies);
    v
}

/// Moves the OS registrations from `old` to `new`. Atomic in effect: if any new
/// key cannot be registered, everything is put back as it was.
pub fn reconcile(app: &AppHandle, old: &Active, new: &Active) -> Result<(), String> {
    let gs = app.global_shortcut();
    let old_set = wanted(old);
    let new_set = wanted(new);

    let removed: Vec<Shortcut> = old_set.iter().filter(|s| !new_set.contains(s)).copied().collect();
    let added: Vec<Shortcut> = new_set.iter().filter(|s| !old_set.contains(s)).copied().collect();

    for s in &removed {
        let _ = gs.unregister(*s);
    }

    let mut done: Vec<Shortcut> = Vec::new();
    for s in &added {
        match gs.register(*s) {
            Ok(()) => done.push(*s),
            Err(e) => {
                for d in &done {
                    let _ = gs.unregister(*d);
                }
                for r in &removed {
                    let _ = gs.register(*r);
                }
                tracing::warn!(shortcut = %s, error = %e, "shortcut registration failed");
                return Err(format!(
                    "Could not use {s}: another app probably already owns it. Pick a different combination."
                ));
            }
        }
    }
    Ok(())
}

/// Called from the plugin's handler, on the hotkey thread, for every press.
///
/// The `Active` is copied out and the lock dropped before acting: `reconcile`
/// registers keys from another thread and waits on this one, so holding the
/// lock across the action could deadlock a settings change against a keypress.
pub fn on_pressed(app: &AppHandle, received: &Shortcut) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let active = match state.shortcuts.lock() {
        Ok(g) => *g,
        Err(_) => return,
    };

    if *received == active.toggle {
        window::toggle(app);
    } else if active.capture == Some(*received) {
        capture_selection(&state);
    } else if active.stickies == Some(*received) {
        crate::sticky::toggle_all(app);
    }
}

/// Copy the current selection in whatever app has focus and let exactly that
/// one clipboard change into history.
///
/// Order matters: the gate is armed first so the change cannot land before
/// anyone is listening for it; the keystroke is only sent once the user has let
/// go of the shortcut's modifiers (see `paste::copy_selection`). Where the
/// keystroke cannot be sent the gate stays armed anyway, so a manual Ctrl+C
/// inside the window still counts.
fn capture_selection(state: &AppState) {
    let gate = state.capture_gate.clone();
    let deadline = gate.arm(ARM_WINDOW);

    // Off the hotkey thread: the modifier wait sleeps.
    std::thread::spawn(move || {
        if let Err(reason) = crate::paste::copy_selection() {
            tracing::info!(reason, "could not send copy; a manual copy will still be saved");
        }
        std::thread::sleep(ARM_WINDOW);
        if gate.expire(deadline) {
            tracing::info!("capture shortcut: nothing was copied, nothing saved");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_parse() {
        assert!(parse(DEFAULT_TOGGLE).is_ok());
        assert!(parse(DEFAULT_CAPTURE).is_ok());
        assert!(!same(DEFAULT_TOGGLE, DEFAULT_CAPTURE));
    }

    #[test]
    fn frontend_spelling_parses() {
        // What the settings recorder sends: Ctrl/Alt/Shift plus a KeyboardEvent.code.
        assert!(parse("Ctrl+Alt+KeyC").is_ok());
        assert!(parse("Ctrl+Shift+Digit1").is_ok());
        assert!(parse("Alt+F9").is_ok());
        assert!(parse("Ctrl+Shift+ArrowUp").is_ok());
        assert!(parse("Ctrl+Alt+Space").is_ok());
        assert!(parse("Ctrl+Backquote").is_ok());
    }

    #[test]
    fn modifier_is_required() {
        assert!(parse("KeyV").is_err());
        assert!(parse("F5").is_err());
    }

    #[test]
    fn nonsense_is_rejected() {
        assert!(parse("").is_err());
        assert!(parse("Ctrl+").is_err());
        assert!(parse("Ctrl+Alt").is_err());
        assert!(parse("Ctrl+Nonsense").is_err());
        assert!(parse("Ctrl+KeyA+KeyB").is_err());
    }

    #[test]
    fn same_ignores_spelling() {
        assert!(same("Ctrl+Shift+KeyV", "ctrl+shift+v"));
        assert!(!same("Ctrl+Shift+KeyV", "Ctrl+Alt+KeyV"));
        assert!(!same("garbage", "garbage"));
    }

    #[test]
    fn resolve_requires_distinct_shortcuts() {
        let s = Settings {
            toggle_shortcut: "Ctrl+Alt+KeyC".into(),
            capture_shortcut: "Ctrl+Alt+KeyC".into(),
            ..Settings::default()
        };
        assert!(resolve(&s).is_err());
    }

    #[test]
    fn capture_is_only_active_in_shortcut_mode() {
        let mut s = Settings::default();
        assert_eq!(resolve(&s).unwrap().capture, None);
        s.capture_mode = CaptureMode::Shortcut;
        assert!(resolve(&s).unwrap().capture.is_some());
    }

    #[test]
    fn stickies_shortcut_is_optional_and_distinct() {
        let mut s = Settings::default();
        assert_eq!(resolve(&s).unwrap().stickies, None);
        s.stickies_shortcut = "Ctrl+Alt+KeyH".into();
        assert!(resolve(&s).unwrap().stickies.is_some());
        s.stickies_shortcut = s.toggle_shortcut.clone();
        assert!(resolve(&s).is_err());
    }

    #[test]
    fn resolve_reports_the_offending_value() {
        let s = Settings { toggle_shortcut: "Ctrl+Nonsense".into(), ..Settings::default() };
        let err = resolve(&s).unwrap_err();
        assert!(err.contains("Ctrl+Nonsense"), "{err}");
    }
}
