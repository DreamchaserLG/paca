-- One row per identity-setup attempt driven through a Git provider plugin
-- (create the bot identity on the platform, install it, ...). The provider
-- hands back an opaque `state`; this row ties it to the user who started the
-- flow, the scope it is for and the webhook endpoint it will own, so the
-- browser callback can be completed only by that user, once.
CREATE TABLE IF NOT EXISTS git_setup_sessions (
    state        TEXT        PRIMARY KEY,
    provider_id  TEXT        NOT NULL,
    host         TEXT        NOT NULL,
    scope        TEXT        NOT NULL CHECK (scope IN ('shared', 'agent')),
    agent_id     UUID        REFERENCES agents (id) ON DELETE CASCADE,
    endpoint_key TEXT        NOT NULL REFERENCES git_webhook_endpoints (key) ON DELETE CASCADE,
    return_url   TEXT        NOT NULL DEFAULT '',
    created_by   UUID        NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((scope = 'agent') = (agent_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_git_setup_sessions_expires_at ON git_setup_sessions (expires_at);
