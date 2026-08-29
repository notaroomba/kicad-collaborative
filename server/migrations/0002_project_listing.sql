-- Indexes for the project-listing and user-search endpoints.

CREATE INDEX IF NOT EXISTS projects_owner_idx ON projects (owner_id);

CREATE INDEX IF NOT EXISTS permissions_user_idx ON permissions (user_id)
    WHERE user_id IS NOT NULL;

-- Prefix search on login/name for the share-dialog typeahead.
CREATE INDEX IF NOT EXISTS users_login_lower_idx
    ON users (lower(login) text_pattern_ops);
