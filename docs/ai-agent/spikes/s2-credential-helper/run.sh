#!/bin/bash
set -u
D=$(cd "$(dirname "$0")" && pwd); W=$(mktemp -d); mkdir -p $W/srv/acme $W/agent; trap 'rm -rf "$W"; rm -f /tmp/pgc-s2.sock' EXIT
export ROOT=$W/srv PORT=18765 SOCK=/tmp/pgc-s2.sock TTL_MS=2000
# seed a bare repo with one commit
git init -q --bare $W/srv/acme/web.git
git -C $W/srv/acme/web.git config http.receivepack true
git clone -q $W/srv/acme/web.git $W/seed 2>/dev/null; cd $W/seed && git config user.email a@b && git config user.name seed
echo hello > README.md && git add . && git commit -qm init && git branch -M main && git push -q origin main; cd $D
node server.mjs > $W/server.log 2>&1 &
SPID=$!; for i in $(seq 50); do grep -q ready $W/server.log && break; sleep 0.1; done

export GIT_TERMINAL_PROMPT=0 PACA_GIT_SOCK=/tmp/pgc-s2.sock
H="-c credential.helper= -c credential.helper=!node\ $D/helper.mjs -c credential.useHttpPath=true"
g() { git -c credential.helper= -c "credential.helper=!node $D/helper.mjs" -c credential.useHttpPath=true "$@"; }
URL=http://127.0.0.1:$PORT/acme/web.git
pass=0; fail=0
ok()  { echo "PASS  $1"; pass=$((pass+1)); }
bad() { echo "FAIL  $1"; fail=$((fail+1)); }

# 1. clone with a read credential, remote URL stays token-free
PACA_GIT_ACCESS=read g clone -q $URL $W/agent/web 2>$W/e1 && ok "clone via credential helper" || { bad "clone via credential helper"; cat $W/e1; }
git -C $W/agent/web remote get-url origin | grep -q '@' && bad "remote url contains credentials" || ok "remote.origin.url is token-free ($(git -C $W/agent/web remote get-url origin))"
grep -rqE 'ghs_|x-access-token' $W/agent/web/.git 2>/dev/null && bad "token found somewhere under .git" || ok "no token anywhere under .git (config, logs, objects)"

# 2. token TTL is 2s: wait, then fetch must still work (fresh credential per invocation)
sleep 3
PACA_GIT_ACCESS=read g -C $W/agent/web fetch -q 2>$W/e2 && ok "fetch after the earlier token expired (fresh mint per invocation)" || { bad "fetch after expiry"; cat $W/e2; }

# 3. read credential cannot push; write credential can
git -C $W/agent/web config user.email a@b; git -C $W/agent/web config user.name dev
git -C $W/agent/web checkout -qb paca/feature; echo x > $W/agent/web/f.txt; git -C $W/agent/web add .; git -C $W/agent/web commit -qm feat
PACA_GIT_ACCESS=read g -C $W/agent/web push -q origin paca/feature 2>$W/e3 && bad "push succeeded with a read-only credential" || ok "push refused with a read-only credential ($(tr -d '\r' < $W/e3 | grep -m1 -o 'read-only credential\|403[^\n]*' ))"
PACA_GIT_ACCESS=write g -C $W/agent/web push -q origin paca/feature 2>$W/e4 && ok "push succeeded with a write credential" || { bad "push with write credential"; cat $W/e4; }
git --git-dir=$W/srv/acme/web.git rev-parse -q --verify refs/heads/paca/feature >/dev/null && ok "branch exists on the server" || bad "branch missing on server"

# 4. helper answers only for allowed repos/hosts: other repo => no credential => clean failure, no prompt
git init -q --bare $W/srv/acme/secret.git
g clone -q http://127.0.0.1:$PORT/acme/secret.git $W/agent/secret 2>$W/e5 && bad "cloned a repo the broker does not allow" || ok "repo outside the allow-list refused (no credential, no prompt)"
g clone -q http://localhost:$PORT/acme/web.git $W/agent/web2 2>$W/e6 && bad "cloned via a different host" || ok "different host refused"

# 5. nothing leaks through git's own diagnostics
GIT_TRACE=1 GIT_CURL_VERBOSE=0 PACA_GIT_ACCESS=read g -C $W/agent/web fetch 2>&1 | grep -qE 'ghs_[0-9a-f]{24}' && bad "token visible in GIT_TRACE output" || ok "token not visible in GIT_TRACE output"
env | grep -qE 'ghs_' && bad "token in the environment" || ok "no token in the environment"
git -C $W/agent/web config --list --show-origin | grep -qE 'ghs_' && bad "token in git config" || ok "no token in git config"

# 6. store/erase are no-ops: a rejected/approved credential is never cached
ls ~/.git-credentials 2>/dev/null | grep -q . && echo "(note: ~/.git-credentials exists on this machine — pre-existing)" || ok "no ~/.git-credentials written"

# 7. cost: broker round-trips and per-op latency
t0=$(date +%s%N); for i in 1 2 3 4 5; do PACA_GIT_ACCESS=read g -C $W/agent/web ls-remote -q origin >/dev/null 2>&1; done; t1=$(date +%s%N)
echo "INFO  5 x ls-remote with helper: $(( (t1-t0)/5000000 )) ms each (includes node start-up + broker mint)"
curl -s localhost:$PORT/__stats | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const j=JSON.parse(s);console.log("INFO  mints:",j.mints,"| last:",j.log.slice(-4).join(" ; "))})'
kill $SPID 2>/dev/null; rm -f /tmp/pgc-s2.sock
echo "RESULT pass=$pass fail=$fail"
