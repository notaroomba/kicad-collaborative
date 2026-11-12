-- Datasheets the assistant has read: the text of each page, kept so a datasheet is
-- downloaded and parsed once and every later question about it only searches the pages.
-- Shared by everybody: the key is the document's address, the content is public.

CREATE TABLE IF NOT EXISTS datasheets (
    url_hash   TEXT PRIMARY KEY,
    url        TEXT NOT NULL,
    bytes      BIGINT NOT NULL DEFAULT 0,
    pages      TEXT[] NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
