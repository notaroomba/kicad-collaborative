-- Web editor plugins (src/plugins.rs, web/plugins).

-- A plugin a person installed.  Plugins belong to an account, not to a project: one person
-- installing a plugin never makes it run for anyone else.  The server only keeps the copy —
-- the manifest (KiCad's plugin.json with the "web" runtime) and the plugin's text files —
-- and hands it back to that person's browser, which runs it in a sandbox.
--
-- `granted` is what the person agreed to when they installed this copy; the browser gives
-- the plugin nothing beyond it.  It is stored rather than re-read from the manifest so that
-- an update asking for more has to be consented to again before the new copy replaces this.
CREATE TABLE plugins (
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    identifier   TEXT NOT NULL,
    manifest     JSONB NOT NULL,
    files        JSONB NOT NULL,
    granted      JSONB NOT NULL DEFAULT '[]',
    enabled      BOOLEAN NOT NULL DEFAULT TRUE,
    source       TEXT NOT NULL DEFAULT '',
    installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, identifier)
);
