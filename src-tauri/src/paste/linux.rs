//! Linux: not implemented.
//!
//! On X11 this would be XTEST, which works; on Wayland there is no portable way
//! for a client to synthesise input into another client at all -- that is the
//! point of the security model. Shipping a paste that silently works on one
//! session type and not the other would be worse than not having it, so Enter
//! copies here, as it did in v0.1.

use super::PasteStatus;

const REASON: &str =
    "Pasting directly is not supported on Linux (Wayland forbids it); Enter copies instead.";

pub fn remember_foreground() {}

pub fn support() -> PasteStatus {
    PasteStatus::unsupported(REASON)
}

pub fn paste_into_previous() -> PasteStatus {
    PasteStatus::unsupported(REASON)
}

/// Same reasoning as pasting: no portable way to synthesise Ctrl+C into another
/// client. The capture shortcut still arms its window, so a manual copy inside
/// it is saved.
pub fn copy_selection() -> Result<(), String> {
    Err("Sending a copy keystroke is not supported on Linux; copy manually".to_string())
}
