-- GitHub sync: optionally push to the linked branch whenever a checkpoint is saved.
ALTER TABLE project_github
    ADD COLUMN IF NOT EXISTS auto_push BOOLEAN NOT NULL DEFAULT false,
    -- What the last automatic push did: {"ok", "message", "at", "by", "commit"}.
    ADD COLUMN IF NOT EXISTS last_auto JSONB;
