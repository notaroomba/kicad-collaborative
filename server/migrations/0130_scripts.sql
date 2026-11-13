-- Python scripts kept with a project (run_python's `script`): a script is sent once, then run again by name or
-- with a few replacements, so an assistant does not resend the whole text on every run.

CREATE TABLE IF NOT EXISTS project_scripts (
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    code       TEXT NOT NULL,
    updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, name)
);
