# Unified accounts and service accounts

Every actor (user, agent, service account) is now one `accounts` row, and a new
feature builds on it: **service accounts**, non-human accounts with a name,
description, avatar, their own API keys and roles (Administration > Service
accounts). Design: [unified accounts](../architecture/accounts-redesign.md);
API: [service accounts](../api/service-accounts.md).

## Upgrade impact

- Migration `000066_unified_accounts.sql` moves name, description, avatar and
  the soft-delete flag from `users` and `agents` to `accounts`, replaces
  `role_attachments.principal_type/principal_id` and
  `project_members.user_id/agent_id/member_type` with `account_id`, and drops
  the legacy `users.role_id`, `agents.global_role_id` and
  `project_members.project_role_id`. **It is irreversible.** Role attachments
  whose user or agent no longer exists are dropped (the migration prints how
  many).
- **`AGENT_API_KEY` is gone** (API, agent-runner `PACA_API_KEY`, Helm
  `secrets.agentApiKey`, the installer). It is ignored if still set. An agent
  now authenticates with its own API key and is judged by its own roles only;
  `X-Agent-ID` and `X-Actor-User-ID` headers are ignored. Anything that called
  the API with the shared key must use a real account's key instead.
- **An agent never borrows a person's permissions.** A global agent chatting
  with someone used to attribute some actions (for example creating a project)
  to that person; it now acts, and is attributed, as itself, and needs roles
  that allow what it does.
- Agent-runner sandboxes get the agent's own key (`PACA_API_KEY`); existing
  environments are recreated once to pick it up. The `MCP key` an ACP agent
  already had keeps working.
- Usernames and emails stay unique among live users, and agent handles unique
  per project (workspace-wide for global agents); this is now enforced by a
  trigger instead of partial indexes.
- Plugins cannot write the new `accounts` table (like `users` and `role_attachments`).
- First-party plugins that read core tables must be updated: time-logging, webhook
  and dashboard (the "Open tasks by assignee" preset) queried `users.full_name`,
  `agents.name` and `project_members.user_id/agent_id`. Their current sources use
  `accounts` and `project_members.account_id`, and need a core that includes this
  migration (`minCoreVersion`). The dashboard plugin migrates saved panels that
  still hold the unchanged preset query; a panel a user edited by hand has to be
  adapted by them. Plugin SQL that still names a dropped column fails with a
  query error.
- Built-in `ADMIN` does not get the new `service_accounts:*` actions; grant them
  through a role if needed.
