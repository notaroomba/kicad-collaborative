CREATE TABLE users (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  github_id   bigint UNIQUE NOT NULL,
  login       text NOT NULL,
  name        text,
  email       text,
  avatar_url  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    bigint NOT NULL REFERENCES users(id),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path        text NOT NULL,
  doc_type    text NOT NULL,
  format_ver  text,
  UNIQUE (project_id, path)
);

CREATE TABLE ops (
  doc_id       uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq          bigint NOT NULL,
  author_id    bigint NOT NULL REFERENCES users(id),
  client_id    text NOT NULL,
  client_op_id text NOT NULL,
  base_seq     bigint,
  changes      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_id, seq),
  UNIQUE (doc_id, client_id, client_op_id)
);

CREATE TABLE snapshots (
  doc_id      uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq         bigint NOT NULL,
  content     bytea NOT NULL,
  name        text,
  uploader_id bigint REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_id, seq)
);

CREATE TABLE permissions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id       bigint REFERENCES users(id),
  invited_login text,
  invited_email text,
  role          text NOT NULL CHECK (role IN ('editor','viewer')),
  created_by    bigint REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, user_id),
  CHECK (user_id IS NOT NULL OR invited_login IS NOT NULL OR invited_email IS NOT NULL)
);

CREATE TABLE share_links (
  token       text PRIMARY KEY,
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('editor','viewer')),
  created_by  bigint NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  revoked_at  timestamptz
);

CREATE INDEX ops_created_at_idx ON ops (created_at);
CREATE INDEX permissions_pending_login_idx ON permissions (invited_login) WHERE user_id IS NULL;
CREATE INDEX permissions_pending_email_idx ON permissions (invited_email) WHERE user_id IS NULL;
