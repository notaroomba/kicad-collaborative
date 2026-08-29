-- Client-rendered SVG previews: editors plot the board with KiCad's own
-- plotter and push the result, so the server needs no KiCad install.  Only
-- the latest preview per (doc, variant) is kept.
CREATE TABLE doc_previews (
    doc_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    fit        BOOLEAN NOT NULL,
    seq        BIGINT NOT NULL,
    svg        BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (doc_id, fit)
);
