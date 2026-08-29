-- Public (gallery-visible) projects. Private by default; the owner opts in.

ALTER TABLE projects ADD COLUMN public boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS projects_public_idx ON projects (public) WHERE public;
