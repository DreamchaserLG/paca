-- 000065_drop_project_is_public.sql
-- Public projects are gone: every project route needs a signed-in caller whose
-- roles allow the action (docs/architecture/authorization.md). The flag was
-- only ever read to let anonymous visitors in, so it is dropped with its data.
ALTER TABLE projects DROP COLUMN IF EXISTS is_public;
