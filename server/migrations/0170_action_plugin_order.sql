-- Preferences > PCB Editor > Action Plugins (PCBNEW_SETTINGS m_Plugins.actions): the person's order of plugin
-- actions and whether each shows a toolbar button, as [[identifier, visible], ...].  Per account, every browser.
CREATE TABLE IF NOT EXISTS plugin_action_order (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    actions JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
