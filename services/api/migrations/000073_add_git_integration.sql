-- Platform-neutral Git integration (docs/ai-agent/git-agent-workflow.md).
--
-- Core owns repositories, identities, change requests, webhook intake and audit
-- for every Git platform; a provider plugin (GitHub, GitLab, …) only adapts one
-- platform to the Git Provider SPI. Provider-private material (private keys,
-- tokens, installation ids beyond the opaque provider_ref) lives in the
-- provider plugin's own schema, never here.

-- A bot identity on a platform host: the shared one for the host, or one agent's
-- own. The secret behind it stays with the provider plugin.
CREATE TABLE IF NOT EXISTS git_identities (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id  TEXT        NOT NULL,            -- plugin id, e.g. com.paca.github
    host         TEXT        NOT NULL,            -- e.g. github.com, gitlab.acme.com
    -- The provider's own id for this identity (IdentityRef.ID); with provider_ref
    -- it is everything the provider needs handed back on every call.
    provider_identity_id TEXT NOT NULL,
    kind         TEXT        NOT NULL CHECK (kind IN ('app', 'bot_user', 'token')),
    scope        TEXT        NOT NULL CHECK (scope IN ('shared', 'agent')),
    handle       TEXT        NOT NULL DEFAULT '', -- what users @mention
    display_name TEXT        NOT NULL DEFAULT '',
    provider_ref JSONB       NOT NULL DEFAULT '{}'::jsonb,
    expires_at   TIMESTAMPTZ,                     -- credential expiry, when the platform has one
    created_by   UUID,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One shared identity per provider host.
CREATE UNIQUE INDEX IF NOT EXISTS uq_git_identities_shared_host
    ON git_identities (provider_id, host) WHERE scope = 'shared';

-- An agent's own identity, at most one per provider.
CREATE TABLE IF NOT EXISTS git_agent_identities (
    agent_id    UUID NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    provider_id TEXT NOT NULL,
    identity_id UUID NOT NULL REFERENCES git_identities (id) ON DELETE CASCADE,
    PRIMARY KEY (agent_id, provider_id)
);

-- A repository linked to a project. Events for it are routed to that project.
CREATE TABLE IF NOT EXISTS git_repositories (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id     UUID        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    provider_id    TEXT        NOT NULL,
    host           TEXT        NOT NULL,
    external_id    TEXT        NOT NULL DEFAULT '',
    full_path      TEXT        NOT NULL,          -- owner/name or group/subgroup/project
    default_branch TEXT        NOT NULL DEFAULT 'main',
    clone_url      TEXT        NOT NULL DEFAULT '', -- https, never carries credentials
    identity_id    UUID        REFERENCES git_identities (id) ON DELETE SET NULL,
    provider_ref   JSONB       NOT NULL DEFAULT '{}'::jsonb,
    webhook_ref    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_by     UUID,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_git_repositories_project_path UNIQUE (project_id, provider_id, host, full_path)
);

CREATE INDEX IF NOT EXISTS idx_git_repositories_lookup
    ON git_repositories (provider_id, host, lower(full_path));

-- Where a platform delivers webhooks for one identity. The key is unguessable
-- and appears in the URL; the signature check is still the provider's job. An
-- endpoint is created when identity setup starts (the platform needs the URL
-- first) and bound to the identity when setup completes, so identity_id is
-- NULL for a pending one; webhook secrets live with the provider, not here.
CREATE TABLE IF NOT EXISTS git_webhook_endpoints (
    key         TEXT        PRIMARY KEY,
    provider_id TEXT        NOT NULL,
    identity_id UUID        REFERENCES git_identities (id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every normalized event a delivery produced, one row per linked repository it
-- fans out to. The primary key makes redelivery idempotent.
CREATE TABLE IF NOT EXISTS git_event_inbox (
    event_id      TEXT        NOT NULL,
    repository_id UUID        NOT NULL REFERENCES git_repositories (id) ON DELETE CASCADE,
    endpoint_key  TEXT        NOT NULL,
    kind          TEXT        NOT NULL,
    action        TEXT        NOT NULL DEFAULT '',
    payload       JSONB       NOT NULL,
    status        TEXT        NOT NULL DEFAULT 'received'
                  CHECK (status IN ('received', 'ignored', 'routed', 'failed')),
    reason        TEXT        NOT NULL DEFAULT '',
    received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at  TIMESTAMPTZ,
    PRIMARY KEY (event_id, repository_id)
);

CREATE INDEX IF NOT EXISTS idx_git_event_inbox_received ON git_event_inbox (received_at);
CREATE INDEX IF NOT EXISTS idx_git_event_inbox_pending ON git_event_inbox (status) WHERE status = 'received';

-- Cache of change requests (pull/merge requests) seen on linked repositories.
CREATE TABLE IF NOT EXISTS git_change_requests (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id UUID        NOT NULL REFERENCES git_repositories (id) ON DELETE CASCADE,
    number        TEXT        NOT NULL,
    title         TEXT        NOT NULL DEFAULT '',
    state         TEXT        NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed', 'merged')),
    draft         BOOLEAN     NOT NULL DEFAULT FALSE,
    head_ref      TEXT        NOT NULL DEFAULT '',
    head_sha      TEXT        NOT NULL DEFAULT '',
    base_ref      TEXT        NOT NULL DEFAULT '',
    author        TEXT        NOT NULL DEFAULT '',
    html_url      TEXT        NOT NULL DEFAULT '',
    merged_at     TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_git_change_requests_repo_number UNIQUE (repository_id, number)
);

CREATE TABLE IF NOT EXISTS git_task_links (
    task_id           UUID        NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    change_request_id UUID        NOT NULL REFERENCES git_change_requests (id) ON DELETE CASCADE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (task_id, change_request_id)
);

CREATE INDEX IF NOT EXISTS idx_git_task_links_cr ON git_task_links (change_request_id);

CREATE TABLE IF NOT EXISTS git_task_branches (
    task_id       UUID        NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    repository_id UUID        NOT NULL REFERENCES git_repositories (id) ON DELETE CASCADE,
    branch_name   TEXT        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (task_id, repository_id, branch_name)
);

-- Audit of what agents did through the Git tools and credential service.
CREATE TABLE IF NOT EXISTS git_action_log (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID        REFERENCES projects (id) ON DELETE CASCADE,
    repository_id   UUID        REFERENCES git_repositories (id) ON DELETE SET NULL,
    conversation_id UUID,
    actor_account_id UUID,
    tool            TEXT        NOT NULL,
    subject         TEXT        NOT NULL DEFAULT '',
    ok              BOOLEAN     NOT NULL,
    detail          TEXT        NOT NULL DEFAULT '',
    at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_git_action_log_project_at ON git_action_log (project_id, at DESC);
