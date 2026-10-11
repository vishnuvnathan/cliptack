//! macOS: not implemented, and deliberately so.
//!
//! The mechanism exists -- remember `NSWorkspace.frontmostApplication`, call
//! `activate`, then post a Cmd+V `CGEvent` -- but synthetic keystrokes go into
//! *other people's applications*, which is a different risk class from the
//! written-but-unrun pasteboard reader in `clipboard/mac.rs`. It also needs an
//! Accessibility grant that cannot be requested or verified from here, and a
//! silent no-op on a missing permission is exactly the kind of failure this
//! codebase tries not to ship.
//!
//! Enter falls back to copy-and-hide on macOS, which is what v0.1 did
//! everywhere.

use super::PasteStatus;

const REASON: &str = "Pasting directly is not implemented on macOS yet; Enter copies instead.";

pub fn remember_foreground() {}

pub fn support() -> PasteStatus {
    PasteStatus::unsupported(REASON)
}

pub fn paste_into_previous() -> PasteStatus {
    PasteStatus::unsupported(REASON)
}

/// Same reasoning as pasting: needs an Accessibility grant that cannot be
/// verified from here. The capture shortcut still arms its window, so a manual
/// copy inside it is saved.
pub fn copy_selection() -> Result<(), String> {
    Err("Sending a copy keystroke is not implemented on macOS; copy manually".to_string())
}
