-- GitHub repository sync (src/github.rs).

-- A user's repository grant.  Separate from sign-in (which asks GitHub for
-- identity only); the token is AES-GCM encrypted with a key derived from
-- JWT_SECRET, so a database dump alone does not expose anyone's repositories.
CREATE TABLE github_tokens (
    user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    token      BYTEA NOT NULL,
    scopes     TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One repository folder per online project (the same one-folder-one-project
-- rule the desktop follows).
CREATE TABLE project_github (
    project_id  UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    repo_owner  TEXT NOT NULL,
    repo_name   TEXT NOT NULL,
    branch      TEXT NOT NULL,
    -- Folder inside the repository holding the project ('' = the root).
    subdir      TEXT NOT NULL DEFAULT '',
    linked_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
    -- The commit the project was last brought level with.
    base_commit TEXT,
    synced_at   TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- What each file looked like (its git blob id) the last time the two sides
-- agreed on it: the common ancestor that tells "changed online" from "changed
-- on GitHub" and makes a three-way merge possible.
CREATE TABLE project_github_files (
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path       TEXT NOT NULL,
    blob_sha   TEXT NOT NULL,
    PRIMARY KEY (project_id, path)
);
