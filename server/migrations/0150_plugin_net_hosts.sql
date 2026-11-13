-- Web addresses a person let one of their plugins reach although the plugin's own code does not name
-- them: the server of a self-hosted service whose address the person typed into the plugin (a
-- KiComLib library server).  One row per person, plugin and host name; the server still carries
-- only https requests to public internet addresses.  Uninstalling the plugin forgets them.
CREATE TABLE IF NOT EXISTS plugin_net_hosts (
    user_id     BIGINT NOT NULL,
    identifier  TEXT NOT NULL,
    host        TEXT NOT NULL,
    approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, identifier, host),
    FOREIGN KEY (user_id, identifier) REFERENCES plugins(user_id, identifier) ON DELETE CASCADE
);
