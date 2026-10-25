-- One row per "grant this identity access to another account or organization"
-- attempt (for GitHub: installing the App on the owner of a repository a project
-- wants to link). Like git_setup_sessions it ties the provider's opaque state to
-- the user who started it, so the platform's redirect can be completed only by
-- that user, once, for the project it was started from.
CREATE TABLE IF NOT EXISTS git_access_sessions (
    state        TEXT        PRIMARY KEY,
    provider_id  TEXT        NOT NULL,
    identity_id  UUID        NOT NULL REFERENCES git_identities (id) ON DELETE CASCADE,
    project_id   UUID        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    owner        TEXT        NOT NULL DEFAULT '',
    return_url   TEXT        NOT NULL DEFAULT '',
    created_by   UUID        NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_git_access_sessions_expires_at ON git_access_sessions (expires_at);
