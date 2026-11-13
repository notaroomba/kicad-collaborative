-- Fonts a project's text is set in, kept on the server so that everybody who opens the
-- project sees the same letters whether or not the font is installed on their computer.
--
-- Google Fonts are public and openly licensed (OFL, Apache 2.0 or Ubuntu Font Licence), so
-- one copy serves every project.  A font uploaded from somebody's computer belongs to the
-- project it was uploaded for and is only handed to people who can open that project.

CREATE TABLE IF NOT EXISTS google_font_files (
    family     TEXT NOT NULL,
    bold       BOOLEAN NOT NULL,
    italic     BOOLEAN NOT NULL,
    weight     INTEGER NOT NULL,
    sha256     TEXT NOT NULL,
    data       BYTEA NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (family, bold, italic)
);

CREATE TABLE IF NOT EXISTS project_font_files (
    project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    -- the family name lower-cased: what (font (face "…")) is matched against
    family_key  TEXT NOT NULL,
    family      TEXT NOT NULL,
    bold        BOOLEAN NOT NULL,
    italic      BOOLEAN NOT NULL,
    file_name   TEXT NOT NULL DEFAULT '',
    -- OS/2 fsType: the font's own embedding permission, checked before it is accepted
    fs_type     INTEGER NOT NULL DEFAULT 0,
    license     TEXT NOT NULL DEFAULT '',
    sha256      TEXT NOT NULL,
    bytes       BIGINT NOT NULL,
    data        BYTEA NOT NULL,
    uploaded_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, family_key, bold, italic)
);
