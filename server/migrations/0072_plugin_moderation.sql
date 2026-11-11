-- Moderation of the community plugin registry (src/plugins.rs).

-- A published plugin is listed until the server's administrators (KC_ADMINS) hide it —
-- reversible — or remove it, which also drops its files and keeps the row so the identifier
-- cannot simply be published again.  The reason is shown to the publisher and to the people
-- who had installed it.
ALTER TABLE plugin_registry
    ADD COLUMN status           TEXT NOT NULL DEFAULT 'listed' CHECK (status IN ('listed', 'hidden', 'removed')),
    ADD COLUMN moderated_reason TEXT,
    ADD COLUMN moderated_at     TIMESTAMPTZ;

-- Set on a person's installed copy when the plugin it came from was hidden or removed: the
-- copy is switched off and the manager says why.  It stays theirs to switch back on or uninstall.
ALTER TABLE plugins ADD COLUMN withdrawn TEXT;

-- Anyone signed in can report a published plugin, once each; a new report replaces their old one.
CREATE TABLE plugin_reports (
    id          BIGSERIAL PRIMARY KEY,
    identifier  TEXT NOT NULL REFERENCES plugin_registry(identifier) ON DELETE CASCADE,
    reporter_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason      TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    UNIQUE (identifier, reporter_id)
);
CREATE INDEX plugin_reports_open ON plugin_reports (identifier) WHERE resolved_at IS NULL;
