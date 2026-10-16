//! Items pinned to the screen: one small, frameless, always-on-top window per
//! item, so a snippet, a colour or a screenshot can sit beside the work it is
//! for while the panel stays out of the way.
//!
//! Each sticky is a full webview, which is why there is a cap -- and why there
//! are spares. Creating a WebView2 blocks the main thread for ~300-600 ms, and
//! every IPC reply the panel is waiting on queues behind it, so a pop-out
//! built on demand freezes the panel for that long. Instead `SPARES` hidden
//! windows with the frontend already loaded are kept ready -- built at launch
//! and whenever the panel is hidden, never while it is up -- and `Ctrl+O` only
//! has to hand one an item and show it (~15 ms).
//!
//! Every window shares one renderer process (`BROWSER_ARGS`), so a spare costs
//! ~14 MB rather than a renderer of its own.
//!
//! Because a window is created before anyone knows which item it will hold,
//! its label (`sticky-w<n>`) cannot carry the item id. The registry below is
//! the one map from item to window. The `stickies` table only remembers
//! geometry and colour across restarts.
//!
//! **Never call a window method while holding the registry lock.** Window
//! calls made off the main thread wait for it, and the main thread takes the
//! lock in `on_window_event`; holding both is a deadlock.

use crate::capture;
use crate::db::model::{Item, StickyGeometry};
use crate::db::{queries, Db};
use crate::state::AppState;
use crate::tray;
use crate::window;
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

pub const PREFIX: &str = "sticky-";

/// Sent to one sticky window to tell it which item it now shows: a spare
/// being handed its first item, or a card switching to the note made from its
/// clip. Carries the label too, because a plain `listen` hears every target.
const ASSIGN_EVENT: &str = "sticky-assign";

/// Each sticky is its own webview, and the whole app idles at ~31 MB. Eight is
/// enough to keep a working set in view without the reference cards costing
/// more than the app they came from. Spares do not count towards it.
pub const MAX_STICKIES: usize = 8;

/// Hidden windows kept ready. Two covers popping out a couple of items in one
/// visit to the panel; a third press in the same visit builds on demand.
const SPARES: usize = 2;

/// WebView2 flags for every window in the app -- the panel too, through
/// `additionalBrowserArgs` in tauri.conf.json, which must match exactly: all
/// webviews share one WebView2 environment, and one created with different
/// flags fails. The first part is what wry passes by default (setting any flags
/// replaces it). `--process-per-site` puts every window in one renderer
/// process: all the pages are the same origin, and a renderer per card cost
/// ~20 MB each for no isolation worth having. The trade is that a renderer
/// crash takes the panel and the cards down together.
pub const BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --process-per-site";

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

/// How long after the panel hides before a spare is built. The panel's own
/// hide, and the paste that often follows it, go first.
const SPARE_DELAY: Duration = Duration::from_millis(600);

/// How long after launch before the first spares are built, so the reopened
/// stickies and the first press of the shortcut go first.
const WARM_UP_DELAY: Duration = Duration::from_secs(3);

/// Between windows reopened at launch, so the shortcut and the panel get the
/// main thread in between instead of after all of them.
const RESTORE_GAP: Duration = Duration::from_millis(150);

#[derive(Debug, Clone)]
struct Card {
    label: String,
    geo: StickyGeometry,
}

#[derive(Debug, Default)]
struct Registry {
    /// Item id -> its card. The entry is made *before* the window exists, so a
    /// second `Ctrl+O` for an item still being built finds it, and so does the
    /// cascade working out where the next card goes.
    cards: HashMap<String, Card>,
    /// Hidden windows with the frontend loaded and no item yet.
    spares: Vec<String>,
    spare_building: bool,
    /// Hide-all is in effect.
    hidden: bool,
    next_label: u64,
}

/// What `reserve` decided.
#[derive(Debug, PartialEq)]
enum Reservation {
    /// The item already has a card; nothing to build.
    Existing,
    New { label: String, geo: StickyGeometry, from_spare: bool },
}

impl Registry {
    fn new_label(&mut self) -> String {
        self.next_label += 1;
        format!("{PREFIX}w{}", self.next_label)
    }

    /// Claims a card for `id` in one step under the lock: the duplicate check,
    /// the cap, the position (against every card, including ones still being
    /// built) and the window it will live in.
    fn reserve(
        &mut self,
        id: &str,
        place: impl FnOnce(&[(i32, i32)]) -> StickyGeometry,
    ) -> Result<Reservation, String> {
        if self.cards.contains_key(id) {
            return Ok(Reservation::Existing);
        }
        if self.cards.len() >= MAX_STICKIES {
            return Err(format!(
                "At most {MAX_STICKIES} stickies can be open at once; close one first"
            ));
        }
        let taken: Vec<(i32, i32)> = self.cards.values().map(|c| (c.geo.x, c.geo.y)).collect();
        let geo = place(&taken);
        let (label, from_spare) = match self.spares.pop() {
            Some(label) => (label, true),
            None => (self.new_label(), false),
        };
        self.cards.insert(id.to_string(), Card { label: label.clone(), geo });
        Ok(Reservation::New { label, geo, from_spare })
    }

    fn label_of(&self, id: &str) -> Option<String> {
        self.cards.get(id).map(|c| c.label.clone())
    }

    /// Forgets whatever `label` was: a card (returning its item id) or a spare.
    fn release_label(&mut self, label: &str) -> Option<String> {
        self.spares.retain(|s| s != label);
        let id = self.cards.iter().find(|(_, c)| c.label == label).map(|(id, _)| id.clone())?;
        self.cards.remove(&id);
        Some(id)
    }

    /// Moves a card to another item, keeping its window and position.
    fn rekey(&mut self, from: &str, to: &str) -> Option<String> {
        let card = self.cards.remove(from)?;
        let label = card.label.clone();
        self.cards.insert(to.to_string(), card);
        Some(label)
    }
}

static REG: Lazy<Mutex<Registry>> = Lazy::new(Mutex::default);

/// A poisoned lock still holds a usable map; a panic elsewhere must not leave
/// every sticky unclosable.
fn reg() -> MutexGuard<'static, Registry> {
    REG.lock().unwrap_or_else(|p| p.into_inner())
}

/// Ids of every sticky on screen, or being put there.
fn open_ids() -> Vec<String> {
    reg().cards.keys().cloned().collect()
}

/// The window showing `item_id`, if it has one yet.
pub fn window_for(app: &AppHandle, item_id: &str) -> Option<WebviewWindow> {
    let label = reg().label_of(item_id)?;
    app.get_webview_window(&label)
}

/// Whether a sticky window is currently up.
pub fn is_open(item_id: &str) -> bool {
    reg().cards.contains_key(item_id)
}

#[derive(Debug, PartialEq)]
pub enum Opened {
    /// The item already had a card; it was left where it is.
    Existing,
    New(StickyGeometry),
}

/// Opens a sticky for an item the caller has already vetted (live, not a
/// credential).
///
/// An item that already has one keeps it -- a second `Ctrl+O` is not a request
/// for a second window. With `focus` false the new card is shown without
/// activating it, so the panel keeps the keyboard and several items can be
/// popped out in a row; `focus` is for a blank note the user is about to type
/// into.
pub fn open_window(
    app: &AppHandle,
    item_id: &str,
    title: &str,
    saved: Option<StickyGeometry>,
    focus: bool,
) -> Result<Opened, String> {
    // Popping something out while the cards are hidden would leave it hidden
    // too, which looks like Ctrl+O did nothing.
    set_hidden(app, false);

    // The monitor and cursor queries go to the main thread, so they are made
    // before the lock is taken.
    let started = std::time::Instant::now();
    let spot = survey(app, saved);
    let reservation = reg().reserve(item_id, |taken| place(&spot, saved, taken))?;
    let Reservation::New { label, geo, from_spare } = reservation else {
        return Ok(Opened::Existing);
    };

    let shown = if from_spare {
        attach(app, &label, item_id, title, geo)
    } else {
        build(app, &label, Some(item_id), title).map(|win| present(app, &win, geo))
    };
    if let Err(e) = shown {
        reg().cards.remove(item_id);
        return Err(e);
    }

    // Closed while it was being built (its item deleted, say): the card is
    // already forgotten, so the window must not stay up showing it.
    if reg().label_of(item_id).as_deref() != Some(&label) {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.destroy();
        }
        return Ok(Opened::Existing);
    }

    if focus {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.set_focus();
        }
    }
    // ~15 ms from a spare, ~300-600 ms built on demand: the number to check
    // when a pop-out feels slow (CLIPTACK_LOG=cliptack_lib=debug).
    tracing::debug!(from_spare, ms = started.elapsed().as_millis() as u64, "sticky opened");
    Ok(Opened::New(geo))
}

/// Builds a sticky window, hidden and unfocused. `item_id` is `None` for the
/// spare, which loads the frontend and waits to be told its item.
///
/// tao shows a window created with `focused(false)` via `SW_SHOWNOACTIVATE`
/// the first time it is shown, which is what keeps the panel's hide-on-blur
/// from firing when a card appears -- spare or not.
fn build(app: &AppHandle, label: &str, item_id: Option<&str>, title: &str) -> Result<WebviewWindow, String> {
    let query = item_id.map_or_else(|| "sticky".to_string(), |id| format!("sticky={id}"));
    let url = WebviewUrl::App(format!("index.html?{query}").into());
    WebviewWindowBuilder::new(app, label, url)
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
        .additional_browser_args(BROWSER_ARGS)
        .build()
        .map_err(|e| format!("could not open sticky: {e}"))
}

/// Places a hidden sticky and shows it. Capture exclusion goes on before the
/// first show, so no frame of the content reaches a screen share.
fn present(app: &AppHandle, win: &WebviewWindow, geo: StickyGeometry) {
    let _ = win.set_size(PhysicalSize::new(geo.width, geo.height));
    let _ = win.set_position(PhysicalPosition::new(geo.x, geo.y));
    capture::apply(win, capture_exclusion(app));
    let _ = win.show();
    raise(win);
}

/// Puts a card at the top of the always-on-top band without activating it.
///
/// `show` keeps a window where it already sits in the z-order. A spare was
/// built -- and a card hidden by hide-all was last placed -- before the panel
/// was shown on top of it, so without this the card came up *behind* the
/// panel. Async, so it never waits on a main thread that is busy building a
/// webview.
#[cfg(windows)]
fn raise(win: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOPMOST, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    };
    let Ok(h) = win.hwnd() else { return };
    let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS;
    let hwnd = HWND(h.0 as *mut std::ffi::c_void);
    if let Err(e) = unsafe { SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, flags) } {
        tracing::debug!(error = %e, "could not raise sticky");
    }
}

#[cfg(not(windows))]
fn raise(_win: &WebviewWindow) {}

/// Hands the spare its item. If the spare has gone (it should not have), the
/// card is built the slow way under the label it was promised.
fn attach(app: &AppHandle, label: &str, item_id: &str, title: &str, geo: StickyGeometry) -> Result<(), String> {
    let win = match app.get_webview_window(label) {
        Some(win) => win,
        None => build(app, label, Some(item_id), title)?,
    };
    let _ = win.set_title(title);
    assign(app, label, item_id);
    present(app, &win, geo);
    Ok(())
}

#[derive(Clone, serde::Serialize)]
struct Assign<'a> {
    label: &'a str,
    id: &'a str,
}

fn assign(app: &AppHandle, label: &str, item_id: &str) {
    if let Err(e) = app.emit_to(label, ASSIGN_EVENT, Assign { label, id: item_id }) {
        tracing::warn!(error = %e, "could not hand sticky its item");
    }
}

/// The item a sticky window should show. Asked by the frontend on load, for
/// the case where the assignment was sent before it was listening.
pub fn assignment(label: &str) -> Option<String> {
    let r = reg();
    r.cards.iter().find(|(_, c)| c.label == label).map(|(id, _)| id.clone())
}

/// Builds the first spares shortly after launch, so even the first `Ctrl+O`
/// of a session is instant.
pub fn warm_up(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(WARM_UP_DELAY).await;
        ensure_spare(&app);
    });
}

/// Tops the pool up to `SPARES`, one window at a time. Called when the panel
/// hides and at launch: building a webview stalls the main thread, and with
/// the panel down there is nobody waiting on it. If the panel comes back up
/// mid-way, the rest wait for its next hide.
pub fn ensure_spare(app: &AppHandle) {
    {
        let mut r = reg();
        if r.spare_building || !wants_spare(&r) {
            return;
        }
        r.spare_building = true;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(SPARE_DELAY).await;
            let panel_up = window::panel(&app).and_then(|w| w.is_visible().ok()).unwrap_or(false);
            if panel_up || !wants_spare(&reg()) {
                break;
            }
            let label = reg().new_label();
            match build(&app, &label, None, "Cliptack") {
                Ok(win) => {
                    capture::apply(&win, capture_exclusion(&app));
                    reg().spares.push(label);
                }
                Err(e) => {
                    tracing::warn!(error = %e, "could not build spare sticky");
                    break;
                }
            }
        }
        reg().spare_building = false;
    });
}

/// Short of spares, and with room for the cards they would become.
fn wants_spare(r: &Registry) -> bool {
    r.spares.len() < SPARES && r.cards.len() + r.spares.len() < MAX_STICKIES + SPARES
}

/// Removes the window. The row in `stickies` is the caller's to delete -- that
/// needs the database, and this is called from places that do not.
pub fn close_window(app: &AppHandle, item_id: &str) {
    let Some(card) = reg().cards.remove(item_id) else { return };
    if let Some(win) = app.get_webview_window(&card.label) {
        // `destroy` rather than `close`: `close` raises CloseRequested, which
        // would come back round to delete the row a second time.
        let _ = win.destroy();
    }
}

/// Moves an open card from one item to another -- its clip to the note made
/// from it -- without closing the window or moving it. The `stickies` row is
/// the caller's to re-key.
pub fn rekey(app: &AppHandle, from: &str, to: &str) -> bool {
    let Some(label) = reg().rekey(from, to) else { return false };
    assign(app, &label, to);
    true
}

/// Records where a card came to rest, so the cascade places the next one
/// against where this one really is.
pub fn remember_geometry(item_id: &str, geo: StickyGeometry) {
    if let Some(card) = reg().cards.get_mut(item_id) {
        card.geo = geo;
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
/// The spare is included, so it is already right when it is handed out.
pub fn apply_capture_all(app: &AppHandle, enabled: bool) {
    for (label, win) in app.webview_windows() {
        if label.starts_with(PREFIX) {
            capture::apply(&win, enabled);
        }
    }
}

/// Hides every card, or brings them all back. Hiding does not destroy the
/// windows, so bringing them back costs nothing -- unlike reopening them. Not
/// persisted: a restart shows them again. Returns whether they are now hidden.
pub fn toggle_all(app: &AppHandle) -> bool {
    let hide = !reg().hidden;
    set_hidden(app, hide)
}

fn set_hidden(app: &AppHandle, hide: bool) -> bool {
    let labels: Vec<String> = {
        let mut r = reg();
        // Nothing on screen: there is nothing to hide, and a "hidden" state
        // left over would swallow the next card.
        let hide = hide && !r.cards.is_empty();
        if r.hidden == hide {
            return hide;
        }
        r.hidden = hide;
        r.cards.values().map(|c| c.label.clone()).collect()
    };
    for label in labels {
        if let Some(win) = app.get_webview_window(&label) {
            if hide {
                let _ = win.hide();
            } else {
                let _ = win.show();
                raise(&win);
            }
        }
    }
    tray::set_stickies_label(app, hide);
    hide
}

/// The only window events a sticky reacts to. The panel's hide-on-blur and
/// close-means-hide rules are deliberately absent: a sticky losing focus is
/// the normal state of a sticky, and closing one really closes it.
pub fn on_window_event(win: &tauri::Window, event: &WindowEvent) {
    match event {
        WindowEvent::CloseRequested { .. } => {
            let Some(id) = reg().release_label(win.label()) else { return };
            let Some(state) = win.app_handle().try_state::<AppState>() else { return };
            let pool = state.db.pool.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = queries::delete_sticky(&pool, &id).await {
                    tracing::warn!(error = %e, "could not forget closed sticky");
                }
            });
        }
        // However a window went -- `destroy`, a crash of its renderer -- the
        // registry must not keep pointing at it.
        WindowEvent::Destroyed => {
            reg().release_label(win.label());
        }
        _ => {}
    }
}

/// Closes every sticky whose item is no longer live. For the bulk deletes,
/// which resolve their set in SQL and never see the ids one by one here.
pub async fn close_orphans(app: &AppHandle, db: &Db) {
    for id in open_ids() {
        if matches!(queries::get(&db.pool, &id).await, Ok(None)) {
            close_window(app, &id);
            if let Err(e) = queries::delete_sticky(&db.pool, &id).await {
                tracing::warn!(error = %e, "could not forget orphaned sticky");
            }
        }
    }
}

/// A blank note, straight onto the screen, focused and ready for typing.
pub async fn new_note(app: &AppHandle, db: &Db) -> Result<Item, String> {
    let item = queries::insert_note(&db.pool, String::new(), String::new())
        .await
        .map_err(|e| format!("note create failed: {e}"))?;
    let title = item.title.as_deref().unwrap_or("Cliptack");
    match open_window(app, &item.id, title, None, true) {
        Ok(Opened::New(geo)) => {
            queries::upsert_sticky(&db.pool, &item.id, geo)
                .await
                .map_err(|e| format!("could not record sticky: {e}"))?;
        }
        Ok(Opened::Existing) => {}
        Err(e) => {
            // A note nobody can see would only clutter the list.
            let _ = queries::soft_delete(&db.pool, &item.id).await;
            return Err(e);
        }
    }
    let _ = app.emit("item-added", &item);
    Ok(item)
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
        for (i, (id, geo)) in saved.into_iter().enumerate() {
            let item = match queries::get(&db.pool, &id).await {
                Ok(Some(item)) if !item.is_credential() => item,
                _ => {
                    let _ = queries::delete_sticky(&db.pool, &id).await;
                    continue;
                }
            };
            if i > 0 {
                tokio::time::sleep(RESTORE_GAP).await;
            }
            let title = item.title.as_deref().unwrap_or("Cliptack");
            if let Err(e) = open_window(&app, &id, title, Some(geo), false) {
                tracing::warn!(error = %e, "could not restore sticky");
            }
        }
    });
}

/// What `place` needs from the OS, gathered before the registry lock is taken.
struct Spot {
    saved_on_screen: bool,
    cursor: (i32, i32),
    /// Origin, size and scale of the monitor under the cursor.
    monitor: Option<((i32, i32), (u32, u32), f64)>,
}

fn survey(app: &AppHandle, saved: Option<StickyGeometry>) -> Spot {
    let saved_on_screen = saved.is_some_and(|g| window::point_on_some_monitor(app, g.x, g.y));
    let cursor = app.cursor_position().unwrap_or_default();
    let monitor = if saved_on_screen {
        None
    } else {
        app.monitor_from_point(cursor.x, cursor.y)
            .ok()
            .flatten()
            .or_else(|| app.primary_monitor().ok().flatten())
            .map(|m| {
                let (p, s) = (m.position(), m.size());
                ((p.x, p.y), (s.width, s.height), m.scale_factor())
            })
    };
    Spot { saved_on_screen, cursor: (cursor.x as i32, cursor.y as i32), monitor }
}

/// The saved spot when it is still on a connected monitor; otherwise beside
/// the cursor, on whichever monitor holds it, stepped off any card already
/// there. The saved size is kept either way -- it is the position an unplugged
/// display invalidates, not the size.
fn place(spot: &Spot, saved: Option<StickyGeometry>, taken: &[(i32, i32)]) -> StickyGeometry {
    if let Some(geo) = saved.filter(|_| spot.saved_on_screen) {
        return geo;
    }

    let Some(((ox, oy), (aw, ah), scale)) = spot.monitor else {
        let (w, h) = saved.map_or((DEFAULT_SIZE.0 as u32, DEFAULT_SIZE.1 as u32), |g| (g.width, g.height));
        return StickyGeometry { x: spot.cursor.0, y: spot.cursor.1, width: w, height: h };
    };

    let (width, height) = saved.map_or(
        ((DEFAULT_SIZE.0 * scale) as u32, (DEFAULT_SIZE.1 * scale) as u32),
        |g| (g.width, g.height),
    );
    let offset = (CURSOR_OFFSET * scale) as i32;

    // Clamped so the whole card lands on the cursor's monitor rather than
    // hanging off its right or bottom edge.
    let bounds = Bounds {
        min_x: ox,
        min_y: oy,
        max_x: ox + aw as i32 - width as i32,
        max_y: oy + ah as i32 - height as i32,
    };
    let base = (
        (spot.cursor.0 + offset).clamp(bounds.min_x, bounds.max_x.max(bounds.min_x)),
        (spot.cursor.1 + offset).clamp(bounds.min_y, bounds.max_y.max(bounds.min_y)),
    );
    let (x, y) = cascade(base, taken, offset, bounds);
    StickyGeometry { x, y, width, height }
}

#[derive(Debug, Clone, Copy)]
struct Bounds {
    min_x: i32,
    min_y: i32,
    max_x: i32,
    max_y: i32,
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

    fn spot() -> Spot {
        Spot { saved_on_screen: false, cursor: (100, 100), monitor: Some(((0, 0), (1920, 1080), 1.0)) }
    }

    fn reserve(r: &mut Registry, id: &str) -> Result<Reservation, String> {
        let s = spot();
        r.reserve(id, |taken| place(&s, None, taken))
    }

    fn geo_of(res: Reservation) -> StickyGeometry {
        match res {
            Reservation::New { geo, .. } => geo,
            Reservation::Existing => panic!("expected a new card"),
        }
    }

    /// The burst that stacked three cards on one spot: each reservation is
    /// placed against the ones before it even though none is visible yet.
    #[test]
    fn a_burst_of_reservations_lands_on_distinct_spots() {
        let mut r = Registry::default();
        let spots: Vec<(i32, i32)> = ["a", "b", "c", "d"]
            .iter()
            .map(|id| geo_of(reserve(&mut r, id).unwrap()))
            .map(|g| (g.x, g.y))
            .collect();
        let mut unique = spots.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), 4, "cards share a spot: {spots:?}");
    }

    #[test]
    fn a_second_press_while_building_is_not_a_second_window() {
        let mut r = Registry::default();
        assert!(matches!(reserve(&mut r, "a").unwrap(), Reservation::New { .. }));
        assert_eq!(reserve(&mut r, "a").unwrap(), Reservation::Existing);
        assert_eq!(r.cards.len(), 1);
    }

    #[test]
    fn each_spare_is_handed_out_once_and_not_counted() {
        let mut r = Registry::default();
        let spares = vec![r.new_label(), r.new_label()];
        r.spares = spares.clone();
        let mut handed = Vec::new();
        for id in ["a", "b", "c"] {
            match reserve(&mut r, id).unwrap() {
                Reservation::New { label, from_spare, .. } => handed.push((label, from_spare)),
                Reservation::Existing => panic!(),
            }
        }
        assert!(handed[0].1 && handed[1].1, "the spares were not used first");
        assert!(!handed[2].1, "a third card claimed a spare that does not exist");
        let labels: Vec<&String> = handed.iter().map(|(l, _)| l).collect();
        assert!(spares.iter().all(|s| labels.contains(&s)));
        assert_ne!(labels[0], labels[1], "one window handed to two items");
        assert!(r.spares.is_empty());
    }

    #[test]
    fn the_cap_counts_cards_not_spares() {
        let mut r = Registry::default();
        for i in 0..MAX_STICKIES {
            reserve(&mut r, &format!("i{i}")).unwrap();
        }
        let spare = r.new_label();
        r.spares.push(spare);
        assert!(reserve(&mut r, "one-too-many").is_err());
        assert_eq!(r.spares.len(), 1, "a refused open used up a spare");
    }

    #[test]
    fn the_pool_stops_at_its_size_and_at_the_cap() {
        let mut r = Registry::default();
        assert!(wants_spare(&r));
        r.spares = (0..SPARES).map(|_| r.new_label()).collect();
        assert!(!wants_spare(&r), "built past the pool size");

        let mut r = Registry::default();
        for i in 0..MAX_STICKIES {
            reserve(&mut r, &format!("i{i}")).unwrap();
        }
        r.spares = (0..SPARES).map(|_| r.new_label()).collect();
        assert!(!wants_spare(&r));
    }

    #[test]
    fn releasing_a_label_forgets_the_card_or_the_spare() {
        let mut r = Registry::default();
        let Reservation::New { label, .. } = reserve(&mut r, "a").unwrap() else { panic!() };
        assert_eq!(r.release_label(&label).as_deref(), Some("a"));
        assert!(r.cards.is_empty());

        let spare = r.new_label();
        r.spares.push(spare.clone());
        assert_eq!(r.release_label(&spare), None);
        assert!(r.spares.is_empty());
    }

    /// The panel gets its flags from tauri.conf.json, the cards from
    /// `BROWSER_ARGS`. If they differ, the first card fails to open at all.
    #[test]
    fn the_panel_and_the_cards_use_the_same_webview2_flags() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        let panel = conf["app"]["windows"]
            .as_array()
            .and_then(|w| w.iter().find(|w| w["label"] == "panel"))
            .expect("panel window in tauri.conf.json");
        assert_eq!(panel["additionalBrowserArgs"].as_str(), Some(BROWSER_ARGS));
    }

    #[test]
    fn rekey_keeps_the_window_and_position() {
        let mut r = Registry::default();
        let Reservation::New { label, geo, .. } = reserve(&mut r, "clip").unwrap() else { panic!() };
        assert_eq!(r.rekey("clip", "note").as_deref(), Some(label.as_str()));
        assert!(r.label_of("clip").is_none());
        assert_eq!(r.label_of("note"), Some(label));
        assert_eq!(r.cards["note"].geo, geo);
    }

    #[test]
    fn labels_are_never_reused() {
        let mut r = Registry::default();
        let a = r.new_label();
        let b = r.new_label();
        assert_ne!(a, b);
        assert!(a.starts_with(PREFIX) && b.starts_with(PREFIX));
    }

    #[test]
    fn a_saved_spot_on_screen_is_kept_exactly() {
        let saved = StickyGeometry { x: 700, y: 300, width: 410, height: 260 };
        let s = Spot { saved_on_screen: true, cursor: (0, 0), monitor: None };
        assert_eq!(place(&s, Some(saved), &[(700, 300)]), saved);
    }
}
