-- The footprint name each cached vendor drawing converts to, so a footprint id such as
-- "LCSC:QFN-68_L8.0-W8.0-P0.40-TL-EP6.4" written into a symbol's Footprint field can be
-- resolved later (footprint preview, Update PCB from Schematic, Change Footprints).
-- Filled when a drawing is cached; rows cached before this are filled on first lookup.
ALTER TABLE parts ADD COLUMN IF NOT EXISTS fp_name TEXT;
CREATE INDEX IF NOT EXISTS parts_fp_name ON parts (fp_name) WHERE fp_name IS NOT NULL;
