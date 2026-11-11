-- Roles and sharing: a comment-only role between viewer and editor, and the
-- per-project permission settings.
--
-- Roles: viewer (read), commenter (read and comment), editor (everything but
-- managing access); the owner is an editor who also manages.  Existing rows keep
-- the role they were given.

ALTER TABLE permissions DROP CONSTRAINT IF EXISTS permissions_role_check;
ALTER TABLE permissions ADD CONSTRAINT permissions_role_check
    CHECK (role IN ('editor', 'commenter', 'viewer'));

ALTER TABLE share_links DROP CONSTRAINT IF EXISTS share_links_role_check;
ALTER TABLE share_links ADD CONSTRAINT share_links_role_check
    CHECK (role IN ('editor', 'commenter', 'viewer'));

-- A name the owner gives a link ("for the fab house"), and how much it was used.
ALTER TABLE share_links ADD COLUMN IF NOT EXISTS label text;
ALTER TABLE share_links ADD COLUMN IF NOT EXISTS uses bigint NOT NULL DEFAULT 0;
ALTER TABLE share_links ADD COLUMN IF NOT EXISTS last_used_at timestamptz;

-- Per-project permissions.
--   public_role           what a signed-in visitor of a public project may do
--   editors_can_share     editors may invite people and make links (never above editor)
--   viewers_can_copy      viewers and commenters may download the files or make their own copy
--   links_require_signin  a view or comment link shows nothing to someone who is not signed in
ALTER TABLE projects ADD COLUMN IF NOT EXISTS public_role text NOT NULL DEFAULT 'viewer'
    CHECK (public_role IN ('viewer', 'commenter'));
ALTER TABLE projects ADD COLUMN IF NOT EXISTS editors_can_share boolean NOT NULL DEFAULT false;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS viewers_can_copy boolean NOT NULL DEFAULT true;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS links_require_signin boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS share_links_project_idx ON share_links (project_id);
