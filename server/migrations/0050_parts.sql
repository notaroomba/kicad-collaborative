-- Vendor parts and saved part libraries (src/parts).

-- One row per (vendor, vendor part number): the cache behind every reference.
-- A saved library or a search hit only names the part; what the vendor said
-- about it lives here, so it is fetched once, shared by everyone, and still
-- there when the vendor is unreachable.
CREATE TABLE parts (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vendor          TEXT NOT NULL,            -- 'lcsc' | 'mouser' | 'digikey'
    vendor_id       TEXT NOT NULL,            -- C8734 · 511-STM32F103C8T6 · 497-6063-ND
    mpn             TEXT NOT NULL DEFAULT '',
    manufacturer    TEXT NOT NULL DEFAULT '',
    -- Description, package, datasheet, stock, price breaks… as last fetched.
    info            JSONB NOT NULL DEFAULT '{}'::jsonb,
    info_fetched_at TIMESTAMPTZ,
    -- The vendor's own drawing data (EasyEDA's answer for an LCSC part), kept
    -- verbatim: the KiCad symbol and footprint are converted from it on demand,
    -- so a better converter improves every cached part without a refetch.
    cad_raw         JSONB,
    cad_fetched_at  TIMESTAMPTZ,
    -- For a vendor with no drawings of its own (Mouser, DigiKey): the part whose
    -- drawings stand in for it, matched by manufacturer part number.
    cad_vendor      TEXT,
    cad_vendor_id   TEXT,
    cad_checked_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (vendor, vendor_id)
);
CREATE INDEX parts_mpn_idx ON parts (upper(mpn));

-- 3D models (STEP), by the vendor's model id.
CREATE TABLE part_models (
    uuid       TEXT PRIMARY KEY,
    step       BYTEA NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A saved library: a named list of part references.  Personal by default;
-- attached to a project it is shared with that project's members.
CREATE TABLE part_libraries (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id  UUID REFERENCES projects(id) ON DELETE SET NULL,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX part_libraries_owner_idx ON part_libraries (owner_id);
CREATE INDEX part_libraries_project_idx ON part_libraries (project_id);

-- A library entry is only the reference: where the part comes from, its number
-- there and the manufacturer's number (kept so the entry stays meaningful, and
-- can be found again elsewhere, if the vendor drops the listing).
CREATE TABLE part_library_items (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    library_id   UUID NOT NULL REFERENCES part_libraries(id) ON DELETE CASCADE,
    vendor       TEXT NOT NULL,
    vendor_id    TEXT NOT NULL,
    mpn          TEXT NOT NULL DEFAULT '',
    manufacturer TEXT NOT NULL DEFAULT '',
    note         TEXT NOT NULL DEFAULT '',
    added_by     BIGINT REFERENCES users(id) ON DELETE SET NULL,
    added_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (library_id, vendor, vendor_id)
);

-- A user's own API credentials for vendors that need them (Mouser, DigiKey),
-- AES-GCM encrypted with a key derived from JWT_SECRET like the GitHub tokens.
CREATE TABLE vendor_keys (
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vendor     TEXT NOT NULL,
    secret     BYTEA NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, vendor)
);
