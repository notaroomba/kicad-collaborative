-- Pinned comment threads on documents (the Figma comments model): a root
-- comment carries a board/schematic position in nanometres; replies reference
-- the root and carry no position of their own.
CREATE TABLE comments (
    id         BIGSERIAL PRIMARY KEY,
    doc_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    parent_id  BIGINT REFERENCES comments(id) ON DELETE CASCADE,
    author_id  BIGINT NOT NULL REFERENCES users(id),
    x_nm       BIGINT NOT NULL DEFAULT 0,
    y_nm       BIGINT NOT NULL DEFAULT 0,
    body       TEXT NOT NULL,
    resolved   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX comments_doc_idx ON comments (doc_id, id);
