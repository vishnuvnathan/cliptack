use crate::shortcuts;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Colour scheme. `System` follows the OS preference live.
///
/// Defaults to `Dark`, not `System`: the app shipped dark-only, so an
/// existing user upgrading should see no change until they ask for one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    Dark,
    Light,
    System,
}

/// How clipboard changes become history entries.
///
/// `Auto` records every copy, which is what Stash has always done. `Shortcut`
/// records only what the user explicitly sends with the capture shortcut, for
/// people who copy a lot of things they never want kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptureMode {
    #[default]
    Auto,
    Shortcut,
}

pub const DEFAULT_ACCENT: &str = "#7aa2f7";

/// `#rrggbb` and nothing else. The value is spliced into a CSS variable on the
/// frontend, so anything looser than a strict hex triplet is an injection
/// surface for a settings.json someone edited by hand.
pub fn is_valid_accent(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit())
}

/// `default` at the container level matters: a settings.json written by an
/// older build has none of the window fields, and without it serde would reject
/// the whole file and silently drop the user's other preferences.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Screen-capture exclusion. On by default: a clipboard panel showing your
    /// last thousand copies is exactly what you do not want in a screen share.
    pub capture_exclusion: bool,
    pub launch_on_startup: bool,
    pub poll_interval_ms: u64,

    /// Enter pastes into the window you came from instead of only copying.
    ///
    /// On by default: copying without pasting is half an action, and the paste
    /// path falls back to a plain copy whenever it cannot restore focus, so the
    /// worst case is the old behaviour. Off gives you that old behaviour
    /// deliberately -- and on macOS and Linux, where synthesising the keystroke
    /// is not implemented, it is what happens regardless.
    pub auto_paste: bool,

    /// Reopen the panel where it was last dragged instead of centering it on
    /// the monitor under the cursor.
    ///
    /// On by default: moving a window and having it snap back is indistinguishable
    /// from the move not working. The cost is that the panel stops following the
    /// cursor across monitors, which is what the original centering bought -- so
    /// this is a toggle rather than a removal.
    pub remember_position: bool,

    /// Last known geometry. Size is restored whether or not `remember_position`
    /// is set; a window that forgets it was resized is just broken.
    pub window_width: Option<u32>,
    pub window_height: Option<u32>,
    pub window_x: Option<i32>,
    pub window_y: Option<i32>,

    pub theme: Theme,
    /// Highlight colour, `#rrggbb`.
    pub accent: String,

    /// Global shortcut that shows or hides the panel. Stored in the same
    /// `Ctrl+Alt+KeyC` form the plugin parses.
    pub toggle_shortcut: String,
    pub capture_mode: CaptureMode,
    /// Global shortcut that copies the current selection and saves it. Only
    /// registered while `capture_mode` is `Shortcut`.
    pub capture_shortcut: String,
    /// Global shortcut that hides or shows every sticky. Empty means none:
    /// it is off until the user picks a key, because any default would take
    /// that key away from every other app for people who never use stickies.
    pub stickies_shortcut: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            capture_exclusion: true,
            launch_on_startup: false,
            poll_interval_ms: 400,
            auto_paste: true,
            remember_position: true,
            window_width: None,
            window_height: None,
            window_x: None,
            window_y: None,
            theme: Theme::Dark,
            accent: DEFAULT_ACCENT.to_string(),
            toggle_shortcut: shortcuts::DEFAULT_TOGGLE.to_string(),
            capture_mode: CaptureMode::Auto,
            capture_shortcut: shortcuts::DEFAULT_CAPTURE.to_string(),
            stickies_shortcut: String::new(),
        }
    }
}

impl Settings {
    /// Repairs values that are syntactically valid JSON but not usable, so a
    /// hand-edited or newer-build settings.json never reaches the UI broken.
    pub fn sanitize(&mut self) {
        if !is_valid_accent(&self.accent) {
            tracing::warn!(accent = %self.accent, "invalid accent colour; using default");
            self.accent = DEFAULT_ACCENT.to_string();
        }
        if let Err(e) = shortcuts::parse(&self.toggle_shortcut) {
            tracing::warn!(error = %e, "invalid open-panel shortcut; using default");
            self.toggle_shortcut = shortcuts::DEFAULT_TOGGLE.to_string();
        }
        if let Err(e) = shortcuts::parse(&self.capture_shortcut) {
            tracing::warn!(error = %e, "invalid capture shortcut; using default");
            self.capture_shortcut = shortcuts::DEFAULT_CAPTURE.to_string();
        }
        if !self.stickies_shortcut.is_empty() && shortcuts::parse(&self.stickies_shortcut).is_err() {
            tracing::warn!(shortcut = %self.stickies_shortcut, "invalid stickies shortcut; turning it off");
            self.stickies_shortcut.clear();
        }
        // Two actions on one key cannot both work. Put the capture key back
        // first; only if that still collides is the open-panel key touched.
        if shortcuts::same(&self.toggle_shortcut, &self.capture_shortcut) {
            self.capture_shortcut = shortcuts::DEFAULT_CAPTURE.to_string();
            if shortcuts::same(&self.toggle_shortcut, &self.capture_shortcut) {
                self.toggle_shortcut = shortcuts::DEFAULT_TOGGLE.to_string();
            }
        }
        // The optional one gives way to both of the others.
        if shortcuts::same(&self.stickies_shortcut, &self.toggle_shortcut)
            || shortcuts::same(&self.stickies_shortcut, &self.capture_shortcut)
        {
            self.stickies_shortcut.clear();
        }
    }
}

fn path(config_dir: &Path) -> PathBuf {
    config_dir.join("settings.json")
}

/// Missing or corrupt settings fall back to defaults rather than failing
/// startup -- the app must always come up.
pub fn load(config_dir: &Path) -> Settings {
    let p = path(config_dir);
    match std::fs::read_to_string(&p) {
        Ok(raw) => {
            let mut loaded: Settings = serde_json::from_str(&raw).unwrap_or_else(|e| {
                tracing::warn!(error = %e, "settings.json unreadable; using defaults");
                Settings::default()
            });
            loaded.sanitize();
            loaded
        }
        Err(_) => Settings::default(),
    }
}

pub fn save(config_dir: &Path, settings: &Settings) -> Result<()> {
    std::fs::create_dir_all(config_dir)?;
    let raw = serde_json::to_string_pretty(settings)?;
    std::fs::write(path(config_dir), raw)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_settings_file_without_new_fields_still_loads() {
        // A settings.json from before theming: no theme, no accent.
        let raw = r#"{"captureExclusion":false,"autoPaste":false,"windowWidth":900}"#;
        let mut s: Settings = serde_json::from_str(raw).unwrap();
        s.sanitize();
        assert!(!s.capture_exclusion);
        assert!(!s.auto_paste);
        assert_eq!(s.window_width, Some(900));
        assert_eq!(s.theme, Theme::Dark);
        assert_eq!(s.accent, DEFAULT_ACCENT);
    }

    #[test]
    fn theme_round_trips_lowercase() {
        let s = Settings { theme: Theme::System, ..Settings::default() };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains(r#""theme":"system""#));
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.theme, Theme::System);
    }

    #[test]
    fn shortcut_defaults_fill_in_and_bad_values_are_repaired() {
        let raw = r#"{"toggleShortcut":"Ctrl+Nonsense","captureShortcut":"Alt"}"#;
        let mut s: Settings = serde_json::from_str(raw).unwrap();
        s.sanitize();
        assert_eq!(s.toggle_shortcut, shortcuts::DEFAULT_TOGGLE);
        assert_eq!(s.capture_shortcut, shortcuts::DEFAULT_CAPTURE);
        assert_eq!(s.capture_mode, CaptureMode::Auto);
    }

    #[test]
    fn colliding_shortcuts_are_separated() {
        let mut s = Settings {
            toggle_shortcut: "Ctrl+Alt+KeyC".into(),
            capture_shortcut: "Ctrl+Alt+KeyC".into(),
            ..Settings::default()
        };
        s.sanitize();
        assert!(!shortcuts::same(&s.toggle_shortcut, &s.capture_shortcut));
    }

    #[test]
    fn stickies_shortcut_is_off_by_default_and_repaired_to_off() {
        assert!(Settings::default().stickies_shortcut.is_empty());

        let raw = r#"{"stickiesShortcut":"Ctrl+Nonsense"}"#;
        let mut s: Settings = serde_json::from_str(raw).unwrap();
        s.sanitize();
        assert!(s.stickies_shortcut.is_empty());

        let mut s = Settings { stickies_shortcut: shortcuts::DEFAULT_TOGGLE.into(), ..Settings::default() };
        s.sanitize();
        assert!(s.stickies_shortcut.is_empty(), "collided with the open-panel key");
        assert_eq!(s.toggle_shortcut, shortcuts::DEFAULT_TOGGLE);
    }

    #[test]
    fn accent_validation_is_strict() {
        assert!(is_valid_accent("#7aa2f7"));
        assert!(is_valid_accent("#ABCDEF"));
        assert!(!is_valid_accent("7aa2f7"));
        assert!(!is_valid_accent("#7aa2f"));
        assert!(!is_valid_accent("#7aa2fg"));
        assert!(!is_valid_accent("#7aa2f7; background:url(x)"));
        assert!(!is_valid_accent(""));
    }

    #[test]
    fn sanitize_replaces_bad_accent() {
        let mut s = Settings { accent: "red".into(), ..Settings::default() };
        s.sanitize();
        assert_eq!(s.accent, DEFAULT_ACCENT);
    }
}
