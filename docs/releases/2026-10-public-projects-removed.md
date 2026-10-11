# Public projects removed

Projects can no longer be made public. Every `/projects/{projectId}/...` route
now requires a signed-in caller whose roles allow the action.

## Upgrade impact

- Migration `000065_drop_project_is_public.sql` drops `projects.is_public` and
  its data. **It is irreversible.** Projects that were public become
  members-only, and anonymous visitors get `401`.
- Before upgrading, list the affected projects:

  ```sql
  SELECT id, name FROM projects WHERE is_public AND deleted_at IS NULL;
  ```

- A malformed `X-Agent-ID` header on a project route is now rejected with `401`
  instead of being ignored, like on every other authenticated route.
- The `is_public` field is gone from the project create/update/read API. Clients
  that still send it have it ignored.

## Authorization fix

A `Deny` (for example `tasks:read`) on a project is now honoured for tasks
fetched by id, and for their activities, links and attachments. Previously a
caller with workspace-wide `projects:read` (the built-in `ADMIN`, or `*` on `*`)
bypassed it. Workspace-wide `projects:read` still lists and opens projects
(`GET /projects/{id}`) but no longer reads their contents.
