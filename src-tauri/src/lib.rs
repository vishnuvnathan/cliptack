mod archive;
mod backup;
mod capture;
mod clipboard;
mod commands;
mod db;
mod detect;
mod legacy;
mod paste;
mod query;
mod secret;
mod settings;
mod shortcuts;
mod startup;
mod state;
mod sticky;
mod transform;
mod tray;
mod window;

use state::{AppState, CaptureGate, PasswordClipboard, SelfCopyGuard};
use std::sync::Mutex;
use tauri::{Manager, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("CLIPTACK_LOG")
                .unwrap_or_else(|_| "cliptack_lib=info,warn".into()),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, received, event| {
                    // Fire on press only; the release event would toggle straight back.
                    // Which shortcut it was is decided from live state, because
                    // the user can rebind them while the app is running.
                    if event.state() == ShortcutState::Pressed {
                        shortcuts::on_pressed(app, received);
                    }
                })
                .build(),
        )
        .setup(move |app| {
            let handle = app.handle().clone();

            let config_dir = handle.path().app_config_dir()?;
            let data_dir = handle.path().app_data_dir()?;

            // Before anything opens the settings or the database. A failure stops
            // the launch: carrying on would create an empty database, which marks
            // the carry-over done and leaves the user's history behind for good.
            if tauri::async_runtime::block_on(legacy::carry_over(&data_dir, &config_dir))
                .map_err(|e| format!("could not carry data over from Stash: {e:#}"))?
            {
                tracing::info!("carried data over from Stash");
            }

            let loaded = settings::load(&config_dir);

            // `load` has already repaired anything unparsable, so this can only
            // fail if the built-in defaults are themselves broken.
            let active = shortcuts::resolve(&loaded)
                .map_err(|e| format!("invalid shortcut settings: {e}"))?;

            // The database must exist before the watcher or any command runs,
            // so this one step is intentionally blocking.
            let db = tauri::async_runtime::block_on(db::init(&data_dir))
                .map_err(|e| format!("database init failed: {e}"))?;

            let self_copy = SelfCopyGuard::default();
            let capture_gate = CaptureGate::new(loaded.capture_mode == settings::CaptureMode::Auto);

            app.manage(AppState {
                db: db.clone(),
                settings: Mutex::new(loaded.clone()),
                self_copy: self_copy.clone(),
                password_clipboard: PasswordClipboard::default(),
                capture_gate: capture_gate.clone(),
                shortcuts: Mutex::new(active),
            });

            // Secrets written before encryption landed are still plaintext in
            // the database. Re-seal them now rather than waiting for each to be
            // edited, which might be never.
            {
                let pool = db.pool.clone();
                tauri::async_runtime::spawn(async move {
                    match db::queries::upgrade_unsealed_secrets(&pool).await {
                        Ok((0, 0)) => {}
                        Ok((upgraded, failed)) => {
                            tracing::info!(upgraded, failed, "re-sealed plaintext secrets");
                        }
                        Err(e) => tracing::warn!(error = %e, "secret upgrade pass failed"),
                    }
                });
            }

            startup::reconcile(&handle, loaded.launch_on_startup);
            paste::warn_if_unsupported();

            tray::build(&handle, &loaded.toggle_shortcut)?;

            if let Some(win) = window::panel(&handle) {
                let status = capture::apply(&win, loaded.capture_exclusion);
                if !status.supported {
                    if let Some(reason) = &status.reason {
                        tracing::info!(reason, "capture exclusion unavailable");
                    }
                }
            }

            // A key another app already owns must not stop Cliptack from starting:
            // the tray menu still opens the panel, and Settings can pick a
            // different combination.
            let gs = app.global_shortcut();
            if let Err(e) = gs.register(active.toggle) {
                tracing::warn!(error = %e, "open-panel shortcut could not be registered");
            }
            if let Some(capture) = active.capture {
                if let Err(e) = gs.register(capture) {
                    tracing::warn!(error = %e, "capture shortcut could not be registered");
                }
            }
            if let Some(stickies) = active.stickies {
                if let Err(e) = gs.register(stickies) {
                    tracing::warn!(error = %e, "hide-stickies shortcut could not be registered");
                }
            }

            sticky::restore_all(handle.clone(), db.clone());
            clipboard::spawn(handle.clone(), db.clone(), self_copy, capture_gate);
            db::retention::spawn(db);

            // No Dock icon on macOS; skipTaskbar covers Windows and Linux.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            Ok(())
        })
        .on_window_event(|win, event| {
            // Every window lands here, and the rules below are the panel's.
            // Applied to a sticky they would hide the panel whenever the sticky
            // lost focus, and turn its close into "hide the panel".
            if win.label() != window::PANEL {
                sticky::on_window_event(win, event);
                return;
            }
            match event {
                // Closing must not quit: the tray Quit item is the only exit.
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    hide_panel_window(win);
                }
                // Clicking away dismisses the panel, which is also the Linux
                // mitigation for having no capture exclusion. A move or resize
                // drag blurs the webview too, and that one must not dismiss it.
                WindowEvent::Focused(false) => {
                    if !window::drag_in_progress() && !window::dialog_open() {
                        hide_panel_window(win);
                    }
                }
                // Focus comes back when the drag loop ends.
                WindowEvent::Focused(true) => window::disarm_drag_guard(),
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::search_items,
            commands::transforms_for,
            commands::get_item,
            commands::copy_item,
            commands::paste_item,
            commands::delete_item,
            commands::restore_item,
            commands::count_matching,
            commands::delete_matching,
            commands::clear_clip_history,
            commands::toggle_pin,
            commands::save_note,
            commands::list_source_apps,
            commands::get_settings,
            commands::set_settings,
            commands::set_capture_exclusion,
            commands::security_info,
            commands::hide_panel,
            commands::begin_window_drag,
            commands::open_sticky,
            commands::new_sticky_note,
            commands::sticky_assignment,
            commands::sticky_edit_as_note,
            commands::close_sticky,
            commands::save_sticky_geometry,
            commands::get_sticky_color,
            commands::set_sticky_color,
            commands::read_blob,
            commands::list_folders,
            commands::create_folder,
            commands::rename_folder,
            commands::delete_folder,
            commands::set_item_folder,
            commands::save_credential,
            commands::get_credential,
            commands::reveal_password,
            commands::copy_credential_field,
            commands::paste_credential_field,
            commands::export_data,
            commands::import_data,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Cliptack");
}

/// Routes every dismissal through `window::hide` so the panel's size and
/// position are saved on the way out. The event handler is given a `Window`,
/// not the `WebviewWindow` that carries those helpers, hence the lookup.
fn hide_panel_window(win: &tauri::Window) {
    match window::panel(win.app_handle()) {
        Some(panel) => window::hide(&panel),
        None => {
            let _ = win.hide();
        }
    }
}
