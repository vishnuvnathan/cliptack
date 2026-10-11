use crate::db::Db;
use crate::settings::Settings;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Remembers the hash `copy_item` just wrote to the clipboard so the watcher
/// does not immediately re-record our own paste-back as a fresh entry.
///
/// One-shot on purpose: it is cleared by the first matching snapshot, so a
/// genuine later copy of the same content still registers as a bump.
#[derive(Clone, Default)]
pub struct SelfCopyGuard(Arc<Mutex<Option<String>>>);

impl SelfCopyGuard {
    pub fn expect(&self, hash: String) {
        if let Ok(mut g) = self.0.lock() {
            *g = Some(hash);
        }
    }

    pub fn take_if_matches(&self, hash: &str) -> bool {
        let Ok(mut g) = self.0.lock() else {
            return false;
        };
        if g.as_deref() == Some(hash) {
            *g = None;
            true
        } else {
            false
        }
    }
}

/// Tracks the password currently sitting on the clipboard so it can be taken
/// back off again.
///
/// The hash alone is not enough to decide whether a clear is safe. Copy the
/// same password twice and the second copy's content is indistinguishable from
/// the first's, so the first timer would wipe it early -- at 30s from the first
/// copy rather than the second. The generation counter is what makes "is this
/// still the copy I armed?" answerable.
#[derive(Clone, Default)]
pub struct PasswordClipboard {
    armed: Arc<Mutex<Option<(u64, String)>>>,
    generation: Arc<AtomicU64>,
}

impl PasswordClipboard {
    /// Records a freshly copied password and returns the generation the
    /// expiring task must present to be allowed to clear it.
    pub fn arm(&self, hash: String) -> u64 {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        if let Ok(mut g) = self.armed.lock() {
            *g = Some((generation, hash));
        }
        generation
    }

    /// The hash to clear, if `generation` is still the newest copy. `None` means
    /// something has been copied since and this timer has been superseded.
    pub fn take_if_current(&self, generation: u64) -> Option<String> {
        let mut g = self.armed.lock().ok()?;
        match g.as_ref() {
            Some((armed_gen, hash)) if *armed_gen == generation => {
                let hash = hash.clone();
                *g = None;
                Some(hash)
            }
            _ => None,
        }
    }

    /// Called when a password is deliberately superseded, so a pending timer
    /// stops considering itself current.
    pub fn disarm(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut g) = self.armed.lock() {
            *g = None;
        }
    }
}

/// Decides whether a clipboard change becomes a history entry.
///
/// In `auto` mode every change is admitted. Otherwise a change is admitted only
/// while the capture shortcut has armed the gate, and exactly once per arming:
/// one key press saves one item, even if the target app writes the clipboard
/// twice.
#[derive(Clone)]
pub struct CaptureGate(Arc<GateInner>);

struct GateInner {
    auto: AtomicBool,
    /// Wall-clock milliseconds the current arming expires at; 0 = not armed.
    armed_until: AtomicU64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl CaptureGate {
    pub fn new(auto: bool) -> Self {
        CaptureGate(Arc::new(GateInner {
            auto: AtomicBool::new(auto),
            armed_until: AtomicU64::new(0),
        }))
    }

    pub fn set_auto(&self, auto: bool) {
        self.0.auto.store(auto, Ordering::SeqCst);
        if auto {
            self.0.armed_until.store(0, Ordering::SeqCst);
        }
    }

    /// Opens the gate for `window`. Returns the deadline, which identifies this
    /// arming to `expire` so a later arming is never cancelled by an earlier one.
    pub fn arm(&self, window: Duration) -> u64 {
        let until = now_ms() + window.as_millis() as u64;
        self.0.armed_until.store(until, Ordering::SeqCst);
        until
    }

    pub fn admit(&self) -> bool {
        self.admit_at(now_ms())
    }

    fn admit_at(&self, now: u64) -> bool {
        if self.0.auto.load(Ordering::SeqCst) {
            return true;
        }
        let until = self.0.armed_until.load(Ordering::SeqCst);
        if until == 0 || now > until {
            return false;
        }
        // compare_exchange so two racing changes cannot both spend one arming.
        self.0
            .armed_until
            .compare_exchange(until, 0, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    /// Clears the arming identified by `deadline`. True if it was never spent,
    /// meaning the shortcut copied nothing.
    pub fn expire(&self, deadline: u64) -> bool {
        self.0
            .armed_until
            .compare_exchange(deadline, 0, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }
}

/// Everything the commands need, registered once as Tauri managed state.
pub struct AppState {
    pub db: Db,
    pub settings: Mutex<Settings>,
    pub self_copy: SelfCopyGuard,
    pub password_clipboard: PasswordClipboard,
    pub capture_gate: CaptureGate,
    /// The shortcuts currently registered with the OS. Read by the shortcut
    /// handler to tell which one fired.
    pub shortcuts: Mutex<crate::shortcuts::Active>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_mode_admits_everything() {
        let gate = CaptureGate::new(true);
        assert!(gate.admit_at(1));
        assert!(gate.admit_at(2));
    }

    #[test]
    fn shortcut_mode_drops_unless_armed() {
        let gate = CaptureGate::new(false);
        assert!(!gate.admit_at(1));
    }

    #[test]
    fn one_arming_admits_exactly_one_change() {
        let gate = CaptureGate::new(false);
        let until = gate.arm(Duration::from_millis(1000));
        let now = until - 500;
        assert!(gate.admit_at(now));
        assert!(!gate.admit_at(now));
    }

    #[test]
    fn expired_arming_admits_nothing() {
        let gate = CaptureGate::new(false);
        let until = gate.arm(Duration::from_millis(1000));
        assert!(!gate.admit_at(until + 1));
    }

    #[test]
    fn expire_reports_whether_the_arming_was_spent() {
        let gate = CaptureGate::new(false);
        let first = gate.arm(Duration::from_millis(1000));
        assert!(gate.expire(first), "unspent arming reports as missed");

        let second = gate.arm(Duration::from_millis(1000));
        assert!(gate.admit_at(second - 10));
        assert!(!gate.expire(second), "spent arming is not a miss");
    }

    #[test]
    fn stale_expire_does_not_cancel_a_newer_arming() {
        let gate = CaptureGate::new(false);
        let old = gate.arm(Duration::from_millis(1000));
        std::thread::sleep(Duration::from_millis(5));
        let newer = gate.arm(Duration::from_millis(1000));
        assert_ne!(old, newer);
        assert!(!gate.expire(old));
        assert!(gate.admit_at(newer - 10));
    }

    #[test]
    fn switching_to_auto_clears_a_pending_arming() {
        let gate = CaptureGate::new(false);
        let until = gate.arm(Duration::from_millis(1000));
        gate.set_auto(true);
        gate.set_auto(false);
        assert!(!gate.admit_at(until - 10));
    }
}
