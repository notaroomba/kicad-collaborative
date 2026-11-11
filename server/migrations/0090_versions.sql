-- Version history and branches.
--
-- A version is a point in a project's history that is kept for good.  The server
-- stores a document as whole-file snapshots (written by the desktop editors) and a
-- journal of ops after them; it never builds a file itself, so a version of one
-- document is "the snapshot at snap_seq with the ops up to seq laid over it".
-- snap_seq = seq when a snapshot sits exactly on the point.
CREATE TABLE versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- NULL for versions the server keeps by itself (kind 'auto').
  name        text,
  description text NOT NULL DEFAULT '',
  -- named: somebody saved it.  auto: kept before a restore, a merge or a pull so
  -- the step can be taken back.
  kind        text NOT NULL DEFAULT 'named' CHECK (kind IN ('named','auto')),
  author_id   bigint REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX versions_project_idx ON versions (project_id, created_at DESC);

CREATE TABLE version_docs (
  version_id  uuid NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  doc_id      uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  path        text NOT NULL,
  snap_seq    bigint NOT NULL,
  seq         bigint NOT NULL,
  PRIMARY KEY (version_id, doc_id),
  CHECK (seq >= snap_seq)
);
CREATE INDEX version_docs_doc_idx ON version_docs (doc_id);

-- The checkpoints that already exist (named snapshots) become versions.  'cloned'
-- is the label a copied project's first snapshot carries, not a checkpoint.
INSERT INTO versions (project_id, name, created_at)
SELECT d.project_id, s.name, MIN(s.created_at)
FROM snapshots s JOIN documents d ON d.id = s.doc_id
WHERE s.name IS NOT NULL AND s.name <> 'cloned'
GROUP BY d.project_id, s.name;

INSERT INTO version_docs (version_id, doc_id, path, snap_seq, seq)
SELECT v.id, s.doc_id, d.path, MAX(s.seq), MAX(s.seq)
FROM versions v
JOIN documents d ON d.project_id = v.project_id
JOIN snapshots s ON s.doc_id = d.id AND s.name = v.name
GROUP BY v.id, s.doc_id, d.path;

-- A branch is a project of its own that hangs off the one it was taken from: the
-- same files under the same paths, edited apart from the main line.  Access is the
-- parent's; a branch never appears in a project list.
ALTER TABLE projects ADD COLUMN parent_id uuid REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE projects ADD COLUMN branch_name text;
ALTER TABLE projects ADD COLUMN branch_created_by bigint REFERENCES users(id);
ALTER TABLE projects ADD COLUMN branch_merged_at timestamptz;
CREATE INDEX projects_parent_idx ON projects (parent_id) WHERE parent_id IS NOT NULL;
CREATE UNIQUE INDEX projects_branch_name_idx ON projects (parent_id, lower(branch_name))
  WHERE parent_id IS NOT NULL AND deleted_at IS NULL;

-- How each document of a branch relates to the one it was taken from.  The branch
-- document starts as a copy that keeps the parent's sequence numbers up to fork_seq.
--   merged_seq: the branch's ops up to here are already in the parent.
--   synced_seq: the parent's ops up to here are already in the branch.
CREATE TABLE branch_docs (
  doc_id        uuid PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  parent_doc_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  fork_seq      bigint NOT NULL,
  merged_seq    bigint NOT NULL,
  synced_seq    bigint NOT NULL
);
CREATE INDEX branch_docs_parent_idx ON branch_docs (parent_doc_id);
