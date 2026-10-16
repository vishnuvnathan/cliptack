# Cliptack

**A clipboard history for Windows that keeps everything on your machine — and
lets you tack any clip to your screen.**

![Cliptack panel demo](docs/media/demo.gif)

**[Download for Windows](https://github.com/vishnuvnathan/cliptack/releases/latest/download/Cliptack-windows-x64.msi)**
([all releases](https://github.com/vishnuvnathan/cliptack/releases))
· Windows 10 and 11 · free and open source ([MIT](LICENSE))
· [website and 34-second film](https://vishnuvnathan.github.io/cliptack/)

Install it, then press `Ctrl+Shift+V` anywhere to open your history. The
installer is not code-signed yet, so Windows SmartScreen may say "Windows
protected your PC": choose **More info → Run anyway**.

## What makes it different

- **Nothing leaves your machine.** The code makes no network calls, and no
  dependency that opens a socket is included.
- **Passwords paste only into password fields.** Saved credentials are encrypted
  with Windows DPAPI, and `Ctrl+Shift+Enter` pastes one only after Windows UI
  Automation confirms the focused box *is* a password field. Anything else, and
  nothing is sent.
- **Hidden from screen shares** by default, so your history never shows up in a
  meeting.
- **Tack anything to the screen.** `Ctrl+O` pops a clip — a JSON snippet, an
  image, a colour — out into a small always-on-top card.
- **Paste as.** `Ctrl+T` prettifies JSON, decodes base64, changes case and more,
  without changing what was saved.
- **Search like a developer.** `app:Code type:code is:pinned "exact phrase"`.
- **Quiet.** 0.02% CPU and about 31 MB of memory when idle, measured.
- **Password-manager copies are never recorded.**

None of this is taken on trust: [about 30 behaviours were checked by running the
app](#what-was-verified-on-windows-11), on top of 117 automated tests.

Windows only for now. The macOS and Linux code is written but has never been
compiled on those platforms.

The recording above arrows through a stored credential, a note, a link and two
code snippets; `Ctrl+T` on a JSON clip for the "paste as" menu; then the search
box, first with the `type:code` operator and then as a plain prefix search. Full
resolution: [docs/media/demo.mp4](docs/media/demo.mp4). Data shown is seeded demo
content, not a real clipboard history.

### Upgrading from Stash

Cliptack was called Stash until v0.1. Its first launch copies an existing Stash
install across -- history, images, notes, credentials and settings -- from
`%APPDATA%\dev.stash.app` into `%APPDATA%\io.github.vishnuvnathan.cliptack`.
It copies rather than moves, so the old folder stays behind as a fallback. The
database is copied with `VACUUM INTO`, a consistent snapshot even while Stash is
still running. It happens once: when Cliptack already has a database, the Stash
folder is left alone. Backups made by Stash (`.stashbk` and JSON exports) still
import. The code is in `src-tauri/src/legacy.rs`.

## Building

```bash
npm install
npm run tauri dev
```

Requires Rust (stable-msvc on Windows) and, on Windows, the VS Build Tools C++
workload plus a Windows SDK. v0.1 is the vertical slice described in
[PLAN.md](PLAN.md): capture, search, notes, and the window behaviour that makes
it usable from the keyboard.

**No `D:` drive?** Set `CARGO_TARGET_DIR` to any folder outside a synced
directory before building; it overrides the `target-dir` below.

**Build artifacts live outside the repo.** `src-tauri/.cargo/config.toml` points
`target-dir` at `D:/stash-build-target`. Two reasons, both learned
the hard way: this project sits in a OneDrive-synced folder, and OneDrive's
on-demand file virtualisation intermittently makes build-script `OUT_DIR`s
non-writable (`indexmap` fails with "output path is not a writable directory");
and a debug build is ~1.8 GB, which has no business syncing to the cloud.

The dev profile also gives dependencies no debug info (`[profile.dev.package."*"]`)
because a full-symbol debug build exhausted the disk. Our own code keeps
`line-tables-only`, so panics still carry file and line numbers. If you need to
step into a dependency, set `debug = true` there and expect the space back.

| Command | What it checks |
|---|---|
| `npm run check` | `tsc --noEmit` over the frontend |
| `cargo check` (in `src-tauri/`) | the backend |
| `cargo test` (in `src-tauri/`) | classifier, query parser, transforms, crypto, migrations, export/import |

## Using it

| Key | Action |
|---|---|
| `Ctrl+Shift+V` / `Cmd+Shift+V` | show or hide the panel, from anywhere (rebindable in settings) |
| `↑` / `↓` | move the selection |
| `Enter` | paste the selected item into the window you came from |
| `Ctrl+Enter` | copy it to the clipboard without pasting |
| `Ctrl+T` | "paste as" — transform the selection on the way out |
| `Ctrl+Backspace` | delete the selected item |
| `Ctrl+Z` | undo that delete |
| `Ctrl+P` | pin or unpin |
| `Ctrl+O` | pin the selected item to the screen as a sticky |
| `Ctrl+Shift+N` | new note, straight onto the screen as a sticky |
| `Ctrl+N` | new note |
| `Ctrl+K` | new credential |
| `Ctrl+Shift+Enter` | paste the selected credential's password — only into a password field |
| `Ctrl+Shift+C` | copy the selected credential's password |
| `Ctrl+M` | move the selected item to a folder (or create one) |
| `Alt+1`…`9` | filter by folder (`Alt+0` clears) |
| `Ctrl+,` | settings |
| `Esc` | hide the panel |

Clicking away hides the panel. Closing the window hides it too — the tray menu's
**Quit** is the only thing that ends the process.

### Appearance, shortcuts and what gets saved

All in **Settings**.

- **Theme** — Dark (the default), Light, or System, which follows the Windows
  setting live. The accent colour is one of six presets or any `#rrggbb`. On the
  light theme the accent is darkened so it stays readable as text.
- **Open shortcut** — click the field and press the combination you want. It must
  include Ctrl, Alt or Shift. If the key is refused (another app owns it, or it
  matches the capture shortcut) the old binding stays in force and the reason is
  shown under the field. Keys another app has registered globally never reach
  the field at all, and neither do Cliptack's own current shortcuts.
- **What Cliptack saves** — *Everything I copy* is the default. *Only what I choose*
  ignores ordinary Ctrl+C entirely: select something and press the capture
  shortcut (`Ctrl+Alt+C` by default) and Cliptack copies it and keeps exactly that
  one item. With nothing selected nothing is saved. On macOS and Linux Cliptack
  cannot send the copy keystroke for you, so press the shortcut first and then
  copy within a couple of seconds. Anything a password manager marks private is
  never saved in either mode.
- **Image files** — copying a single `.png`, `.jpg`, `.gif`, `.bmp` or `.webp`
  file in Explorer saves it as an image clip. Several files at once are ignored.

## Searching

An empty box lists everything, recent first. Typing runs an FTS5 prefix search.
Beyond that the box understands operators:

```
app:Code type:code is:pinned folder:work sort:used "exact phrase"
```

| Operator | Effect |
|---|---|
| `type:` `t:` | content type, or a chip name — `link` `text` `image` `code` `cred` |
| `app:` | source application |
| `folder:` `f:` | folder by name, case-insensitively |
| `is:` | `pinned` `note` `clip` `credential` `unfiled` |
| `sort:used` | rank by how often you have used the item, not by recency |
| `"…"` | a phrase, kept together |

Repeating an operator ORs within it and ANDs across it — the same rule the
filter chips follow, because they compile to the same `Filters` struct. There is
one filtering path, not two.

Two things it deliberately does *not* do. An unknown operator is not an error:
`wat:huh` searches for that text, so a typo finds nothing surprising rather than
silently matching everything. And a pasted `https://example.com` is not read as
an `https:` operator — the parser hands anything it does not recognise straight
back as text, which is the case the test suite guards hardest.

The parser is in `src/query.rs` and is pure: names are resolved to ids in SQL, so
it never touches the database. `commands::search_items` is the only caller.

## Transforming on the way out

`Ctrl+T` opens a "paste as" menu for the selected item: prettify or minify JSON,
base64 and URL encode/decode, upper/lower/Title/snake/kebab case, trim, join
lines. Enter pastes the result, `Ctrl+Enter` copies it.

**The stored item never changes.** A transform rewrites only what reaches the
clipboard for that one paste; the history keeps what you actually copied.

The menu is built per item by `transforms_for`, which decides by *trying* rather
than guessing: Prettify appears only if the content really parses as JSON, and
Decode only if the content really is decodable base64 that yields valid UTF-8.
Offering Decode on ordinary prose would produce mojibake and read as a bug, so
`looks_like_base64` insists on length, alphabet and a successful decode, and
rejects all-alphabetic strings outright.

JSON key order survives the round trip. `serde_json` sorts object keys by
default, which would silently reorder a config you were about to paste back, so
the crate is built with `preserve_order`.

Base64 and percent-encoding are hand-rolled in `src/transform.rs` rather than
pulled in as crates — a few lines each, in a project that already hand-rolls its
DIB decoding, and one fewer dependency in a tree whose selling point is what is
*not* in it.

## Pin to screen

`Ctrl+O`, or the arrow button on a row, pops the selected item out into its own
small window that stays on top of everything else: a JSON snippet to copy from
while you work, a colour as a swatch, a screenshot as a reference. It is the
thing Windows Sticky Notes cannot do -- float a *clipboard item*, not just text
you typed. Click the copy button (or `Ctrl+C` with nothing selected) to put the
item back on the clipboard.

- **Notes are editable in the sticky** and save themselves 600ms after you stop
  typing. A note open in the panel and in a sticky stays in step both ways
  (`item-updated`); if both are edited at once, the last save wins.
- **Clips are read-only**, for the same reason a transform never rewrites the
  stored item: the history records what you copied. A text clip has an
  **Edit as note** button instead: it makes a note from the clip and switches
  the card to it in place -- same spot, same colour -- leaving the clip as it was.
- **`Ctrl+Shift+N`** (or **New sticky note** in the tray menu) puts a blank
  note straight on screen, focused for typing. Closing it while still empty
  deletes the note (a soft delete, so it can still be restored).
- **Hide stickies / Show stickies** in the tray menu clears every card off the
  screen and brings them back, without rebuilding the windows. A global key for
  it can be set in Settings > Shortcuts; it is off until you pick one, so it
  never takes a key from another app. Popping something out shows them again.
- **Credentials cannot be stuck.** The row has no button for one, and Rust
  refuses it as well. A password floating over every window is what the rest of
  the app goes out of its way to prevent.
- **Opening a sticky does not pin the item**, so no pin icon appears on its
  row. Retention and "Clear clip history" skip any clip that has a sticky open
  instead, so a card on screen is never emptied. Once the sticky is closed the
  clip is ordinary history again.
- **Stickies follow the capture-exclusion setting** ("Hide Cliptack from screen
  capture"), on by default, so a card on screen does not leak into a screen
  share. Toggling the setting re-applies it to every open sticky.
- **They come back after a restart**, where you left them. A position on a
  monitor that is no longer connected falls back to beside the cursor. Deleting
  the item closes its sticky; undoing the delete does not reopen it.
- Popping out several items in a row without moving the mouse cascades them
  30px apart rather than stacking them exactly on top of each other -- including
  in a quick burst, where the cards before it are still being built.

**Why `Ctrl+O` is instant, and when it is not.** Creating a WebView2 blocks the
main thread for ~300-600 ms, and every IPC reply the panel is waiting on queues
behind it -- that was the freeze. After the first sticky of a session, Cliptack
keeps one hidden window with the frontend already loaded, built while the panel
is hidden. Measured on the debug build: a pop-out from that spare took 4 ms with
no main-thread stall, against ~390 ms for one built on demand. One spare covers
one pop-out per panel visit; a burst of four still builds three on demand
(~2 s of stalls in total). The spare costs one renderer, measured at about
+60 MB private, and is not kept at all until stickies are first used.

**The cost is memory, and it is why there is a cap of eight.** Each sticky is
its own WebView2 window with its own renderer process. Measured on Windows 11
with the debug build: the app with no stickies was 205 MB private across 8
processes (`cliptack.exe` alone ~10 MB private), and each sticky added roughly
27-32 MB private (about 55-65 MB working set). Eight open stickies is therefore
about +250 MB. The idle figures elsewhere in this README are for `cliptack.exe` on
its own, which stickies barely move.

Window geometry is a fact about this machine's monitors, so the `stickies`
table is not part of export/import. The sticky is the same bundle as the panel,
opened by Rust at `index.html?sticky=<id>` (a bare `?sticky` for the spare,
which is told its item through a `sticky-assign` event); `main.tsx` renders
only the card for that URL, with none of the panel's store, hotkeys or
hide-on-blur. Because a spare exists before its item does, window labels are
`sticky-w<n>` and the item-to-window map lives in `sticky.rs`.

## Usage-aware ranking

`items.use_count` counts the times an item was copied or pasted *out* of Cliptack,
and `sort:used` ranks by it. This is not `updated_at`: that column moves every
time the watcher sees the same content again, so copying something once a day
and reaching for a stored snippet forty times look identical through it.

Recording a use deliberately does not touch `updated_at`. Bumping it would
reshuffle the recent-first list every time you copied something, which is the
opposite of what a history is for — there is a test for exactly that.

## Getting your data out

Cliptack holds the only copy of your credentials, and DPAPI seals them to one
Windows account -- so `cliptack.db` is unreadable on the machine you would be
migrating *to*. That is what makes an export path a requirement rather than a
nicety, and why the encrypted format uses a passphrase instead of DPAPI.

Settings -> **Backup and restore**. Three formats:

| Format | Contains | Re-importable |
|---|---|---|
| Encrypted backup (`.cliptack`) | everything, passwords included, sealed with a passphrase | yes |
| JSON | everything; passwords only if you tick the box | yes |
| Markdown | readable notes, clips and credential fields | no |

Markdown never carries a password, whatever the settings say: it exists to be
read, printed and pasted, and a password in it ends up somewhere it was not
meant to be. An encrypted backup always carries them, because a
passphrase-protected archive without the credentials would not answer the
question it exists for.

The archive shape is deliberately not the database schema. There are no ids --
they mean nothing in another database and only invite primary-key collisions.
Folders travel by name. Images are inlined as base64 so one file is the whole
archive; a blob path into an app-data directory that will not exist is not a
backup.

**Importing merges. It never deletes or overwrites.** Items already present are
skipped -- clips by hash, and notes and credentials by an exact match on type,
title, content and `created_at`, since those are stored with no hash. Without
that second half, restoring the same backup twice would silently duplicate every
note you own. Imported passwords are re-sealed with *this* machine's key rather
than carried across.

Crypto is the one place this project does not hand-roll its primitives:
Argon2id derives the key, AES-256-GCM seals the bytes, and the salt and nonce
are fresh per archive. A wrong passphrase and a damaged file are indistinguishable
to GCM, so the error says both rather than guessing.

## Pasting, not just copying

`Enter` puts the item on the clipboard, hides the panel, hands focus back to
whatever window was focused when you opened it, and sends `Ctrl+V`. The window
to return to is recorded in `window::show`, before the panel appears — once the
panel has focus, the window you wanted is no longer the foreground one.

Nothing about that is assumed to have worked. The keystroke is only sent after
`GetForegroundWindow` confirms the target really is in front; if it never gets
there, or `SendInput` is refused (an elevated window will not accept synthetic
input from an unelevated process), the panel reports it and the item is still on
your clipboard to paste by hand. `Ctrl+Enter` skips the paste deliberately, and
the settings toggle turns it off altogether.

**Windows only.** macOS could do this with a Cmd+V `CGEvent` and Linux with
XTEST on X11, but synthetic keystrokes land in *other people's applications* —
a different risk from the written-but-unrun pasteboard code elsewhere in this
tree — and Wayland forbids it outright. Both return "unsupported" with a reason
the settings panel shows, and `Enter` falls back to copying.

Credential usernames paste the same way. Passwords paste only with
`Ctrl+Shift+Enter`, and only into a password field: the field that had focus
before the panel opened is not reliably the password field, and a password typed
into the wrong one is not a mistake you can take back. So after focus is handed
back, UI Automation is asked about the focused control, and `Ctrl+V` is sent only
if it reports `IsPassword` and belongs to the target window's process. Any other
answer — a text box, a control UIA cannot describe, an error — sends nothing; the
password is already on the clipboard with its 30-second clear armed, and the panel
says to press `Ctrl+V` yourself.

## How it stays quiet when idle

The watcher polls every 400ms, but a tick where nothing was copied costs one
platform call and an integer compare:

- **Windows** — `GetClipboardSequenceNumber`. The clipboard is not opened at all
  unless the counter moved.
- **macOS** — `NSPasteboard.changeCount`.
- **Linux** — no such counter exists, so this is the one platform that reads the
  selection each tick and compares a hash. XFIXES `SelectionNotify` would make
  it event-driven; that is the v0.2 follow-up.

Nothing is sent to the frontend on an unchanged clipboard, so React does not
re-render and no query runs. Re-copying something already stored bumps its
`updated_at` instead of inserting a duplicate row.

## What is never recorded

Content the copying app marked as secret is skipped before any bytes are read:

- **Windows** — the `ExcludeClipboardContentFromMonitorProcessing` clipboard
  format, which password managers set.
- **macOS** — `org.nspasteboard.ConcealedType`, plus the transient and
  auto-generated markers.
- **Linux** — **not available.** There is no portable marker; the KDE convention
  (`x-kde-passwordManagerHint`) needs raw X11 TARGETS inspection that `arboard`
  does not expose. On Linux, password-manager copies *will* be recorded. This is
  logged as a warning at startup and is the main known gap in v0.1.

Images over 10MB are skipped. The first clipboard state after launch is used as
a baseline and never stored, so whatever happened to be on the clipboard before
you started Cliptack is not swept up.

## Screen-capture exclusion

On by default, toggleable in settings. The settings toggle reports what the
platform actually did rather than assuming it worked.

- **Windows** — `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)`. That
  flag needs Windows 10 build 19041; on older builds the call is rejected and
  Cliptack falls back to `WDA_MONITOR`, which blanks the panel in recordings rather
  than hiding it. The settings panel says so when this happens.
- **macOS** — `NSWindow.sharingType = NSWindowSharingNone`.
- **Linux** — unsupported. A compositor decides what a screencast sees and there
  is no client-side opt-out, so hide-on-blur is the only mitigation. Warned once
  at startup.

## What was verified on Windows 11

Checked by running the app, not by reading the code. These checks ran before
the app was renamed from Stash, so two rows name what it wrote then: the
`Run\Stash` startup value, and a `.stashbk` backup starting `STASHBK1`.

| Behaviour | Result |
|---|---|
| Seven content types classified on insert | url, email, json, hex_color, code, path, text — all correct |
| `source_app` capture | recorded the focused app's executable stem |
| Concealed clipboard skipped | wrote a clip flagged `ExcludeClipboardContentFromMonitorProcessing`; item count unchanged, no row contains the secret |
| Dedupe by hash | re-copying an existing clip left one row with `updated_at` bumped |
| Image capture | CF_DIB converted to PNG, sharded blob on disk, hash stored |
| Idle CPU | **0.000%** over 30s across ~75 poll ticks, 31.8 MB resident |
| Capture exclusion | `GetWindowDisplayAffinity` returns `0x11` (`WDA_EXCLUDEFROMCAPTURE`, not the degraded fallback); a screen capture taken while the window was verifiably visible contains no trace of it |
| Global shortcut | Ctrl+Shift+V shows and hides the panel (default; rebindable, see above) |
| Hide on blur | panel hides within ~100ms of losing focus |
| FTS5 search | a query narrowed 9 items to the 2 matching rows, ranked |
| Notes | Ctrl+N, edit, Ctrl+S persists `kind='note'`, `content_type='markdown'`, title derived from the first line |
| Paste on Enter | copied one string, buried it under a decoy, opened the panel from a plain Win32 window, searched, pressed Enter — the **searched** string arrived in that window, so Cliptack both replaced the clipboard and delivered the keystroke |
| `Ctrl+Enter` | same sequence: clipboard updated, target window untouched |
| DPAPI at rest | the live database's `item_secrets` rows all read `enc='dpapi.v1'` with no plaintext in the column, and the blobs decrypt through `[System.Security.Cryptography.ProtectedData]` — a different implementation than the one that wrote them |
| Upgrade pass | ran against the real database; both existing credentials re-sealed and still return their original passwords |
| Password auto-clear | clipboard held the password at t+20s and was empty at t+34s; repeating it and copying something else at t+12s left that something else intact at t+34s |
| Launch on startup | toggling it wrote `HKCU\…\Run\Stash`, untoggling removed it; starting with the setting false and the key present, startup reconcile removed the key |
| Idle CPU | **0.02%** over 30s with the panel hidden, 31.1 MB resident — unchanged by any of the above |
| Query operators filter | `app:Code zebra` pasted the clip (as free text `app:Code` could never match), and `app:brave zebra` pasted nothing though the text alone matches — so the operator both includes and excludes |
| Operators leave the text alone | `is:clip zebra` still found the item; had `is:clip` reached FTS, the AND would have matched nothing |
| Transform | `Ctrl+T` → Prettify on a one-line JSON clip pasted it across seven lines, with `zebra` still ahead of `apple` — proving `preserve_order` rather than alphabetical sorting |
| Usage ranking | two clips sharing a term: plain search pasted the newer, three uses later `sort:used` pasted the older, and the plain search still pasted the newer |

| Encrypted export | driven through the settings panel and the native save dialog: wrote a 24,270-byte `.stashbk` beginning `STASHBK1`, containing none of `Daily Marble`, `vnathan`, `David` or `stash-export` as readable bytes |
| Hide-on-blur guard | the panel was still up behind both the save and the open dialog; without `window::HideGuard` the picker's focus grab would have dismissed it mid-export |
| Pin to screen | `Ctrl+O` on a JSON clip, a note, a colour and an image opened four topmost windows with `GetWindowDisplayAffinity` = `0x11`, and the panel kept the foreground throughout -- the sticky is shown with `SW_SHOWNOACTIVATE`, so popping one out never dismisses the panel |
| Sticky copy | `Ctrl+C` in the JSON sticky put the JSON on the clipboard; the item's `use_count` went to 1 and no duplicate clip was recorded |
| Sticky note sync | text typed into the sticky was in the database 1.5s later; text then saved from the panel's editor appeared in the sticky's textarea (read back through UI Automation) |
| Sticky refusals | `Ctrl+O` on a credential showed "Credentials cannot be pinned to the screen" and opened nothing; the ninth `Ctrl+O` showed "At most 8 stickies…" with exactly eight open |
| Sticky lifecycle | deleting a stuck note closed its window and removed its row; the close button removed the row; a moved sticky came back at the same position and size after the process was killed and relaunched |
| Sticky capture toggle | with exclusion off, restored stickies read `0x0`; switching it on in Settings turned all six open stickies to `0x11` without a restart |
| Import is idempotent | importing that backup into the database it came from reported **"Imported 0 items · 25 already here"** — including the notes and credentials, which carry no hash and are matched on exact content |

Verified by the test suite rather than by hand: the JSON and Markdown formats,
and a full export/import round trip into a *separate* database carrying a sealed
password, a real image blob, folder membership, pin state and timestamps.

The paste harness asserts that the target window really holds focus before
pressing the shortcut. Without that check an empty target reads as "did not
paste" when the truth may be "pasted into something else", and the first run of
these Tier 2 checks produced exactly that false negative.

Not verified: macOS and Linux (written, `cfg`-gated, never compiled on those
platforms), and retention pruning at the 1000-item threshold.

Screenshotting the panel to check the UI has two ways to come out solid black,
and they look identical. One is `WDA_EXCLUDEFROMCAPTURE` doing its job; the
other is that WebView2 composites through DirectComposition, which a screen
BitBlt cannot read. Check `GetWindowDisplayAffinity` to tell them apart, and use
`PrintWindow` with `PW_RENDERFULLCONTENT` for the second.

## Storage

The backend owns its own `sqlx` pool rather than borrowing `tauri-plugin-sql`'s.
That plugin creates its pool lazily, when the frontend calls `Database.load()`,
but the clipboard watcher starts in `setup()` before any window exists — it would
have had nothing to write to. Migrations are still the numbered files in
`src-tauri/migrations/`, embedded with `include_str!` and applied in order, each
in its own transaction, tracked in a `_migrations` table.

One SQLite database at `<app data>/cliptack.db`, WAL mode. Clips and notes share
the `items` table, which is why a note turns up in the same search as a clip
with no special-casing on either side. Full-text search is an FTS5
external-content table kept in sync by triggers.

Image clips are written to `<app data>/blobs/<first two hash chars>/<hash>.png`
and deduplicated by hash, so copying the same screenshot twice stores one file.

## Deleting

Nothing is deleted outright. `Ctrl+Backspace`, or the ✕ that appears when you
hover a row, sets `deleted_at` and drops the row out of every query; retention
hard-deletes it 24 hours later and unlinks its blob if no other row still points
at the same file.

That window is what `Ctrl+Z` reaches. There is no confirmation dialog on a single
delete, deliberately: a confirm taxes every delete to catch the rare wrong one,
which is the wrong trade for a panel driven at speed from the keyboard. The undo
offer costs nothing until you need it, and stands for eight seconds.

Two bulk operations, both confirmed inline rather than undoable:

| Where | What it takes |
|---|---|
| **Delete these**, on the filter row | everything the current search and filters match — the same set the list is showing, resolved through the same SQL |
| **Clear clip history**, in settings | captured clips only; notes, credentials and pinned items stay |

"Delete these" appears only once the view is narrowed by a query or a chip, and
counts in SQL rather than counting the rows on screen — search is capped, so the
visible list routinely understates what would go. Pinned items inside the match
are counted and reported, not silently spared: you narrowed the view, and
quietly exempting part of what it shows would be its own surprise.

The one thing that is not recoverable is a password. Deleting a credential erases
its `item_secrets` row immediately rather than letting it sit encrypted for the
grace period — deleting a credential is a request to be rid of the password, and
"gone tomorrow" is not an answer to that. Undo brings the entry back without it,
and says so before you take the offer.

## Credentials

Passwords live in `item_secrets` and nowhere else. The FTS triggers copy
`items.title` and `items.content` into the search index unconditionally, so a
password kept in either would become searchable text; no query joins that table
except the two secret helpers.

On Windows each one is sealed with DPAPI (`CryptProtectData`) under your account
and stored hex-encoded, with `item_secrets.enc` set to `dpapi.v1`. A copy of
`cliptack.db` is therefore useless on another machine or under another Windows
account. It is **not** protection against a program running as you: that program
can ask Windows to decrypt it exactly as Cliptack does. The settings panel says so
rather than claiming more.

`secret.rs` is the only place a secret is encoded or decoded, which is what let
encryption land as one file. Rows written before it carry `enc = 'none'`, still
decode through that arm, and are re-sealed in place at startup by
`queries::upgrade_unsealed_secrets` — no schema migration, and no credential
left plaintext waiting to be edited. Other platforms still store plaintext;
there is no Keychain or secret-service arm yet, and the panel admits it.

A password copied with `Ctrl+Shift+C` is cleared from the clipboard after 30
seconds — but only if the clipboard still holds that same password. Copy
anything else in the meantime and yours survives; a generation counter stops an
earlier timer wiping a newer copy of the same value. Clearing needs no
self-copy guard, because an empty clipboard offers neither `CF_UNICODETEXT` nor
`CF_DIB` and the watcher skips it.

Retention: the newest 1000 unpinned clips are kept. Pinned items and notes are
never pruned. Trimming is a soft delete; the row and its blob are hard-deleted
24 hours later, which leaves a recovery window. The pass runs every five minutes
and returns after a single `COUNT` when there is nothing to do.

## Layout

```
src/                      React panel
  lib/ipc.ts              the only module that calls invoke()
  lib/types.ts            mirrors the Rust serde types
  store/useCliptack.ts       zustand store
src-tauri/
  migrations/             numbered .sql, applied in order, embedded at build time
  src/clipboard/          watcher + per-platform readers
  src/capture/            screen-capture exclusion, one command, three backends
  src/paste/              focus restore + synthetic Ctrl+V, same three-backend shape
  src/sticky.rs           pin-to-screen windows: open, place, restore, close
  src/query.rs            the search query language; pure, no database access
  src/archive/            the export/import document; mod.rs is pure, io.rs touches the DB
  src/backup.rs           passphrase-encrypted container (Argon2id + AES-256-GCM)
  src/transform.rs        "paste as" transforms; pure functions over a &str
  src/secret.rs           the only place a password is encoded or decoded
  src/startup.rs          launch on startup, over tauri-plugin-autostart
  src/db/                 pool, queries, retention
  src/commands.rs         every IPC entry point, in one file
```

`src/lib/ipc.ts` is the single seam between the two halves. Components import
typed functions from it; if you need a new command, add the wrapper there rather
than calling `invoke` from a component.

## Known gaps

- Linux concealed-clipboard detection (above) — the significant one.
- macOS is written against the documented AppKit API but has not been built or
  run on hardware.
- Paste-on-Enter is Windows-only; macOS and Linux fall back to copying.
- Secrets are only encrypted on Windows. On macOS and Linux they are plaintext
  at rest, which the settings panel warns about.
- `tags` and `item_tags` exist in the schema with no UI behind them.
- Stickies are verified on Windows only. The macOS and Linux paths go through
  the same Tauri window API but have not been run.
