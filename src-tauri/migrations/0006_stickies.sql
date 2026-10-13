-- Items pinned to the screen as floating sticky windows.
--
-- One row per open sticky, holding the window's geometry in physical pixels so
-- it reopens where it was left. Geometry is a fact about this machine's
-- monitors, not about the item, which is why it lives here rather than on
-- `items` -- and why stickies are not part of export/import.
--
-- A row exists only while its window should exist: closing a sticky deletes it.
-- ON DELETE CASCADE covers retention's hard delete; a soft delete is handled in
-- code, by closing the window.
CREATE TABLE stickies (
  item_id    TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  x          INTEGER NOT NULL,
  y          INTEGER NOT NULL,
  width      INTEGER NOT NULL,
  height     INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
