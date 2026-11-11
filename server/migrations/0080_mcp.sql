-- The MCP endpoint (src/mcp.rs) and the OAuth authorization server in front of it
-- (src/oauth.rs): how Claude (Claude Code, the desktop app, claude.ai connectors) signs in
-- as a person and works on their projects.

-- An application that registered itself (RFC 7591 dynamic client registration).  These are
-- public clients: no secret, PKCE on every authorization.
CREATE TABLE mcp_clients (
    client_id     TEXT PRIMARY KEY,
    name          TEXT NOT NULL DEFAULT '',
    redirect_uris JSONB NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One "Allow" on the consent page: this person let this application act for them, with
-- this scope ("read" or "read write").  Removing the row is how access is taken away; the
-- tokens go with it.
CREATE TABLE mcp_grants (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id    TEXT NOT NULL REFERENCES mcp_clients(client_id) ON DELETE CASCADE,
    scope        TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ
);
CREATE INDEX mcp_grants_user ON mcp_grants (user_id);

-- Access and refresh tokens, stored as SHA-256 hashes: a database dump does not hand out
-- working tokens.  A refresh token is single use; `replaced_at` marks one that was spent,
-- so presenting it again (a stolen copy) revokes the whole grant.
CREATE TABLE mcp_tokens (
    hash        BYTEA PRIMARY KEY,
    grant_id    BIGINT NOT NULL REFERENCES mcp_grants(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
    expires_at  TIMESTAMPTZ NOT NULL,
    replaced_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX mcp_tokens_grant ON mcp_tokens (grant_id);
CREATE INDEX mcp_tokens_expiry ON mcp_tokens (expires_at);

-- Every change made through the endpoint, with what it takes to take it back (`undo`): the
-- inverse changes, each touched item as the change left it (an item somebody has edited
-- since is not overwritten by an undo), and the board rules as they were.  NULL when the
-- change was too large to keep an undo for.
CREATE TABLE mcp_changes (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    doc_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    title      TEXT NOT NULL DEFAULT '',
    edits      JSONB NOT NULL DEFAULT '[]',
    undo       JSONB,
    client     TEXT NOT NULL DEFAULT '',
    undone_at  TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX mcp_changes_doc ON mcp_changes (doc_id, id DESC);
CREATE INDEX mcp_changes_project ON mcp_changes (project_id, id DESC);
