-- 000069_custom_field_use_in_search.sql
-- Issue #576: lets a project mark a custom field as searchable, so the task
-- search box also matches the value stored in that field (tracking numbers,
-- client ids, ...). Idempotent: every migration re-runs on startup.

BEGIN;

ALTER TABLE custom_field_definitions
    ADD COLUMN IF NOT EXISTS use_in_search BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
