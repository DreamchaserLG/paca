-- Two invariants the Git workflow relied on only in application code.

-- One unfinished run per agent and subject. The router checks before it
-- creates, but two replicas can both pass the check; the database refuses the
-- second. Older duplicates (there should be none) are cancelled first so the
-- index can be built.
UPDATE git_runs SET status = 'cancelled', finished_at = NOW()
WHERE id IN (
    SELECT id FROM (
        SELECT id, row_number() OVER (
            PARTITION BY repository_id, agent_id, subject_kind, subject_number ORDER BY created_at DESC) AS rn
        FROM git_runs
        WHERE status IN ('queued', 'running') AND subject_number <> ''
    ) ranked WHERE rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_git_runs_active_subject
    ON git_runs (repository_id, agent_id, subject_kind, subject_number)
    WHERE status IN ('queued', 'running') AND subject_number <> '';

-- A repository path is case-insensitive on every platform, and the webhook
-- lookup already compares lower(full_path): "Acme/Web" and "acme/web" must not
-- be linkable twice, or one delivery fans out twice. The newest duplicate wins
-- the cleanup only if one exists.
DELETE FROM git_repositories
WHERE id IN (
    SELECT id FROM (
        SELECT id, row_number() OVER (
            PARTITION BY project_id, provider_id, host, lower(full_path) ORDER BY created_at, id) AS rn
        FROM git_repositories
    ) ranked WHERE rn > 1
);

ALTER TABLE git_repositories DROP CONSTRAINT IF EXISTS uq_git_repositories_project_path;
CREATE UNIQUE INDEX IF NOT EXISTS uq_git_repositories_project_path
    ON git_repositories (project_id, provider_id, host, lower(full_path));
