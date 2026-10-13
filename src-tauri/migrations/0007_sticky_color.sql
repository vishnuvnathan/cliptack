-- A paper colour per sticky, so several cards on screen can be told apart at a
-- glance. Stored by name, not as a hex value: the frontend owns the palette
-- (each paper pairs a background with text that stays readable on it), and
-- `sticky::COLORS` is the list of names Rust accepts.
--
-- On `stickies` rather than `items` for the same reason as the geometry: it
-- describes the card on this screen, not the clip. Closing a sticky forgets it.
ALTER TABLE stickies ADD COLUMN color TEXT NOT NULL DEFAULT 'default';
