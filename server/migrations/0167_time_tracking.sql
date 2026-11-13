-- Time tracking (src/timetrack.rs): Junction's own record of when people work on a
-- project, and the WakaTime settings of the browser editor.

-- One row per heartbeat: someone signed in moved, drew or edited in a document, at most
-- one row per person every two minutes per document (WakaTime's heartbeat rate).  Time
-- spent is the sum of the gaps between a person's heartbeats that are under 15 minutes,
-- the same rule WakaTime uses.
CREATE TABLE activity_beats (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    doc_id     UUID REFERENCES documents(id) ON DELETE SET NULL,
    path       TEXT NOT NULL DEFAULT '',
    client     TEXT NOT NULL DEFAULT 'web',
    is_write   BOOLEAN NOT NULL DEFAULT false,
    at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX activity_beats_user_at ON activity_beats (user_id, at);
CREATE INDEX activity_beats_project_at ON activity_beats (project_id, at);

-- A person's WakaTime (or Wakapi, Hackatime: anything speaking the WakaTime API) key, used
-- by the server to send the browser editor's heartbeats, so the key never sits in a page.
-- AES-GCM sealed with the JWT_SECRET-derived key, like the GitHub tokens; `hint` is the
-- last four characters, so the settings can say which key is stored.
CREATE TABLE wakatime_settings (
    user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled     BOOLEAN NOT NULL DEFAULT true,
    api_key     BYTEA,
    hint        TEXT NOT NULL DEFAULT '',
    api_url     TEXT NOT NULL DEFAULT '',
    last_at     TIMESTAMPTZ,
    last_ok     BOOLEAN,
    last_status TEXT NOT NULL DEFAULT '',
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
