use crate::window;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

/// Kept as managed state so the shortcut label can be updated when the user
/// rebinds the key.
struct ShowItem(MenuItem<tauri::Wry>);

/// Updates the "Show Stash" label to the new shortcut. The label is cosmetic --
/// the real binding is the global shortcut -- so a string the menu cannot
/// display is logged and the old label stays rather than failing the change.
pub fn set_toggle_label(app: &AppHandle, shortcut: &str) {
    let Some(item) = app.try_state::<ShowItem>() else {
        return;
    };
    if let Err(e) = item.0.set_accelerator(Some(shortcut)) {
        tracing::debug!(error = %e, shortcut, "tray label not updated");
    }
}

/// Builds the tray icon and its menu. Quit is the only path that ends the
/// process -- closing the window merely hides it.
pub fn build(app: &AppHandle, toggle_shortcut: &str) -> tauri::Result<()> {
    // An accelerator the menu cannot parse must not cost the user their tray,
    // which is the only way to quit.
    let show = MenuItem::with_id(app, "show", "Show Stash", true, Some(toggle_shortcut))
        .or_else(|_| MenuItem::with_id(app, "show", "Show Stash", true, None::<&str>))?;
    app.manage(ShowItem(show.clone()));
    let settings = MenuItem::with_id(app, "settings", "Settings\u{2026}", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Stash", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&show, &settings, &sep, &quit])?;

    let mut builder = TrayIconBuilder::with_id("stash-tray")
        .tooltip("Stash")
        .menu(&menu)
        .show_menu_on_left_click(false);

    // Falling back to no icon is better than failing startup: the menu still
    // works, which is the only way to quit.
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(win) = window::panel(app) {
                    window::show(&win);
                }
            }
            "settings" => {
                if let Some(win) = window::panel(app) {
                    window::show(&win);
                    let _ = win.emit("open-settings", ());
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Left click toggles, matching the shortcut. Right click is left to
            // the platform so the menu still opens.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                window::toggle(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}
