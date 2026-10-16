-- 000069_custom_field_use_in_search.sql
-- Issue #576: lets a project mark a custom field as searchable, so the task
-- search box also matches the value stored in that field (tracking numbers,
-- client ids, ...).

BEGIN;

ALTER TABLE custom_field_definitions
    ADD COLUMN use_in_search BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
