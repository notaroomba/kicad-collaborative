-- The community plugin registry and per-project plugin recommendations (src/plugins.rs).

-- A plugin someone published for others to install.  Publishing shares the copy, nothing
-- more: it never installs or runs anything for anyone.  A person who installs it from here
-- is shown its permissions and consents exactly as for any other plugin, and the entry
-- says who published it.  An identifier belongs to whoever published it first.
CREATE TABLE plugin_registry (
    identifier   TEXT PRIMARY KEY,
    owner_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    manifest     JSONB NOT NULL,
    files        JSONB NOT NULL,
    published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX plugin_registry_owner ON plugin_registry (owner_id);

-- Plugins a project suggests to the people who work on it.  A suggestion only: each
-- collaborator sees it and installs (and consents) for themselves, or does not.  Only
-- plugins anyone can get — the built-in catalog or the registry — can be recommended.
CREATE TABLE project_plugins (
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    identifier TEXT NOT NULL,
    origin     TEXT NOT NULL CHECK (origin IN ('catalog', 'registry')),
    added_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
    added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, identifier)
);
