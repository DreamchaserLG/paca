# Spike S2 — git credential helper

Prototype and test harness for the credential-helper design in
[../../git-agent-workflow.md](../../git-agent-workflow.md) §6.3 / §11.3. Result and
conclusions: [../../git-provider-spikes.md](../../git-provider-spikes.md#s2--credential-helper-for-httpsgit).

* `server.mjs` — a git smart-HTTP server (via `git http-backend`) that only accepts
  short-lived Basic-auth tokens, plus a "broker" on a unix socket that mints them
  (read or write, TTL 2 s in the test). It stands in for core + a provider.
* `helper.mjs` — the credential helper: answers `get` by asking the broker for a
  credential for this one invocation; `store`/`erase` are no-ops.
* `run.sh` — 13 assertions: token-free remote URL, nothing under `.git`, fresh
  credential per invocation after expiry, read credential cannot push, allow-list
  and host checks, nothing in env/config/`GIT_TRACE`.

```sh
./run.sh        # needs git, node >= 18; uses a temp dir and /tmp/pgc-s2.sock
```

(The unix socket lives under `/tmp` only because socket paths are limited to ~107
bytes.) The production helper is a small script shipped in the MCP bundle that
talks to the MCP process over a private socket instead of directly to a broker.
