//! Items pinned to the screen: one small, frameless, always-on-top window per
//! item, so a snippet, a colour or a screenshot can sit beside the work it is
//! for while the panel stays out of the way.
//!
//! Each sticky is a full webview, which is why there is a cap. The window label
//! carries the item id (`sticky-<uuid>`), so the window list *is* the record of
//! what is open -- there is no second registry to fall out of step with it.
//! The `stickies` table only remembers geometry and colour across restarts.

use crate::capture;
use crate::db::model::StickyGeometry;
use crate::db::{queries, Db};
use crate::state::AppState;
use crate::window;
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

pub const PREFIX: &str = "sticky-";

/// Each sticky is its own webview, and the whole app idles at ~31 MB. Eight is
/// enough to keep a working set in view without the reference cards costing
/// more than the app they came from.
pub const MAX_STICKIES: usize = 8;

/// Paper colours a sticky can take. Matches `STICKY_PAPERS` in theme.ts, which
/// holds the actual colours; Rust only keeps junk out of the table.
pub const COLORS: &[&str] = &["default", "yellow", "pink", "green", "blue", "purple", "orange"];

/// Logical pixels; scaled to the target monitor on open.
const DEFAULT_SIZE: (f64, f64) = (300.0, 220.0);
const MIN_SIZE: (f64, f64) = (180.0, 110.0);
/// How far from the cursor a new sticky opens, so it does not land under it.
const CURSOR_OFFSET: f64 = 24.0;

/// Below this the window is not one the user sized, it is a minimise artefact
/// (Windows parks a minimised window at -32000 with a token size).
const MIN_SANE_SIZE: u32 = 60;

pub fn label_for(item_id: &str) -> String {
    format!("{PREFIX}{item_id}")
}

pub fn item_id_from(label: &str) -> Option<&str> {
    label.strip_prefix(PREFIX).filter(|id| !id.is_empty())
}

/// Ids of every sticky currently on screen.
fn open_ids(app: &AppHandle) -> Vec<String> {
    app.webview_windows()
        .keys()
        .filter_map(|label| item_id_from(label).map(str::to_string))
        .collect()
}

/// Opens a sticky for an item the caller has already vetted (live, not a
/// credential) and returns where it ended up.
///
/// An item that already has one gets that one back, unchanged -- a second
/// `Ctrl+O` is not a request for a second window.
///
/// The window is built hidden and unfocused, placed in physical pixels, and
/// only then shown. Unfocused matters twice: the panel keeps the keyboard, so
/// several items can be popped out in a row, and the panel's hide-on-blur does
/// not fire just because a sticky appeared. tao shows a window created with
/// `focused(false)` via `SW_SHOWNOACTIVATE`.
pub fn open_window(
    app: &AppHandle,
    item_id: &str,
    title: &str,
    saved: Option<StickyGeometry>,
) -> Result<StickyGeometry, String> {
    let label = label_for(item_id);
    if let Some(win) = app.get_webview_window(&label) {
        return current_geometry(&win).ok_or_else(|| "sticky is minimised".to_string());
    }
    if open_ids(app).len() >= MAX_STICKIES {
        return Err(format!(
            "At most {MAX_STICKIES} stickies can be open at once; close one first"
        ));
    }

    let url = WebviewUrl::App(format!("index.html?sticky={item_id}").into());
    let win = WebviewWindowBuilder::new(app, &label, url)
        .title(title)
        .inner_size(DEFAULT_SIZE.0, DEFAULT_SIZE.1)
        .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
        .decorations(false)
        .resizable(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(true)
        .focused(false)
        .visible(false)
        .build()
        .map_err(|e| format!("could not open sticky: {e}"))?;

    let geo = placement(app, saved);
    let _ = win.set_size(PhysicalSize::new(geo.width, geo.height));
    let _ = win.set_position(PhysicalPosition::new(geo.x, geo.y));

    // Before the first show, so there is no frame in which a screen share can
    // see the content.
    capture::apply(&win, capture_exclusion(app));
    let _ = win.show();
    Ok(geo)
}

/// Removes the window. The row in `stickies` is the caller's to delete -- that
/// needs the database, and this is called from places that do not.
pub fn close_window(app: &AppHandle, item_id: &str) {
    if let Some(win) = app.get_webview_window(&label_for(item_id)) {
        // `destroy` rather than `close`: `close` raises CloseRequested, which
        // would come back round to delete the row a second time.
        let _ = win.destroy();
    }
}

/// Where the window is now, or `None` while it is minimised.
///
/// Position is the outer corner and size is the *inner* size, because those
/// are what `set_position` and `set_size` take back. An undecorated resizable
/// window still carries an invisible resize frame (18x10 physical pixels at
/// 125%), so saving `outer_size` grew the card by that much on every restart.
pub fn current_geometry(win: &WebviewWindow) -> Option<StickyGeometry> {
    let pos = win.outer_position().ok()?;
    let size = win.inner_size().ok()?;
    if size.width < MIN_SANE_SIZE || size.height < MIN_SANE_SIZE || pos.x <= -30000 {
        return None;
    }
    Some(StickyGeometry { x: pos.x, y: pos.y, width: size.width, height: size.height })
}

/// Follows the panel's capture-exclusion setting, whatever it is at the time.
pub fn apply_capture_all(app: &AppHandle, enabled: bool) {
    for (label, win) in app.webview_windows() {
        if item_id_from(&label).is_some() {
            capture::apply(&win, enabled);
        }
    }
}

/// The only window events a sticky reacts to. The panel's hide-on-blur and
/// close-means-hide rules are deliberately absent: a sticky losing focus is
/// the normal state of a sticky, and closing one really closes it.
pub fn on_window_event(win: &tauri::Window, event: &WindowEvent) {
    let WindowEvent::CloseRequested { .. } = event else { return };
    let Some(id) = item_id_from(win.label()).map(str::to_string) else { return };
    let Some(state) = win.app_handle().try_state::<AppState>() else { return };
    let pool = state.db.pool.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = queries::delete_sticky(&pool, &id).await {
            tracing::warn!(error = %e, "could not forget closed sticky");
        }
    });
}

/// Closes every sticky whose item is no longer live. For the bulk deletes,
/// which resolve their set in SQL and never see the ids one by one here.
pub async fn close_orphans(app: &AppHandle, db: &Db) {
    for id in open_ids(app) {
        if matches!(queries::get(&db.pool, &id).await, Ok(None)) {
            close_window(app, &id);
            if let Err(e) = queries::delete_sticky(&db.pool, &id).await {
                tracing::warn!(error = %e, "could not forget orphaned sticky");
            }
        }
    }
}

/// Reopens the stickies that were up when the app last ran.
pub fn restore_all(app: AppHandle, db: Db) {
    tauri::async_runtime::spawn(async move {
        let saved = match queries::list_stickies(&db.pool).await {
            Ok(rows) => rows,
            Err(e) => {
                tracing::warn!(error = %e, "could not list stickies to restore");
                return;
            }
        };
        for (id, geo) in saved {
            let item = match queries::get(&db.pool, &id).await {
                Ok(Some(item)) if !item.is_credential() => item,
                _ => {
                    let _ = queries::delete_sticky(&db.pool, &id).await;
                    continue;
                }
            };
            let title = item.title.as_deref().unwrap_or("Stash");
            if let Err(e) = open_window(&app, &id, title, Some(geo)) {
                tracing::warn!(error = %e, "could not restore sticky");
            }
        }
    });
}

/// The saved spot when it is still on a connected monitor; otherwise beside
/// the cursor, on whichever monitor holds it. The saved size is kept either
/// way -- it is the position an unplugged display invalidates, not the size.
fn placement(app: &AppHandle, saved: Option<StickyGeometry>) -> StickyGeometry {
    if let Some(geo) = saved.filter(|g| window::point_on_some_monitor(app, g.x, g.y)) {
        return geo;
    }

    let cursor = app.cursor_position().unwrap_or_default();
    let monitor = app
        .monitor_from_point(cursor.x, cursor.y)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        let (w, h) = saved.map_or((DEFAULT_SIZE.0 as u32, DEFAULT_SIZE.1 as u32), |g| (g.width, g.height));
        return StickyGeometry { x: cursor.x as i32, y: cursor.y as i32, width: w, height: h };
    };

    let scale = monitor.scale_factor();
    let (width, height) = saved.map_or(
        ((DEFAULT_SIZE.0 * scale) as u32, (DEFAULT_SIZE.1 * scale) as u32),
        |g| (g.width, g.height),
    );
    let origin = monitor.position();
    let area = monitor.size();
    let offset = (CURSOR_OFFSET * scale) as i32;

    // Clamped so the whole card lands on the cursor's monitor rather than
    // hanging off its right or bottom edge.
    let bounds = Bounds {
        min_x: origin.x,
        min_y: origin.y,
        max_x: origin.x + area.width as i32 - width as i32,
        max_y: origin.y + area.height as i32 - height as i32,
    };
    let base = (
        (cursor.x as i32 + offset).clamp(bounds.min_x, bounds.max_x.max(bounds.min_x)),
        (cursor.y as i32 + offset).clamp(bounds.min_y, bounds.max_y.max(bounds.min_y)),
    );
    let (x, y) = cascade(base, &other_sticky_positions(app), offset, bounds);
    StickyGeometry { x, y, width, height }
}

#[derive(Debug, Clone, Copy)]
struct Bounds {
    min_x: i32,
    min_y: i32,
    max_x: i32,
    max_y: i32,
}

/// Top-left corners of the stickies already on screen. The window being
/// placed is not among them: it is still at the OS default spot, hidden.
fn other_sticky_positions(app: &AppHandle) -> Vec<(i32, i32)> {
    app.webview_windows()
        .into_iter()
        .filter(|(label, win)| item_id_from(label).is_some() && win.is_visible().unwrap_or(false))
        .filter_map(|(_, win)| win.outer_position().ok().map(|p| (p.x, p.y)))
        .collect()
}

/// Steps a new card diagonally off any card already sitting on its spot.
///
/// Without this, popping out several items in a row with the mouse still --
/// the keyboard flow `Ctrl+O` exists for -- stacks every card exactly on the
/// last, so the screen shows one sticky where there are five. The step runs
/// down-right, or up-left when there is no room for a full run that way.
fn cascade(base: (i32, i32), taken: &[(i32, i32)], step: i32, b: Bounds) -> (i32, i32) {
    let run = step * MAX_STICKIES as i32;
    let dx = if base.0 + run <= b.max_x { step } else { -step };
    let dy = if base.1 + run <= b.max_y { step } else { -step };
    let near = |(x, y): (i32, i32)| {
        taken.iter().any(|&(tx, ty)| (tx - x).abs() < step / 2 && (ty - y).abs() < step / 2)
    };

    let mut at = base;
    for _ in 0..MAX_STICKIES {
        if !near(at) {
            break;
        }
        at = (
            (at.0 + dx).clamp(b.min_x, b.max_x.max(b.min_x)),
            (at.1 + dy).clamp(b.min_y, b.max_y.max(b.min_y)),
        );
    }
    at
}

fn capture_exclusion(app: &AppHandle) -> bool {
    app.try_state::<AppState>()
        .and_then(|s| s.settings.lock().ok().map(|g| g.capture_exclusion))
        // Fail closed: if the setting cannot be read, keep the content out of
        // recordings rather than in them.
        .unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_round_trips_the_item_id() {
        let id = "3f2b8c1e-9d4a-4e2b-8f1a-0c9d8e7f6a5b";
        assert_eq!(item_id_from(&label_for(id)), Some(id));
    }

    const SCREEN: Bounds = Bounds { min_x: 0, min_y: 0, max_x: 1600, max_y: 900 };

    #[test]
    fn a_free_spot_is_used_as_is() {
        assert_eq!(cascade((100, 100), &[(500, 500)], 30, SCREEN), (100, 100));
    }

    #[test]
    fn cards_popped_out_in_a_row_step_off_each_other() {
        let taken = [(100, 100), (130, 130)];
        assert_eq!(cascade((100, 100), &taken, 30, SCREEN), (160, 160));
    }

    #[test]
    fn near_the_bottom_right_the_cascade_runs_up_and_left() {
        let taken = [(1600, 900)];
        assert_eq!(cascade((1600, 900), &taken, 30, SCREEN), (1570, 870));
    }

    #[test]
    fn the_panel_and_bare_prefix_are_not_stickies() {
        assert_eq!(item_id_from("panel"), None);
        assert_eq!(item_id_from(PREFIX), None);
    }
}
