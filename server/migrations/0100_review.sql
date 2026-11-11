-- Design review: a comment thread can be pinned to a part or a net rather than
-- to a bare position.  The root comment carries the anchor; x_nm / y_nm stay as
-- the place the thread was started, used when the anchored item is gone.
--
--   anchor_kind  'item' (a symbol, footprint, track … by uuid) or 'net'
--   anchor_id    the item's uuid, or the net's name
--   anchor_label what a person calls it ("R1", "GND"), kept so a thread still
--                reads well after the item was deleted
--   anchor_item  for a net: the uuid of the item the thread was started on, so
--                an unnamed net can still be found
ALTER TABLE comments
    ADD COLUMN anchor_kind  TEXT,
    ADD COLUMN anchor_id    TEXT,
    ADD COLUMN anchor_label TEXT,
    ADD COLUMN anchor_item  TEXT,
    ADD COLUMN edited_at    TIMESTAMPTZ;

ALTER TABLE comments
    ADD CONSTRAINT comments_anchor_kind_check
    CHECK (anchor_kind IS NULL OR anchor_kind IN ('item', 'net'));
