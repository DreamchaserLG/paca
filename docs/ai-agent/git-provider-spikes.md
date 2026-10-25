# Git agent workflow — P0 spike report

Results of the P0 spikes listed in [git-agent-workflow.md §16](git-agent-workflow.md#16-phasing), run against the real tooling where possible. Each section says **what was done, what it shows, what it does *not* show**, and the design consequence.

| Spike | Question | Verdict |
|---|---|---|
| [S1](#s1--can-a-github-apps-bot-be-a-reviewer-or-assignee) | Can a GitHub App's bot be a requested reviewer / assignee? | **No for ordinary Apps.** Keep `review_request` / `assignment` undeclared for GitHub; mention + label are the triggers. A team-mapping trigger is a candidate (unverified). |
| [S2](#s2--credential-helper-for-httpsgit) | Does a git credential helper give per-invocation, never-persisted credentials? | **Yes** — 13/13 assertions pass; remote URL token-free, nothing under `.git`, fresh credential per invocation. |
| [S3](#s3--token-minting-cost) | What does minting a credential per call cost? | ≈ 0.15–0.25 s per mint; **cache ≤ 30 s in core's credential service** (memory only). |
| [S4](#s4--gitlab-paper-adapter-the-neutrality-check) | Is the SPI GitHub-shaped? Map every operation to GitLab. | **Mostly neutral.** Two SPI refinements found and applied (token form fields, identity expiry); five documented gaps. |

Deliverables of P0 beyond this report (all in `plugin-sdk-go/gitprovider`): the SPI (`types.go`, `provider.go`, `errors.go`, `wire.go`), the plugin adapter (`serve`), a reference **fake provider** (`fakeprovider`, in a `Full` and a `Minimal` variant), the **conformance suite** (`conformance`) and a mutation check (`scripts/check-mutants.sh`). Author guide: [../plugins/git-provider-spi.md](../plugins/git-provider-spi.md).

---

## S1 — can a GitHub App's bot be a reviewer or assignee?

**Done.**

1. Read GitHub's REST reference for "Request reviewers for a pull request": the body takes `reviewers` (*user logins*) and `team_reviewers` (*team slugs*); `422` is "Unprocessable Entity if user is not a collaborator". Apps and bot accounts are not mentioned.
2. Read-only probes with `gh` against `Paca-AI/paca` for the two Apps whose bots everybody sees on GitHub (`dependabot[bot]`, `github-actions[bot]`):
   * `GET /repos/{r}/collaborators/{bot}` → **404** for both;
   * `GET /repos/{r}/assignees/{bot}` → **404** for both;
   * GraphQL `suggestedActors(capabilities: [CAN_BE_ASSIGNED])` → only the human owner.
3. Community reports: bot assignment exists for GitHub's partner coding agents (`copilot-swe-agent`, `anthropic-code-agent`) through GraphQL `suggestedActors` / `replaceActorsForAssignable`, not through any documented manifest field for ordinary Apps ([discussion #164267](https://github.com/orgs/community/discussions/164267), [crewd#64](https://github.com/StGerman/crewd/issues/64)).

**Shows.** Existing, long-lived GitHub App bots are neither collaborators nor assignable, so the documented reviewer endpoint rejects them (it requires a collaborator) and the assignee check 404s. An ordinary Paca GitHub App will behave like `dependabot[bot]`.

**Does not show.** We did not create a throw-away App and repository to attempt a real review request, and the probe repo has no partner agent enabled, so "partner bots appear in `suggestedActors`" rests on community reports. `probe.sh` re-runs the checks against any repo and bot login in a minute.

**Consequence.**

* GitHub provider declares **neither** `review_request` **nor** `assignment` triggers. Mention and label (and own-CR rules) are the GitHub triggers. The agent tab hides the toggles because capabilities say so — the design already handles this.
* **Candidate trigger, unverified:** in an organization, request a review from a *team* (`team_reviewers`), and map that team slug to an agent in Paca. GitHub does fire `pull_request.review_requested` with `requested_team`. It needs an org team that has repository access and an event-mapping setting; verify with a real org before promising it. If it works it would be declared as the `review_request` trigger *with provider-specific mapping UI*.
* Other providers differ: GitLab bot users are project/group members, so reviewer and assignee requests are plausible there (to confirm in that provider's own spike).

## S2 — credential helper for HTTPS git

**Done.** `spikes/s2-credential-helper/` contains a test git server (`git http-backend` behind Basic auth with 2-second, repo- and access-scoped tokens), a broker on a unix socket that mints them, and the helper (git credential protocol: `get` asks the broker, `store`/`erase` do nothing). `run.sh` drives real `git clone/fetch/push` through it.

**Results (13/13).**

| Check | Result |
|---|---|
| Clone through the helper | pass |
| `remote.origin.url` after clone | `http://127.0.0.1:…/acme/web.git` — **no credentials** |
| Token anywhere under `.git` (config, logs, objects) | none |
| `fetch` after the first token expired (TTL 2 s, wait 3 s) | pass → a fresh credential is minted per invocation |
| Push with a **read** credential | refused by the server (403) |
| Push with a **write** credential | pass; branch exists on the server |
| Repository outside the broker's allow-list | no credential → clean failure, **no prompt** (`GIT_TERMINAL_PROMPT=0`) |
| Different host for the same repo | refused |
| Token in `GIT_TRACE` output / environment / `git config --list` | none |
| `~/.git-credentials` written | no (`store`/`erase` are no-ops) |
| Cost | ≈ 155 ms per git operation including Node start-up and a local broker round-trip (12 mints for ~14 operations) |

**Shows.** The helper design removes the `.git/config` token leak described in the design (§2), satisfies "no token in env/args/files", and gives access-level separation (read vs write) **if the caller chooses the level**: git does not tell a helper whether it is about to read or write, so the tool sets `PACA_GIT_ACCESS=read|write` in git's environment (`git_push` → write, everything else → read). The helper inherits that environment.

**Does not show.** HTTPS against real GitHub (the protocol is identical: Basic auth with username `x-access-token`), SSH remotes (out of scope for v1), Windows, or git older than the version in the agent-server image (the helper uses only the long-stable `get`/`store`/`erase` verbs). The helper must be exercised once inside the real agent-server image during P1 — the image has Node 22 and `curl`; git comes from the Goose base image.

**Consequence.** Adopt as designed. Details that must carry into P1: set `credential.useHttpPath=true` so the helper sees the repository path; reset any inherited helpers with `-c credential.helper=` first; always run git with `GIT_TERMINAL_PROMPT=0`; the helper must answer only for hosts/paths core authorizes and fail *closed and quiet* otherwise.

## S3 — token minting cost

**Done.** Measured the two parts of a GitHub installation-token mint:

* **JWT signing** under TinyGo/WASM: ≈ 28 ms (measured in phase 1 of the GitHub App work; compiled-WASM RS256 with a 2048-bit key).
* **Network**: six calls to `api.github.com` from this machine: connect ≈ 70 ms, time-to-first-byte ≈ 150–175 ms (a fresh TLS connection each time; the host's `fetch` can reuse connections, so ≈ 100 ms is realistic).

So a mint ≈ **130–210 ms**; a git operation needs one or two helper calls, so ≈ +0.15–0.4 s per git command, and an API tool call +0.15–0.2 s.

**Not measured.** The actual `POST /app/installations/{id}/access_tokens` (needs an installed App) and GitHub's rate limit for token minting.

**Consequence.** Mint per call but **cache inside core's credential service for ≤ 30 s, keyed by `(identity, repo, access)`, in memory only** — never in Valkey/DB and never returned to agents. This keeps the "short-lived, down-scoped" property while turning a burst of fetches/API calls in one tool invocation into one mint. (The ephemeral cache already built for installation tokens in the GitHub plugin — ~55 min, encrypted — is *not* the right model for per-repo down-scoped tokens; it stays only as the plugin's internal App-level token.)

## S4 — GitLab paper adapter (the neutrality check)

**Done.** Walked every SPI operation and mapped it to GitLab. Confirmed against GitLab's docs: **draft notes with `bulk_publish`** (`POST /projects/:id/merge_requests/:iid/draft_notes/bulk_publish`, optional summary `note` and `reviewer_state` = `requested_changes` | `reviewed`), draft-note positions need `base_sha`/`head_sha`/`start_sha`, and the webhook secret arrives as a **plain `X-Gitlab-Token` header** (HMAC "signing tokens" are the newer, recommended alternative), with **group webhooks only on Premium/Ultimate**. The rest is from general knowledge and marked ◇ — confirm before building the provider.

| SPI operation | GitLab |
|---|---|
| `BeginIdentitySetup` | `token_form`: the user creates a project/group **access token** (a bot user) and pastes it — optionally two (read-only and write). ◇ OAuth application is the alternative but acts as a *user*. |
| `ListRepositories` / `ResolveRepository` | `GET /projects?membership=true` (keyset paging); `GET /projects/:url-encoded-full-path`. `full_path` is `group/sub/project` (nested); `external_id` is the numeric id. |
| `VerifyAndParseWebhook` | Compare `X-Gitlab-Token` in constant time (or verify the signing-token HMAC ◇). Events: *Note Hook* (comments on MR/issue; `position` → location), *Merge Request Hook* (open/update/close/merge; `changes` for labels, reviewers ◇, assignees ◇), *Pipeline Hook* (failed → `check`), *Push Hook*. Mentions: `@bot-username` in note text. |
| `EnsureWebhook` / `RemoveWebhook` | `POST/DELETE /projects/:id/hooks` — needs Maintainer; group hooks need Premium → declare `webhook_scope: repo`. |
| `MintCredential` | **static**: return the stored token; two tokens ⇒ `access` picks read vs write. Username `oauth2` for HTTPS. |
| `GetActorPermission` | `GET /projects/:id/members/all/:user_id` (inherited access) → 10/20/30/40/50 ⇒ read/triage/write/maintain/admin; user id from `GET /users?username=`. |
| `GetBranchProtection` | `GET /projects/:id/protected_branches/:name` (404 ⇒ not protected). |
| `GetChangeRequest`, `ListChangedFiles`, `GetDiff` | MR resource (`diff_refs` hold the three SHAs); `GET …/merge_requests/:iid/diffs` paged; per-file filtering and `MaxBytes` truncation done in the provider. |
| `ListThreads`, `ListComments` | `discussions` / `notes` (skip system notes); thread id = discussion id; `resolved` from the discussion. |
| `GetChecks`, `GetCheckLogs` | MR pipelines → jobs (job = check; `required` = not `allow_failure`, best effort); `GET jobs/:id/trace`, tailed locally. |
| `OpenChangeRequest` / `UpdateChangeRequest` | `POST/PUT merge_requests` (`Draft:` prefix or `draft`); close/reopen via `state_event`. **No idempotency key** → dedupe by looking for an open MR with the same source branch. |
| `Comment` / `ReplyThread` | `POST notes` / `POST discussions/:id/notes`. |
| `SubmitReview` | **Native batch**: create draft notes (with positions) then `bulk_publish` with `note` and `reviewer_state`; `approve` verdict → `POST …/approve` with the head `sha` ◇. |
| `SetStatus` | `commit_status` kind: `POST /projects/:id/statuses/:sha` (`pending/running/success/failed/canceled`); a comment is the fallback. Status ref = `name@sha`. |
| Optional: threads, file read, search, labels, reviewers, assignees, merge, rerun, reactions, delete identity | `PUT discussions/:id resolved`; `repository/files/:path/raw`; `search?scope=blobs`; `labels`/`add_labels`; `reviewer_ids` ◇; `assignee_ids`; `PUT merge` with `sha` guard ◇; `pipelines/:id/retry`; `award_emoji`; delete the access token. |

**Shows.** Every operation maps without bending the SPI; GitLab's batch-review model fits `SubmitReview` *better* than GitHub's, nested paths and numeric project ids fit `RepoRef`, and static credentials fit the `credential_model` split.

**SPI changes made because of this exercise** (already applied in `gitprovider` and checked by the conformance suite):

1. **Token setup needs a list of inputs.** GitLab (and Bitbucket) want a read-only *and* a write token. `SetupStep.Form []FormField` (name, label, help, secret, required) replaces "one token box"; `token_form` steps must declare their form.
2. **Static credentials expire.** GitLab access tokens have a maximum lifetime and need rotation. `Identity.ExpiresAt` lets core warn before an identity stops working.

**Gaps to carry (not SPI changes).**

* *Handle ugliness*: a GitLab project bot's username (`project_123_bot_<hash>`) is a poor `@mention`. The identity must let the user choose/rename the bot user, and the UI must show the exact string to mention.
* *Permissions to register hooks*: Maintainer for repo hooks, Premium for group hooks → the "paste this URL and secret" manual path (design §17.6) is mandatory for GitLab.
* *Two-token separation* is a convention, not enforced by GitLab; the UI warns when only a broad token exists.
* *`Check.Required`* is approximate on GitLab; documented as best effort.
* *Approvals*: whether a bot's approval counts depends on project approval rules — the provider returns what GitLab says; core never assumes an approval gates a merge.

## What P0 changes in the design

[git-agent-workflow.md](git-agent-workflow.md) was updated accordingly: S1's verdict and the team-mapping candidate (§7.2, §17.1), S3's cache rule (§6.3), the S4 SPI refinements (§5.2, §14) and the P0 status (§16).
