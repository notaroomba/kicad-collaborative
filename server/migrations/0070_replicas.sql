-- Running more than one server replica (src/relay.rs).

-- In-flight sign-in state: OAuth states and the one-time codes of the desktop and
-- cross-host flows.  A sign-in spans several requests and each may reach a different
-- replica, so this cannot live in one process's memory.  Rows are consumed on use and
-- swept after ten minutes.
CREATE TABLE auth_pending (
    kind     TEXT NOT NULL,
    key      TEXT NOT NULL,
    payload  JSONB NOT NULL,
    created  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (kind, key)
);

-- Replicas talk to each other with NOTIFY, whose payload is limited to 8000 bytes.  A
-- message that does not fit (a large presence state, a long comment) is parked here and
-- the notification carries its id.  Nothing in it outlives a minute, so it is unlogged.
CREATE UNLOGGED TABLE relay_overflow (
    id       BIGSERIAL PRIMARY KEY,
    payload  TEXT NOT NULL,
    created  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cursor colours are dealt round-robin; one sequence for all replicas keeps two people who
-- meet in a document through different replicas from being dealt the same one.
CREATE SEQUENCE peer_color_seq;
