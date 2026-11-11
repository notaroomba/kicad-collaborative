-- The stored-projects interface: a Trash (deleting a project is undoable for 30 days)
-- and per-user stars.

-- Set when the owner deletes the project.  A trashed project is invisible everywhere
-- (persist::get_project filters it) until it is restored or purged.
ALTER TABLE projects ADD COLUMN deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS projects_deleted_idx ON projects (deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE project_stars (
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, project_id)
);

-- Set when the owner picks a member's role by hand: a share link opened later
-- does not raise it again (a demotion to viewer has to stick).
ALTER TABLE permissions ADD COLUMN role_pinned boolean NOT NULL DEFAULT false;

-- An owner who once opened their own share link got a membership row for their
-- own project, and showed up twice in the access list.
DELETE FROM permissions p USING projects j WHERE j.id = p.project_id AND p.user_id = j.owner_id;
