// Spike S2 test double: a git smart-HTTP server (via git-http-backend CGI) that
// requires short-lived Basic-auth tokens, plus a credential "broker" on a unix
// socket that mints them. Mirrors what core + provider would do.
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import crypto from "node:crypto";

const ROOT = process.env.ROOT, PORT = +process.env.PORT, SOCK = process.env.SOCK, TTL = +(process.env.TTL_MS ?? 3000);
const ALLOWED_REPOS = new Set(["acme/web"]);
const tokens = new Map(); // token -> {path, access, exp}
const log = [];
let mints = 0;

// ── broker (unix socket) ──
const broker = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const q = JSON.parse(b || "{}");
    mints++;
    const path = String(q.path || "").replace(/\.git$/, "").replace(/^\//, "");
    if (q.host !== `127.0.0.1:${PORT}` || !ALLOWED_REPOS.has(path)) { log.push(`deny ${q.host} ${path}`); res.writeHead(403).end("denied"); return; }
    const token = "ghs_" + crypto.randomBytes(12).toString("hex");
    tokens.set(token, { path, access: q.access === "write" ? "write" : "read", exp: Date.now() + TTL });
    log.push(`mint ${path} ${q.access}`);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ username: "x-access-token", secret: token }));
  });
});
try { fs.unlinkSync(SOCK); } catch {}
broker.listen(SOCK);

// ── git server ──
const git = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const m = /^\/(.+?)\.git(\/.*)?$/.exec(u.pathname);
  if (u.pathname === "/__stats") { res.end(JSON.stringify({ mints, log })); return; }
  const auth = /^Basic (.+)$/.exec(req.headers.authorization ?? "");
  const [user, pass] = auth ? Buffer.from(auth[1], "base64").toString().split(":") : [];
  if (!m) { res.writeHead(404).end(); return; }
  const tok = tokens.get(pass);
  if (!tok || tok.exp < Date.now() || tok.path !== m[1]) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' }).end("auth required (token wrong or expired)");
    return;
  }
  const isPush = (u.searchParams.get("service") === "git-receive-pack") || (m[2] ?? "").endsWith("git-receive-pack");
  if (isPush && tok.access !== "write") { res.writeHead(403).end("read-only credential"); return; }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const cgi = spawn("git", ["http-backend"], { env: {
      PATH: process.env.PATH, GIT_PROJECT_ROOT: ROOT, GIT_HTTP_EXPORT_ALL: "1", REMOTE_USER: user,
      REQUEST_METHOD: req.method, PATH_INFO: u.pathname, QUERY_STRING: u.search.slice(1),
      CONTENT_TYPE: req.headers["content-type"] ?? "", CONTENT_LENGTH: String(body.length),
      HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
    } });
    const out = []; cgi.stdout.on("data", (c) => out.push(c));
    cgi.stdin.end(body);
    cgi.on("close", () => {
      const raw = Buffer.concat(out); const i = raw.indexOf("\r\n\r\n"); const head = raw.subarray(0, i).toString();
      const headers = {}; let status = 200;
      for (const l of head.split("\r\n")) { const [k, ...v] = l.split(": "); if (k.toLowerCase() === "status") status = parseInt(v[0]); else headers[k] = v.join(": "); }
      res.writeHead(status, headers).end(raw.subarray(i + 4));
    });
  });
});
git.listen(PORT, "127.0.0.1", () => console.log("ready"));
