-- Junction's GitHub App (src/github_app.rs): registered once from a manifest by an
-- administrator, so its credentials come back from GitHub straight into the
-- database instead of through anyone's hands.  Secrets are AES-GCM sealed with
-- the same JWT_SECRET-derived key as the users' tokens.
CREATE TABLE github_app (
    id             INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    app_id         BIGINT NOT NULL,
    slug           TEXT NOT NULL,
    name           TEXT NOT NULL,
    owner_login    TEXT NOT NULL DEFAULT '',
    html_url       TEXT NOT NULL,
    client_id      TEXT NOT NULL,
    client_secret  BYTEA NOT NULL,
    webhook_secret BYTEA,
    private_key    BYTEA NOT NULL,
    created_by     BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A repository grant is now either the old OAuth-app token (kind 'oauth', the
-- `repo`/`public_repo` scope) or a GitHub App user token (kind 'app'), which sees
-- only the repositories the person installed the app on and expires, so it
-- carries a refresh token.
ALTER TABLE github_tokens
    ADD COLUMN kind       TEXT NOT NULL DEFAULT 'oauth',
    ADD COLUMN refresh    BYTEA,
    ADD COLUMN expires_at TIMESTAMPTZ,
    ADD COLUMN refresh_expires_at TIMESTAMPTZ;
