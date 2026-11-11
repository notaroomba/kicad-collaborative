-- The design assistant (src/ai.rs).

-- A person's own Anthropic API key, used instead of the server's.  AES-GCM
-- encrypted with a key derived from JWT_SECRET, like the GitHub tokens, so a
-- database dump alone does not expose it.  `hint` is the last four characters,
-- so the settings can show which key is stored without decrypting it.
CREATE TABLE ai_keys (
    user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    key        BYTEA NOT NULL,
    hint       TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Requests and tokens per person per day: the daily allowance on the server's
-- key, and a record of what the assistant costs.
CREATE TABLE ai_usage (
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day           DATE NOT NULL,
    requests      INTEGER NOT NULL DEFAULT 0,
    input_tokens  BIGINT NOT NULL DEFAULT 0,
    output_tokens BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
);
