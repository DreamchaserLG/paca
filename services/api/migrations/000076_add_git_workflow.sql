-- Git workflow: attribution, triggers and runs (docs/ai-agent/git-agent-workflow.md §7, §9).

-- Which comments Paca posted and for whom. The primary way to tell "feedback on
-- my thread" from "someone else's comment" on every platform, and the
-- loop-prevention record for bot-authored comments.
CREATE TABLE IF NOT EXISTS git_comment_index (
    repository_id   UUID        NOT NULL REFERENCES git_repositories (id) ON DELETE CASCADE,
    comment_id      TEXT        NOT NULL,
    subject_kind    TEXT        NOT NULL CHECK (subject_kind IN ('issue', 'change_request')),
    subject_number  TEXT        NOT NULL,
    thread_id       TEXT        NOT NULL DEFAULT '',
    agent_id        UUID,
    conversation_id UUID,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (repository_id, comment_id)
);

CREATE INDEX IF NOT EXISTS idx_git_comment_index_subject
    ON git_comment_index (repository_id, subject_kind, subject_number);

-- The agent that opened a change request owns its feedback and CI failures.
ALTER TABLE git_change_requests ADD COLUMN IF NOT EXISTS opened_by_agent_id UUID;
ALTER TABLE git_change_requests ADD COLUMN IF NOT EXISTS opened_conversation_id UUID;

-- Per-project Git workflow settings.
CREATE TABLE IF NOT EXISTS git_project_settings (
    project_id                 UUID        PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
    -- Answers mentions of the shared bot that name no agent.
    default_responder_agent_id UUID        REFERENCES agents (id) ON DELETE SET NULL,
    paused                     BOOLEAN     NOT NULL DEFAULT FALSE,
    -- Lowest repository permission an actor needs to start an agent run.
    min_actor_permission       TEXT        NOT NULL DEFAULT 'write'
                               CHECK (min_actor_permission IN ('read', 'triage', 'write', 'maintain', 'admin')),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Which events start which agent. Absent row = the trigger's default.
CREATE TABLE IF NOT EXISTS git_agent_triggers (
    agent_id UUID    NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    kind     TEXT    NOT NULL CHECK (kind IN
             ('mention', 'own_cr_feedback', 'ci_failure', 'review_request', 'assignment', 'label', 'auto_review')),
    enabled  BOOLEAN NOT NULL DEFAULT TRUE,
    -- auto_review filters: {"branches": [...], "paths": [...], "authors": [...]}
    config   JSONB   NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (agent_id, kind)
);

-- One row per agent run an event started.
CREATE TABLE IF NOT EXISTS git_runs (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id        TEXT        NOT NULL,
    repository_id   UUID        NOT NULL REFERENCES git_repositories (id) ON DELETE CASCADE,
    agent_id        UUID        NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    trigger         TEXT        NOT NULL,
    subject_kind    TEXT        NOT NULL DEFAULT '',
    subject_number  TEXT        NOT NULL DEFAULT '',
    head_sha        TEXT        NOT NULL DEFAULT '',
    conversation_id UUID,
    -- queued | running | succeeded | failed | cancelled
    status          TEXT        NOT NULL DEFAULT 'running',
    -- Provider reference of the run's status comment/check, to update in place.
    status_ref      TEXT        NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at     TIMESTAMPTZ,
    CONSTRAINT uq_git_runs_event_agent UNIQUE (event_id, repository_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_git_runs_active ON git_runs (status) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_git_runs_subject ON git_runs (repository_id, subject_kind, subject_number, agent_id);
