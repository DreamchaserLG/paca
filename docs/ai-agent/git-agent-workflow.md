# Git Agent Workflow — Design (platform-neutral)

**Status: Proposal.** Redesigns how Paca agents work with source-control platforms so that they behave like other agent-bot products (GitHub Copilot's coding agent, Pullfrog, Tembo, Claude Code's GitHub app): connect an identity to a repository, mention it or hand it work on a pull/merge request or issue, watch it reply, push, review and fix CI — every action attributed to a bot identity and bounded by least-privilege credentials.

**Paca is for teams on any Git platform.** GitHub is the first provider, not the model. The design therefore puts everything that is *not* platform-specific in **Paca core** (triggers, routing, policy, runs, audit, MCP tools, workspace protocol, UI) and defines a small **Git Provider SPI** that a plugin implements for one platform. Adding GitLab, Bitbucket, Gitea or Azure DevOps means writing an adapter against the SPI and passing a conformance suite — not re-implementing the workflow.

This document supersedes [repository-plugin-adapter.md](repository-plugin-adapter.md) for the agent/Git workflow. Related: [overview.md](overview.md), [environment-management.md](environment-management.md), [../plugins/overview.md](../plugins/overview.md).

## Table of Contents

1. [Goals and decisions](#1-goals-and-decisions)
2. [Where we are today](#2-where-we-are-today)
3. [Architecture: core + providers](#3-architecture-core--providers)
4. [Neutral vocabulary and event model](#4-neutral-vocabulary-and-event-model)
5. [Git Provider SPI](#5-git-provider-spi)
6. [Identity and credentials](#6-identity-and-credentials)
7. [Event ingestion, triggers and routing](#7-event-ingestion-triggers-and-routing)
8. [Core changes](#8-core-changes)
9. [Agent run lifecycle](#9-agent-run-lifecycle)
10. [UI](#10-ui)
11. [MCP tools](#11-mcp-tools)
12. [Workspace and static environments](#12-workspace-and-static-environments)
13. [Security model](#13-security-model)
14. [Data model](#14-data-model)
15. [Platform notes](#15-platform-notes)
16. [Phasing](#16-phasing)
17. [Risks and open questions](#17-risks-and-open-questions)

---

## 1. Goals and decisions

| # | Decision |
|---|---|
| D1 | **Platform-neutral core.** A new core "Git integration" domain owns repositories, change requests, events, triggers, routing, runs, policy and audit. Provider plugins only adapt one platform to the SPI (§5). |
| D2 | **One shared identity per provider host.** For each platform host an instance uses (`github.com`, `gitlab.acme.com`, `bitbucket.org`, …) there is one *shared identity* — a GitHub App, a GitLab bot user, a Bitbucket access token — available to every project. No per-project identity choice, no "available to every project" switch. A project participates by **linking repositories**. |
| D3 | **Linked repositories are the event boundary.** For every repository a project links, Paca receives all change-request / branch / comment / review / check events through the provider and routes them to that project. Unlinked repositories are ignored. |
| D4 | **Agents without their own identity act through the shared identity.** Attribution to the specific agent is carried by a footer and a core-side comment index (§9.3). |
| D5 | **An agent may have its own identity** (own bot name/avatar/handle), created from the agent's page. The provider plugin supplies the *setup* UI; core supplies the surrounding page (§10). |
| D6 | **Triggers behave like bot products:** mention, label, review-request/assignment where the platform allows it, plus opt-in rules (auto-review new change requests, address review feedback and fix CI on the agent's own ones). Which are available is declared by provider *capabilities* (§5.3), never assumed. |
| D7 | **Git and platform actions are core MCP tools with neutral names** (`change_request_*`, `review_*`, `workspace_*`, …). The same skill/prompt works on any platform; the plugin never contributes its own agent tools. Policy is enforced in core, once. |
| D8 | **The agent decides about the workspace.** Paca does not clone for it; the agent inspects the working folder, decides whether the repository is there, and fetches/checks out/pulls the branch it needs (§12). |
| D9 | **Credentials never reach the sandbox.** Short-lived where the platform supports it; where it does not, the secret stays in the provider plugin and is handed to git per invocation through a credential helper (§6.3). |
| D10 | **No PAT/token connections and no legacy path.** The old GitHub plugin used personal access tokens that cannot back a provider identity, so its data is not migrated: it is dropped, and every connection is a provider identity (GitHub: App installation). |

Non-goals: replacing the Paca task model; running agents inside the platform's CI runners; supporting platforms without webhooks or an HTTP API.

---

## 2. Where we are today

| Area | Today | Change |
|---|---|---|
| Ownership | The GitHub plugin owns everything: repos, PR cache, task links, webhook handling, UI, MCP tools. A second platform would copy all of it. | Core owns the neutral domain; the plugin shrinks to an adapter (§3). |
| App/identity | Many GitHub Apps; installations bound per project behind an allow-list; `github_agent_identities` maps accounts to installations. | One shared identity per provider host; optional per-agent identity (§6). |
| Events | Webhook handles `pull_request` and `push` only. | Full normalized event set routed to agents (§7). |
| Agent triggered from the platform | Impossible: plugins cannot start agent runs. | New host capability (§8.2). |
| Clone / push | `clone_repository` runs `git clone https://x-access-token:<token>@…`; **git persists that URL in `.git/config` (`remote.origin.url`)**, so in a long-lived static environment a token stays readable on disk. Output scrubbing does not help. | Credential helper; remotes are always token-free (§6.3, §11.3). |
| Workspace | `clone_repository` refuses non-empty targets; no branch selection, no pre-pull. | Workspace tools and the agent-decides protocol (§12). |
| Tools | `github_*` tools contributed by the plugin; names and shapes are GitHub-specific. | Neutral core tools (§11). |
| Agent UI | Fixed tab union in `agent-detail.tsx`; fixed wizard in `create-agent-dialog.tsx`. | Core Git tab + new extension points (§8.1, §10). |

---

## 3. Architecture: core + providers

```
                    GitHub / GitLab / Bitbucket / Gitea / …
                         │ webhooks                 ▲ REST / git over HTTPS
                         ▼                          │
 ┌──────────────────────────────────────┐   ┌──────────────────────────────┐
 │ services/api — Git integration (core)│   │ Provider plugin (WASM)       │
 │  • public webhook endpoint           │──►│  VerifyAndParseWebhook       │
 │  • inbox, dedupe, replay protection  │   │  MintCredential              │
 │  • Router: event → agent run         │◄──│  GetChangeRequest, Diff, …   │
 │  • Policy, caps, audit (IAM actions) │   │  OpenChangeRequest, Review…  │
 │  • repositories, change requests,    │   │  setup (identity/OAuth/app)  │
 │    task links, runs, comment index   │   │  + setup UI (extension point)│
 └──────┬───────────────────────────────┘   └──────────────────────────────┘
        │ start run (existing dispatch)            ▲
        ▼                                          │ provider ops (internal calls)
 agent-runner ── sandbox ── Paca MCP (core tools: change_request_*, review_*, workspace_*)
```

**Core owns** (written once): webhook endpoint and inbox; event normalization *contract*; trigger configuration and routing; actor-permission policy; run lifecycle, status comments, debounce, caps; change-request/branch cache and task linking; the MCP tools; the workspace/credential-helper protocol; audit; every UI except provider-specific setup.

**A provider owns** (per platform): signature verification and payload parsing; the API calls; how an identity is created and how credentials are minted; how a repository is addressed; the setup UI.

This split is what makes a new provider cheap: roughly 25 small, typed operations (§5.2), most mapping one-to-one to a REST endpoint, plus a conformance suite that tells the author whether they are done.

---

## 4. Neutral vocabulary and event model

| Neutral term | GitHub | GitLab | Bitbucket Cloud |
|---|---|---|---|
| Repository | repository | project | repository |
| Change request (CR) | pull request | merge request | pull request |
| Review | review | approval + discussion notes | approval + comments |
| Thread | review thread | discussion | comment thread |
| Check | check run / status | pipeline / job / status | build status / pipeline |
| Subject | issue \| CR | issue \| MR | issue \| PR |
| Identity | GitHub App | bot user (access token) | access token / app |

**Repository reference** (stable across platforms): `{provider_id, host, external_id, full_path, default_branch}` — `full_path` is `owner/name` or `group/subgroup/project` (GitLab nests).

**Permission** is a neutral ordered enum: `none < read < triage < write < maintain < admin`. Each provider maps its own roles (GitLab: Guest→read, Reporter→triage, Developer→write, Maintainer→maintain, Owner→admin).

### 4.1 Normalized event

```json
{
  "id": "<unique per delivery>",
  "provider_id": "com.paca.github", "host": "github.com",
  "kind": "comment | change_request | review | check | push | label | assignment | review_request",
  "action": "created | edited | opened | ready | synchronized | closed | merged | submitted | completed | …",
  "repo": {"full_path": "acme/web", "external_id": "…", "default_branch": "main"},
  "subject": {"kind": "issue | change_request", "number": "42",
              "head": {"ref": "feat/x", "sha": "…", "from_fork": false}, "base": "main", "draft": false},
  "actor": {"login": "octocat", "kind": "user | bot", "permission": "write"},
  "text": "…comment/review/issue body — UNTRUSTED…",
  "location": {"path": "src/a.ts", "line": 17, "thread_id": "…", "comment_id": "…"},
  "check": {"name": "ci/test", "conclusion": "failure", "run_id": "…"},
  "addressed": [{"identity_id": "…", "via": "mention | review_request | assignment | label"}],
  "raw_ref": "provider-private id for debugging; never sent to agents"
}
```

Design points that keep the core neutral:

* **"Was a bot addressed?" is decided by the provider** (`addressed[]`), because mention syntax differs per platform (`@slug[bot]`, `@bot-user`, `@{account_id}`). Core only sees *which identity* was addressed and *how*.
* **`actor.permission` is resolved by the provider** through its API (never trusted from the payload) and cached by core.
* Events the provider cannot map are dropped with a logged `unmapped` reason, not guessed.

---

## 5. Git Provider SPI

### 5.1 Packaging

A provider is a normal plugin that declares the capability `git-provider` and a `gitProvider` block in `plugin.json`; the Go SDK (`plugin-sdk-go`) gets a `gitprovider` package with the `Provider` interface and a `plugintest/gitprovider` **conformance suite** (a recorded-fixture harness: given canned webhook payloads and a fake HTTP server, assert normalized events, error mapping, and capability honesty). A **reference fake provider** ships with the SDK as documentation by example and as core's own integration-test double.

```json
"gitProvider": {
  "id": "com.paca.github", "displayName": "GitHub", "icon": "github",
  "hosts": ["github.com"], "selfHostedHosts": true,
  "identityKinds": ["app"], "credentialModel": "ephemeral",
  "capabilities": { "...see 5.3..." },
  "setup": { "identity": "manifest_flow" }
}
```

Core calls provider operations as **internal-only plugin routes** (`/_git/<op>`, mounted by the host, unreachable from browsers, callable only by core services and by the MCP server on behalf of an authenticated agent after core's checks). Operation payloads are versioned JSON (`gitprovider.v1`); the SDK wraps them into the Go interface so authors never see routes.

### 5.2 Operations

Required unless marked *(opt)*. Anything unsupported returns `ErrUnsupported`, and the matching capability flag is `false` so core hides it.

| Group | Operation | Notes |
|---|---|---|
| Describe | `Describe()` | info + capabilities (static). |
| Setup | `BeginIdentitySetup(scope, params)` → `SetupStep` | Returns the next step to show/perform: `redirect`, `form_post` (manifest flow), `token_form`, `done`. A `token_form` step lists its inputs in `Form` (name, label, help, secret, required) — static-credential platforms usually want a read-only **and** a write token (S4). |
| | `CompleteIdentitySetup(params)` → `Identity` | Called from the setup callback page or on form submit. `Identity.ExpiresAt` reports credential expiry so core can warn before an identity stops working (S4). |
| | `DeleteIdentity(identity)` *(opt)* | Remote cleanup where an API exists. |
| Repos | `ListRepositories(identity, query)` | For the picker; paged. |
| | `ResolveRepository(url \| path)` | Normalizes a URL/path to a repository reference and the identity that can see it. |
| Webhooks | `VerifyAndParseWebhook(request)` → `[]Event` | Signature/secret check + normalization (§4.1). The **only** place a platform's webhook format lives. |
| | `EnsureWebhook(repo, url, secret)` / `RemoveWebhook(repo)` *(opt)* | Only for `webhookScope: repo \| group` platforms. App-level platforms need nothing. |
| Credentials | `MintCredential(identity, repo, access, ttl)` → `Credential{username, secret, expires_at}` | `access ∈ read \| write`. Ephemeral platforms down-scope to the repo; static platforms return the stored secret (never leaves core's credential service, §6.3). |
| Actor | `GetActorPermission(repo, login)` → `Permission` | |
| | `GetBranchProtection(repo, branch)` → `{protected, require_reviews, …}` | Used by push/merge policy. |
| Read | `GetChangeRequest`, `ListChangedFiles`, `GetDiff(file?)` | One neutral shape; large diffs paged. |
| | `ListThreads(cr)`, `ListComments(subject)` | Includes bot authors; marks `resolved`/`outdated`. |
| | `GetIssue(n)` | |
| | `GetChecks(ref)`, `GetCheckLogs(check, tail)` | Provider maps its CI model (check runs / pipelines / statuses) to `{name, state, required, url}`. |
| | `GetFile(ref, path)`, `SearchCode(query)` *(opt)* | Lets review agents work without a checkout. |
| Write | `OpenChangeRequest`, `UpdateChangeRequest` | `draft`, labels, reviewers, linked issue. |
| | `Comment(subject, body)` → comment id | Core appends footer; provider posts as-is and returns the id. |
| | `ReplyThread`, `ResolveThread` *(opt)* | |
| | `SubmitReview(cr, verdict, summary, comments[])` | `verdict ∈ comment \| approve \| request_changes`. Providers without batch review **emulate** (post comments, then a summary); the capability `batchReview` tells core which. |
| | `SetStatus(subject, state, summary, url)` | Run state on the platform: check run, commit status or a comment, as the platform allows (`statusKind` capability). |
| | `AddLabels`, `RequestReviewers`, `Assign` *(opt)* | |
| | `RerunChecks(ref)` *(opt)*, `Merge(cr, method, expected_sha)` *(opt)* | |
| Reaction | `React(comment, emoji)` *(opt)* | Cosmetic acknowledgement. |

Cross-cutting rules for implementers: never log tokens or full payload bodies; map platform errors to the SPI error set (`NotFound`, `Forbidden`, `Conflict`, `RateLimited{retry_after}`, `Unsupported`, `Validation`, `Transient`) so core can retry/back off uniformly; **idempotent** writes where the platform allows (core passes an idempotency key); all outbound hosts must come from the provider's configured host list.

### 5.3 Capabilities

Declared in `Describe()`; core's UI, tools and router read them instead of hard-coding platform names.

| Capability | Values | Effect in core |
|---|---|---|
| `identityKinds` | `app`, `bot_user`, `token` | Which setup flows exist; per-agent identity offered only when the platform can mint more than one. |
| `credentialModel` | `ephemeral`, `static` | `static` shows a blast-radius warning and forces read/write token separation where possible (§6.3). |
| `webhookScope` | `app`, `group`, `repo` | Whether core asks the provider to `EnsureWebhook` per linked repo. |
| `triggers` | subset of `mention, label, review_request, assignment, ci_failure, own_cr_feedback, auto_review` | Trigger toggles shown/enabled. |
| `batchReview`, `resolveThreads`, `statusKind` (`check_run`, `commit_status`, `comment`) | | Tool behaviour and how run status is surfaced. |
| `hiddenMarkers` | bool | Whether HTML-comment markers survive; otherwise core relies on its comment index (§9.3). |
| `forkChangeRequests`, `draftChangeRequests`, `nestedPaths` | bool | Policy and UI details. |

---

## 6. Identity and credentials

### 6.1 Shared identity (one per provider host)

* Created once by someone holding the (renamed, provider-neutral) action `git:manage_identities`, through the provider's setup flow — for GitHub the existing Manifest Flow plus the callback page, for GitLab "create a bot user/access token" (token form), etc. Core stores a neutral `git_identities` row (`provider_id`, `host`, `kind`, `handle`, `display_name`, `scope='shared'`) and the provider keeps the secret material in its own encrypted tables.
* **Repository → identity resolution.** When a user links a repository, core asks the provider (`ResolveRepository`) which of its identities can see it (GitHub: the installation covering the owner; GitLab: the token's group/project membership) and stores `identity_id` plus the provider-private reference on the `git_repositories` row. The picker lists the union across the provider's identities.
* A project's Git tab has no identity chooser: "connected" means a shared identity exists for that host and the repository resolves. The allow-list and `allow_all_projects` are removed.

### 6.2 Agent identity (optional, per agent)

* `git_agent_identities(agent_id, provider_id → identity_id)`: an agent may have at most one own identity **per provider** (it can work on GitHub and GitLab repositories with a different bot on each).
* Created from the agent's Git tab via the provider's setup flow with the agent's name as the default handle; the provider declares whether it can mint additional identities (`identityKinds`). Events delivered via an agent identity are routed to that agent only.

### 6.3 Resolution and credentials

```
identityFor(run, repo):
   agent identity of run.agent for repo.provider, if it can see the repo   → act as it
   else the shared identity that resolved the repo                         → act as the shared bot
   else error "no Git identity for this repository"
```

Resolution is done **in core** from the agent's authenticated account; the agent never selects or sees an identity.

**Credentials.**

* *Ephemeral platforms* (GitHub App): minted per tool call (API) or per git invocation (helper), down-scoped to the repository and the minimum permission set for that action (`access: read | write`), TTL ≤ the call. **Core's credential service may cache a minted credential for ≤ 30 s, keyed by `(identity, repo, access)`, in memory only** — never persisted, never returned to an agent (S3: a mint costs ≈ 0.15–0.25 s, so a burst of fetches inside one tool call would otherwise multiply it).
* *Static platforms* (GitLab access tokens, Bitbucket access tokens): the secret never leaves core's credential service (backed by the provider plugin); **API calls are performed server-side** by the provider, so the agent never receives a reusable token for them. For `git` itself the helper receives the secret **per invocation** over a private channel and git forgets it. Recommended setup (shown in the UI) is *two* identities or tokens per repository scope — read-only for review-only agents, write for coders — selected by `access`; the UI warns when only a broad token exists.
* **Credential helper** (replaces URL-embedded tokens, platform-neutral; prototyped and verified in spike S2, `docs/ai-agent/spikes/s2-credential-helper/`): git runs with `-c credential.helper=` (reset inherited helpers) `-c credential.helper=<bundled helper> -c credential.useHttpPath=true` and `GIT_TERMINAL_PROMPT=0`; the tool sets `PACA_GIT_ACCESS=read|write` in git's environment because git does not tell a helper whether it is about to read or write (`git_push` → write, all else → read); `store`/`erase` are no-ops; the helper asks the local MCP process (private unix socket), which asks core for a credential for `(repo, access)`; core authorizes the call (§13) and returns it; the helper emits it on git's credential protocol and exits. Nothing lands in `.git/config`, `remote.<n>.url` stays `https://<host>/<path>.git`, nothing is in the environment or `ps`, and a human with SSH access to a static environment cannot read one.

---

## 7. Event ingestion, triggers and routing

### 7.1 Pipeline

```
Platform ──POST──► core: /api/v1/git/webhooks/:providerId/:endpointKey
                    1. look up the endpoint → provider, identity (endpointKey is unguessable, per identity)
                    2. provider.VerifyAndParseWebhook(request)      ← signature + normalize
                    3. replay check (event id), drop unlinked repos, update CR/branch cache
                    4. write git_event_inbox row; return 202
                    5. worker: Router → (agent, trigger) decisions → authorize actor → debounce → start run
```

The synchronous part is cheap; routing happens off the request so a slow agent start never causes a redelivery storm. Because core owns the endpoint, every provider gets replay protection, rate limiting, audit and the inbox for free.

### 7.2 Triggers (neutral)

| Trigger | Source (neutral) | Default | Provider requirement |
|---|---|---|---|
| **Mention** | `addressed[].via = mention` on a comment, review body or subject body | on | `triggers ∋ mention` |
| **Own-CR feedback** | review/comment on a CR the agent opened (comment index/marker, §9.3) | on | `own_cr_feedback` |
| **Own-CR CI failure** | `check` completed failing on the head of the agent's CR | on, capped | `ci_failure` |
| **Review requested** | `addressed[].via = review_request` | on if supported | `review_request`. **GitHub: not available** — spike S1 shows ordinary App bots are not collaborators, so the reviewer API rejects them; a *team* review request mapped to an agent is a candidate (unverified). GitLab bot users are project members, so likely available (confirm in that provider's spike). |
| **Assigned** | `addressed[].via = assignment` | on if supported | `assignment`. **GitHub: not available for ordinary Apps** (S1: `dependabot[bot]`/`github-actions[bot]` are not assignable; only GitHub's partner coding agents are). |
| **Label** | label added matching `paca` or `paca:<agent-handle>` | on | `label` — the portable stand-in for "assign to bot". |
| **Auto-review** | CR opened / ready / synchronized | **off** | `auto_review`; per-agent filters (branches, paths, authors), skip drafts and bots. |

Triggers are configured **per agent** in core (`git_agent_triggers`); the editor lists only what the agent's providers declare supported.

### 7.3 Routing for a shared identity

A mention of the shared bot is not addressed to a specific agent. Resolution order, per project that linked the repository:

1. An agent hint in the text: `@bot agent:reviewer …` (handles of agents in that project only).
2. The agent already owning the thread (comment index, §9.3).
3. A label `paca:<agent-handle>`.
4. The project's **default responder agent** (required once a repository is linked).

Events from an *agent identity* go straight to that agent. If several projects linked one repository, each gets the event independently under its own responder and rules.

---

## 8. Core changes

### 8.1 Plugin extension points

| Point | Rendered in | Props |
|---|---|---|
| `git.identity.setup` | A core dialog/panel (instance **Git providers** page, agent **Git** tab, create-agent step) — **one component per provider** that implements its setup flow (GitHub: manifest flow; GitLab: token form; …) | `{ scope: "shared" \| "agent", agentId?, host, onDone(identity), onCancel() }` |
| `agent.detail.tab` | `agent-detail.tsx` (project and admin variants) as an additional tab | `{ agentId, projectId?, scope, agentType, canEdit }` — general-purpose; Git does **not** depend on it |
| `agent.create.step` | `create-agent-dialog.tsx` as a post-creation step (agent exists, skippable) | `{ agentId, projectId?, scope, onDone(), onSkip() }` — general-purpose |

Core ships a **built-in "Git" tab** on the agent page and a **built-in "Git" step** in the create wizard (neutral settings: identity per provider, triggers, repository access). Only the identity *setup* body is supplied by providers through `git.identity.setup`. The two generic points are still added (other plugins need them) and are how a provider can add extra, platform-specific panels. Mechanics reuse existing machinery: `ExtensionPointId`, manifest `frontend.extensionPoints`, `requiredPermission`, the `#plugin:<pluginId>[:<component>]` hash scheme, and the callback `app.page`.

### 8.2 Plugin → agent runs and run events

* Core's Router starts runs directly (core owns the router), so plugins do **not** need a "start agent" host function for the Git workflow. The generic host capability `agents.trigger` is still worth adding for other plugins (design: idempotent, rate-limited by the host, the agent must belong to a project where the plugin is active) but is **not on the Git critical path**.
* `agent_conversations` gains `external_ref` (thread key, e.g. `git:<provider>:<repo>#<n>`), `source_plugin_id`, and a `trigger_type = 'external_event'`; runs use the existing `dispatchOrEnqueue` (per-agent parallelism, per-folder queue). A follow-up on the same `external_ref` resumes the same conversation (chat mechanism) rather than starting cold.
* agent-runner renders the trigger as a **structured, fenced** "External Event" section (§13.4) and gives the run its `git_capabilities` (below).

### 8.3 Other core items

* **Dynamic outbound hosts.** Plugins currently declare a static `allowedOutboundDomains`. Self-hosted platforms (GitHub Enterprise, GitLab self-managed, Bitbucket Data Center) need hosts from configuration: add `allowedOutboundDomainConfigKeys` (hosts listed in plugin config are allowed) — required for D2's "one identity per host".
* **Internal provider routes** (`/_git/<op>`): host-mounted, caller must be core (service credential) or the MCP server holding an agent key *after* core's checks; never routable from the browser.
* **IAM actions** (authorization stays in router gates, per repository convention): `git:manage_identities` (global), `git:manage` (project: link repos, default responder, policy), `git:agent_configure` (per agent: identity, triggers), and agent-role actions evaluated by core's Git routes — `git:read`, `git:write`, `git:review`, `git:approve`, `git:merge` — scoped to the project resource and, where needed, the repository (`project/<id>/repo/<repoId>`). Per-run reduction (§13.3) is enforced by credential scope and tool exposure, not by service-layer checks.
* **Task linking** moves to core: `git_change_requests`, `git_task_links`, `git_task_branches` and the branch-name → task rule (`PACA-12`), so the task detail **Branches / Change requests** sections are built-in, neutral and show the provider icon.
* **Agent/ project deletion** cascade to identities, links and inbox rows; deleting an identity asks the provider to clean up remotely where it can, otherwise tells the user what to delete by hand.

---

## 9. Agent run lifecycle

### 9.1 Sequence (mention on a comment)

```
 User on the platform: "@bot fix the failing test"
   │ webhook
   ▼
 core: provider.VerifyAndParseWebhook → inbox → Router → actor permission ≥ policy? → route → debounce
   │ 1. provider.React(comment, "eyes")                (acknowledge, if supported)
   │ 2. provider.Comment/SetStatus → status comment    "⏳ dev-agent is working — [view run]"
   │ 3. start run (external_event, git_capabilities, external_ref)   (idempotent)
   ▼
 agent-runner: attach to static environment (or ephemeral), inject External Event section
   ▼
 agent (MCP): change_request_get_context → workspace_inspect/prepare → edit/test →
              git_commit/git_push → review_reply_thread / run_update_status
   ▼
 core (on run finished|failed|stopped): finalize the status comment/check, reaction ✅/❌
```

### 9.2 Visible state

One **status comment per run**, edited in place (queued → working → done/failed, always linking the Paca conversation); a check run/commit status named `Paca / <agent>` where `statusKind` supports it. The agent writes its answer **where it was asked** (reply in the same thread; comment on the same subject).

### 9.3 Attribution, thread ownership, loop prevention

* Every comment/review core or the agent posts ends with a footer: `Posted by **dev-agent** via Paca · run <link>` — this distinguishes agents sharing a bot.
* **Primary mechanism is a core-side comment index** `git_comment_index(provider, repo, comment_id → conversation_id, agent_id)` filled whenever core posts through the provider (we get the comment id back from `Comment`). It works on every platform. A hidden marker (`<!-- paca:v1 … -->`) is added only when `hiddenMarkers` is true, as a recovery path if the index is lost.
* Loop prevention: events whose `actor.kind = bot` never trigger, with two exceptions: configured dependency bots for auto-review, and cross-agent mentions when the project enables them (depth ≤ 3, tracked by the index).

### 9.4 Concurrency, debounce, cancellation, budgets

Idempotency by `(event id, agent id)`; 10 s debounce per `(repo, subject, agent)` collapsing bursts; a newer head SHA cancels *queued* (not running) CI-fix/auto-review runs for the older SHA; runs in one environment folder queue (existing) and runs for the same `external_ref` serialize; `@bot stop` or closing/merging the CR cancels; hourly run caps per agent/repo and per-run turn/cost caps with one "rate limited" notice, never one per event.

---

## 10. UI

* **Instance → Git providers** (admin): list of installed provider plugins and their hosts; per host the shared identity (status, installations/coverage, webhook health — via an optional provider op, last-delivery time from core's own inbox as a fallback) and a "Set up" button that opens the provider's `git.identity.setup` component. One identity per host, so no app list.
* **Project → Git** (replaces the GitHub tab): linked repositories (picker per provider host), **default responder agent**, allowed-actor policy, pause switch, and a read-only table of agents with identity and enabled triggers.
* **Agent → Git** (built-in tab, also the create step): per linked provider — *Identity* (shared or own; "Create identity for this agent" opens the provider setup component; coverage warnings); *Triggers* (only those the provider supports); *Repository access* (which repos, push/approve/merge per repo); *Test* (send a synthetic event).
* **Task detail:** built-in **Branches** and **Change requests** sections (neutral; provider icon and CR terminology from the provider's `Describe()` — "Pull request"/"Merge request").
* **Provider plugins' own UI** shrinks to the setup component and optional provider-specific panels.

---

## 11. MCP tools

Core-owned (in `apps/mcp`), neutral, calling core API routes that resolve the repository's provider, authorize, call the SPI and write the audit row. Parameters: `repo` (full path; must be linked to the agent's project and permitted) and, where relevant, `number`. Results are structured JSON with **untrusted text fenced** (§13.4). Tools are listed to a run only if its providers' capabilities and its `git_capabilities` allow them.

### 11.1 Read (credential access: read)

| Tool | Purpose |
|---|---|
| `change_request_get_context` | One call: metadata, head/base SHA, fork/draft flags, changed files (paged), review state, unresolved threads, latest checks, linked task. |
| `change_request_get_diff` | Unified diff, whole or per file, size-capped with a cursor. |
| `review_list_threads` | Threads with comments, path/line, resolved/outdated. |
| `issue_get` / `comment_list` | Subject body and comments (fenced). |
| `checks_get` / `checks_get_logs` | Neutral check list `{name, state, required, url}`; failing logs, tail-limited and secret-redacted. |
| `repo_get_file` / `repo_search_code` | Read at a ref without a checkout. |

### 11.2 Write via API (credential access: write, minted per call)

| Tool | Notes |
|---|---|
| `change_request_open` / `change_request_update` | Head must be a pushed branch; defaults base to the repository default; draft option; footer; links the Paca task. |
| `comment_post` | Top-level comment on a subject. |
| `review_reply_thread` / `review_resolve_thread` | Resolve only threads the agent addressed (recorded). |
| `review_submit` | `comment \| approve \| request_changes` with inline comments batched where `batchReview`, emulated otherwise (documented in the result). `approve` needs `git:approve` on the repo and is refused on the identity's own CRs. |
| `labels_add` / `reviewers_request` / `assignees_set` | Low-risk metadata. |
| `run_update_status` | The only writer of the run's status comment/check. |
| `checks_rerun` | Agent's own CR; capped. |
| `change_request_merge` | **Off by default** (`git:merge`); requires `expected_head_sha`; platform branch protection respected. |

### 11.3 Git (local) — workspace tools

| Tool | Purpose |
|---|---|
| `workspace_inspect` | Read-only: candidate checkouts under the working directory (path, token-free `origin`, branch, ahead/behind, dirty, last fetch) and whether one matches the target repo. |
| `workspace_prepare` | `repo`, `path?`, `ref` (branch/CR/SHA), `create_branch?`, `strategy: reuse \| clone`, `worktree?`, `stash?`. Fetches through the credential helper; reuse = fetch, checkout, fast-forward pull; refuses a dirty tree unless told; CR refs use the platform's fetchable ref (`provider` supplies the refspec). Returns path, branch, HEAD. |
| `git_commit` | Stages named paths; commits with the identity's noreply author and a `Paca-Run:` trailer; rejects CI-config paths (§13.3) unless permitted. |
| `git_push` | Pushes the current branch via the helper; refuses default/protected branches and force-push (only `--force-with-lease` on the agent's own `paca/*` branches). |
| `git_status` / `git_log` / `git_diff` | Convenience wrappers. |

"Issue check" and "CI check" features are covered by `issue_get`, `checks_get`, `checks_get_logs`, `checks_rerun` plus the §7.2 triggers. The `github_*` tools contributed by the old plugin are removed; `list_repositories`, `clone_repository`, `push_branch` and the `workspace_*` / `git_*` tools talk to the core Git API (credentials minted per command, `repoId` only, no plugin id).

---

## 12. Workspace and static environments

**Paca never clones for the agent.** The trigger carries *what* (repo, subject, head ref/SHA, base) and *where the working directory is* (`PACA_WORKDIR`, an environment folder); the agent decides *how*.

```
1. workspace_inspect()                                   (cheap, read-only)
2. a matching checkout exists   → workspace_prepare(repo, ref, strategy="reuse")
                                   (fetch, checkout, fast-forward pull — BEFORE any edit or test)
   workdir empty                → workspace_prepare(repo, ref, strategy="clone")
   non-empty, no match          → pick a subfolder or ask in the thread; never delete
3. work, test
4. git_commit → git_push → change_request_open / review_reply_thread
```

* **Which ref:** the trigger names it — the CR head branch for feedback/CI/review triggers (fork CRs: fetched read-only), the default branch for issue triggers (the agent creates `paca/<issue>-<slug>`), the task's linked branch if any. The agent may override with a stated reason.
* **Pre-pull and divergence:** always fetch + fast-forward; if diverged, report ahead/behind and do not reset — the agent rebases, branches, or asks.
* **Shared static workspaces:** dirty trees or branches left by earlier runs are reported; PR-style triggers default to a **git worktree** per subject (`<workdir>/.paca-worktrees/<repo>-<n>`) so two CRs never fight over one checkout.
* **Ephemeral sandboxes** start empty: same protocol, shallow/partial clone for review-only work, and often *no* clone — `change_request_get_context`/`get_diff`/`repo_get_file` are enough for a reviewer.
* `environment_folders.repo_clone_url` becomes a *hint* returned by `workspace_inspect`, not an instruction.
* **Locking:** folder-level queueing exists; `workspace_prepare` also takes an advisory lock file so a human working over SSH is warned, not clobbered.
* **`acp` agents** run the user's local CLI with the user's git credentials; triggers still arrive, API tools still work through core, local-git tools are optional, and the Git tab notes that local commits carry the user's identity.

---

## 13. Security model

### 13.1 Credentials

| Risk | Control |
|---|---|
| Provider secrets (private keys, tokens) | Encrypted at rest (`ENCRYPTION_KEY`); decrypted only inside the provider plugin; never returned by any API, tool or log. |
| Credential scope | Per call, per repository, `read` vs `write`; TTL ≤ the call where the platform allows; static platforms keep the secret server-side and perform API calls themselves (§6.3). |
| Token in the sandbox | Never in env, files, remote URLs, args or tool output; output scrubbing stays as defence in depth. Fixes the `.git/config` leak (§2). |
| Cross-repo access | Core enforces `repo ∈ project's linked repos ∩ agent's repository access`; the platform independently enforces the identity's reach. |
| Compromised agent | Bounded to branch-scoped writes on permitted repos for the run's duration; auditable by footer, comment index and `git_action_log`. |

### 13.2 Who may trigger an agent

* Default: the actor must have **`write` or higher** (live `GetActorPermission`, never the payload's association field). Others are ignored silently (no spam oracle) unless the project lowers it (`triage`, or "anyone", with a warning).
* **Bots never trigger**, except configured dependency bots (auto-review) and project-enabled cross-agent mentions (depth ≤ 3).
* Optional stricter mode: GitHub/GitLab login → Paca member mapping and project membership required.

### 13.3 What an agent may change

* Writes default to branches matching `paca/*` (configurable); default/protected branches are never pushed (`GetBranchProtection`, cached 60 s); no force-push except `--force-with-lease` on the agent's own branch.
* **Fork CRs are read-only** (credential `access: read`).
* **CI configuration is blocked** (`.github/workflows/**`, `.gitlab-ci.yml`, `bitbucket-pipelines.yml`, … — provider-declared globs) at `git_commit` and, where the platform has the notion, by not granting the permission.
* Merge, approve and branch-delete are separate IAM actions, **off** by default.
* **Run capabilities:** at trigger time core computes `git_capabilities` from the actor's permission and the agent's IAM actions (e.g. a `triage` actor ⇒ read + comment only). Enforced by (a) the credential's `access`, and (b) which MCP tools are exposed to the run — not by ad-hoc checks inside handlers.

### 13.4 Prompt injection and untrusted content

Everything from the platform (issue/CR text, comments, diffs, files, logs, branch names) is untrusted. The runner renders it in a fenced block with per-run random delimiters stated to be data, tool results mark untrusted fields, privileged operations are unlocked only by server-side policy (never by model judgment), secrets are redacted from logs and `.env`-like content, and reads are size-limited with explicit truncation markers so truncation cannot hide a malicious hunk.

### 13.5 Webhooks and abuse

Provider-specific signature/secret verification (inside `VerifyAndParseWebhook`) plus core-side replay table (30 days), per-identity endpoint keys, per-repo/per-actor rate limits, a global cap on concurrent Git-triggered runs, a project kill-switch (and `@bot stop`), and an audit trail of every inbound decision (`ignored: insufficient permission | unlinked | duplicate | rate-limited | routed → agent X`) and tool call kept 90 days and shown on the agent's Git tab.

---

## 14. Data model

**Core** (`services/api`, new migrations):

```sql
git_identities        (id, provider_id, host, kind, handle, display_name, scope CHECK ('shared','agent'), provider_ref JSONB, created_by, created_at)
  -- unique (provider_id, host) WHERE scope = 'shared'
git_agent_identities  (agent_id, provider_id, identity_id,  PRIMARY KEY (agent_id, provider_id))
git_repositories      (id, project_id, provider_id, host, external_id, full_path, default_branch, identity_id, provider_ref JSONB, webhook_ref JSONB, created_at)
  -- unique (project_id, provider_id, host, full_path)
git_project_settings  (project_id PK, default_agent_id, actor_policy DEFAULT 'write', agent_mentions_enabled, paused)
git_agent_triggers    (agent_id, event, enabled, filters JSONB,  PRIMARY KEY (agent_id, event))
git_agent_repo_access (agent_id, repo_id, can_push, PRIMARY KEY (agent_id, repo_id))   -- approve/merge via IAM actions
git_change_requests   (id, repo_id, number, title, state, head_ref, head_sha, base_ref, author, html_url, draft, merged_at, updated_at)
git_task_links        (task_id, change_request_id) ; git_task_branches (task_id, repo_id, branch_name)
git_webhook_endpoints (key PK, provider_id, identity_id)
git_event_inbox       (event_id PK, endpoint_key, kind, payload JSONB, status, received_at)
git_runs              (conversation_id PK, agent_id, repo_id, external_ref, status_comment_ref, status_ref, capabilities JSONB, head_sha, created_at)
git_comment_index     (provider_id, repo_id, comment_id, conversation_id, agent_id,  PRIMARY KEY (provider_id, repo_id, comment_id))
git_action_log        (id, conversation_id, agent_id, tool, repo_id, subject, ok, detail, at)
agent_conversations   + external_ref TEXT, source_plugin_id TEXT  -- trigger_type 'external_event'
```

**Provider plugin** keeps only platform-private tables (GitHub: `github_apps`, `github_app_installations`, encrypted keys, manifest sessions). The GitHub plugin's `github_repositories`, `github_pull_requests`, `github_task_pr_links`, `github_task_branches`, `github_installation_projects`, `github_agent_identities` and `github_integrations` are dropped (plugin migration `0005_drop_legacy.sql`); the plugin's frontend, MCP tools, automation nodes and routes are deleted. Features such as PR/branch links on tasks return later on the core `git_*` tables.

**Existing instances:** no data is migrated. The old plugin connected with personal access tokens, which cannot back a provider identity; upgrading drops its tables (including project integrations, linked repositories and cached pull requests) and admins set up a GitHub App identity and relink repositories in the project Git tab.

---

## 15. Platform notes

How the neutral model is expected to map. **These are working assumptions from general knowledge of each platform, to be confirmed by that provider's own spike before it is built** — the capability flags exist precisely so a wrong assumption degrades a feature instead of breaking the provider.

| | GitHub | GitLab | Bitbucket Cloud | Gitea / Forgejo |
|---|---|---|---|---|
| Identity | GitHub App | Bot user via project/group access token | Repository/workspace access token (or OAuth consumer / Forge app) | Token or OAuth app (a bot user) |
| `credentialModel` | ephemeral (installation tokens, repo + permission down-scoped) | static (scoped token, expiry, rotation) | static | static |
| Webhooks | app-level | project or group level (`webhookScope: group`/`repo`), secret-token header | repository or workspace level, HMAC secret | repository or org level |
| Mention | `@slug[bot]` | `@bot-username` | `@{account}` mention | `@bot-username` |
| Review/assign the bot | **no** for ordinary apps (S1) — mention/label instead; team-review mapping unverified | plausible — bot users are project members (confirm) | users can be reviewers (confirm for token identities) | likely, as a user |
| Checks | check runs + statuses | pipelines / jobs / statuses | build statuses / pipelines | commit statuses / Actions |
| Batch review | pending review → submit | draft notes → publish | not available (emulate: comments + summary) | review with comments |
| Resolve threads | yes (GraphQL) | yes (discussions) | limited | yes |
| Nested paths | no | yes (`group/sub/project`) | workspace/repo | no |

Easiest second provider to validate the SPI: **Gitea/Forgejo** (GitHub-shaped API, simple token identity) as an adapter exercise; **GitLab** is the real stress test of the neutral model (static credentials, nested paths, repo-level webhooks, different review model).

---

## 16. Phasing

| Phase | Scope | Why |
|---|---|---|
| **P0 – Spec & spikes — DONE** (see [git-provider-spikes.md](git-provider-spikes.md); SPI, fake provider and conformance suite in `plugin-sdk-go/gitprovider`) | Write the SPI (`gitprovider.v1`), the Go interface and the fake reference provider + conformance suite. Spikes: **S1** can an App's bot be a requested reviewer/assignee on GitHub; **S2** credential-helper behaviour for HTTPS clone/fetch/push in the agent-server image; **S3** GitHub token minting latency and the short per-call cache; **S4** GitLab paper adapter: map every SPI op to GitLab endpoints and list gaps (the neutrality check). | Settles the riskiest assumptions and proves the SPI is not GitHub-shaped before any migration. |
| **P1 – Core foundation** | Core Git domain: tables, endpoint, inbox, repository linking, change-request cache, task links; credential helper + token-free remotes (**fixes the `.git/config` leak** — ship early); workspace tools; `git_commit/git_push`. GitHub plugin refactored into the first provider (shared identity per host, resolution, webhooks via SPI). | Security fix and neutral base; GitHub keeps working. |
| **P2 – Triggers** | Router, external_event runs, mention / own-CR feedback / label, status comment and reactions, default responder, actor policy, comment index. | First end-to-end "@mention the bot" experience, on any provider that passes conformance. |
| **P3 – Agent UI** | Built-in agent Git tab and create step; extension points `git.identity.setup`, `agent.detail.tab`, `agent.create.step`; agent identities; agent-routed events. | Needs P2's trigger model. |
| **P4 – Review & CI** | Review/CI tools, own-CR CI-failure and auto-review triggers, check runs/statuses, caps and debounce. | Highest volume and risk; built on a proven base. |
| **P5 – Second provider** | GitLab (or Gitea first, then GitLab) adapter using only the published SPI and conformance suite; gaps found feed SPI v1.1. | The real test of the extensibility goal. |
| **P6 – Hardening** | Audit UI, webhook health, kill-switches, login→member mapping, merge permission, remove deprecated aliases, docs ("Writing a Git provider plugin"). | |

**P1 status.** Done: MCP credential helper, token-free remotes and workspace tools; core domain, migration `000073`, Postgres store (tested on real Postgres), `internal/service/git` (repository linking, webhook ingest with replay protection and fan-out, change-request cache and task links, credential minting with identity fallback and a ≤30 s memory cache), the plugin-backed provider lookup (`git-provider` capability, internal-only `/_git/*` routes), IAM actions `git:read` / `git:write`, and HTTP routes: `GET|POST /projects/{id}/git/repositories`, `DELETE …/{repositoryId}`, `POST …/{repositoryId}/credential/{read|write}` (separate routes so each gate names one action) and the public `POST /git/webhooks/{endpointKey}`. **Identity setup (done):** `GET /git/providers`, `GET /git/identities`, `POST /git/identities/setup`, `POST /git/identities/setup/complete`, `DELETE /git/identities/{id}` (all `git.identities:manage`, a workspace-level action with its own `git_identity/*` root) and, per agent, `GET|DELETE /projects/{id}/agents/{agentId}/git/identity` and `POST …/identity/setup` (agent gate + `git.identities:manage`). Begin reserves a webhook endpoint (`/api/v1/git/webhooks/{key}`), asks the provider for the next browser step and stores a single-use setup session bound to the user (migration `000074`); Complete runs one provider leg, records the identity once, binds the endpoint and, for an agent, maps it. **Access grants (done):** installing the GitHub App happens when a project links a repository, per owner, not when the App is created. SPI capability `access_grants` + optional `begin_access_grant` / `complete_access_grant`; core `POST /projects/{id}/git/access/{begin,complete}` (`git:write`), `GIT_ACCESS_NOT_GRANTED` from linking, migration `000075`; the project settings "Git" tab links and unlinks repositories and offers the install; the callback page completes either flow. The setup dialog has an "allow installing on other accounts" (public app) switch. **Agent Git tab (done):** the project agent page has a "Git" tab (`#git`) showing each provider, whether the agent uses the shared identity or its own, "Create identity" (`git.identities:manage`), "Remove" and "Install on another account or organization" (`agents:write` on the agent + `git:write` on the project, via `POST …/agents/{id}/git/identity/access/begin`; the access session names the agent's identity, so completing it grants that identity, not the shared one). Global agents have no tab (the endpoints are project-scoped). **Web UI (done):** `/admin/git` (sidebar "Git", for `git.identities:manage`) lists providers with each host's shared identity and starts or removes it; `/git/setup/callback` completes a leg from the raw query string (exactly once per URL), follows `next` or returns to the sanitized same-origin `return_url`. Remaining for P1: the web role-editor entries for the Git actions. **P1c (done):** the GitHub plugin implements the SPI and passes the conformance suite against a fake GitHub. **Legacy removal (done):** `paca-plugin-github` 0.8.0 is provider-only (capability `git-provider`, no routes, frontend, MCP tools, automation nodes or PAT support) and drops the legacy tables; the agent service now publishes `git-provider` plugin ids to agents, and the MCP repo/workspace tools use the core API (`GET …/git/repositories`, `POST …/credential/{read|write}`).

**P2 + P4 status (workflow — done).** Everything an agent does after a Git event is implemented in core; the GitHub plugin already supplied the provider operations.

*Tools (apps/mcp, `src/tools/git-tools.ts`)* — `change_request_get_context`, `change_request_get_diff`, `review_list_threads`, `issue_get`, `comment_list`, `checks_get`, `checks_get_logs`, `repo_get_file`, `repo_search_code`, `change_request_open`, `change_request_update`, `comment_post`, `review_reply_thread`, `review_resolve_thread`, `review_submit`, `labels_add`, `reviewers_request`, `assignees_set`, `checks_rerun`, `change_request_merge`. Each takes `projectId` + `repoId` (never a credential). Text written on the platform (titles, bodies, comments, diffs, CI logs, file contents) is returned inside `UNTRUSTED` fences with the fence markers neutralised; the event prompt does the same (§13.4). `run_update_status` is not a tool: core alone writes a run's status.

*Core API* — `/projects/{id}/git/repositories/{repoId}/…`: reads under `git:read` (`change-requests/{n}[/files|/diff|/threads]`, `subjects/{kind}/{n}/comments`, `issues/{n}`, `checks[/{id}/logs]`, `files`, `code-search`); writes under `git:write` (open/update change request, comments, thread replies/resolution, `reviews` with verdict `comment|request_changes`, labels, reviewers, assignees, `checks/rerun`); **`approvals` under `git:approve` and `merge` under `git:merge`** — the verdict is chosen by the route, so a router gate decides who may approve. Core adds the attribution footer, an idempotency key per call, indexes every comment it posts (`git_comment_index`), records the opening agent on `git_change_requests`, audits every call (`git_action_log`, with the provider's error code on failure), caps CI re-runs (6/hour/repository), caps diffs (400 KB) and log tails (64 KB, secrets masked), and refuses optional operations the provider does not declare. The `X-Paca-Conversation-Id` header attributes a call to a conversation only if the calling agent owns it.

*Triggers and routing* — migration `000076`; `internal/service/git/router.go`. A worker claims inbox events at least 10 s old (`FOR UPDATE SKIP LOCKED`, abandoned claims return after 5 min) and decides per event: **mention / review request / assignment** (the provider's `addressed[]`), **own-pull-request feedback** (a human review or comment on a pull request an agent opened — no mention needed), **CI failure** on the head commit of an agent's open pull request (at most 3 runs per pull request; stale commits and Paca's own `Paca / <agent>` check are ignored), **label** (`paca` → responder, `paca:<handle>` → that agent) and **auto-review** (opt-in per agent, filters: target branches and authors; drafts, the agent's own pull requests and unlisted bot authors are skipped; a fork's pull request needs an authorized author). Responder order for something addressed to the shared bot: the agent owning the receiving identity, an `agent:<handle>` hint in the text, the agent that last spoke on the subject (comment index), the project's default responder. Guards: paused project; bots never start runs (except check results); the actor needs the project's minimum repository permission (default `write`, resolved through the provider and remembered 5 min); the agent must have the trigger switched on (defaults: all on except auto-review). One run per agent and subject at a time: an event received before the running run started is "covered" (the run reads the whole thread); a later one waits and then starts its own. A run is an automation-message conversation whose first message is the structured, fenced "External event" prompt (`prompt.go`: what happened, who, where, which tools, rules). Visible state: an "eyes" reaction on the comment and a `Paca / <agent>` check run on the head commit, updated in place to success / failure / cancelled when the conversation ends (issues have no commit, so no check). Run rows live in `git_runs`; `GET /projects/{id}/git/runs` lists them.

*Configuration* — `GET|PUT /projects/{id}/git/settings` (`git:read` / `git:write`: default responder, pause, minimum actor permission), `GET /projects/{id}/agents/{agentId}/git/triggers` and `PUT …/triggers/{kind}` (agent gates `agents:read` / `agents:write`; only auto-review has filters). UI: the project Git tab ("Agent automation": settings + recent runs) and the agent Git tab ("Git triggers", listing only triggers some installed provider declares). The Editor project role template now holds `git:read` and `git:write`; `git:approve` and `git:merge` are in no template (the Admin role's `*` includes them). An agent needs these actions in its project role to use the tools.

*Known limits* — events are not "debounced" with a timer but coalesced by the 10 s claim age and the one-run-per-subject rule; GitHub's review-comment webhooks carry no thread id, so feedback routing uses pull-request ownership rather than thread ownership; auto-review has no path filter yet (it would need a changed-files call per event); `@bot stop` and cancelling a queued run on a newer head are not implemented; there is no login → Paca member mapping (§13.2 "stricter mode"); task-detail sections for branches / change requests are still to be built on `git_task_links`.

---

## 17. Risks and open questions

1. **Assigning review/issues to a bot is platform-dependent — and for GitHub it is settled: not possible for ordinary Apps** (spike S1: the reviewer endpoint requires collaborators and `dependabot[bot]`/`github-actions[bot]` are 404 for both collaborator and assignee checks; only GitHub's partner coding agents are assignable). The earlier, less certain framing follows for context: the reviewer API takes users and teams, Copilot is special-cased, and a community report suggests an app might request itself with its own token but this is unconfirmed ([discussion](https://github.com/orgs/community/discussions/157751)). Comparable bots rely on mentions and labels — Tembo documents `@tembo` comments, label triggers and `issue_comment.created` ([Tembo docs](https://docs.tembo.io/features/pull-requests)); Pullfrog's listing describes `@pullfrog` mentions plus automations such as "PR created" and "PR review requested" ([Pullfrog app](https://github.com/apps/pullfrog)). Capabilities make this a per-provider answer, not a design break.
2. **Moving the domain into core is a large migration** (tables, UI, tools, GitHub plugin refactor). It is the price of making every provider cheap; P1 is sequenced so GitHub keeps working throughout, and the alternative (an SDK library each plugin embeds) would still duplicate UI, tools and storage per platform.
3. **Static-credential platforms have a bigger blast radius** (a token cannot be down-scoped per call). Mitigations: server-side API calls, read/write token separation, per-repo access lists, recommended minimal-scope tokens with expiry and rotation reminders. Needs a UX decision on how loudly to warn.
4. **Shared identity trust boundary.** With the allow-list removed, any project member who can link repositories can point agents at any repository the shared identity can see; the real boundary is the identity's repository selection on the platform. Proposed: an optional instance-level allow-list of owners/repos (default off), and `git:manage` required to link.
5. **SPI churn.** A too-small SPI forces core to special-case platforms; a too-large one burdens authors. The `v1` surface above is the proposal; `ErrUnsupported` + capability flags and the conformance suite are the safety valves, and S4 (paper GitLab adapter) is the check before freezing.
6. **Per-provider webhook plumbing for repo-scoped platforms** (`EnsureWebhook`) needs a permission the identity may not have (GitLab/Bitbucket webhook creation requires maintainer/admin rights); the UI must say so and offer "paste this URL and secret" as the manual path.
7. **Comment attribution via footer** is advisory (a user can edit it out); the core comment index, not the footer, is the source of truth for thread ownership.
8. **Open:** one project, several providers — default responder per project (proposed) vs per provider?
9. **Open:** should "own CR" feedback also cover CRs opened by a human *for* an agent's Paca task (linked via the task)? Proposed: yes when the CR is linked to a task assigned to that agent.
10. **Open:** terminology in tool names: `change_request_*` is neutral but unfamiliar; tool *descriptions* say "pull request / merge request", and the UI uses each provider's own term.
