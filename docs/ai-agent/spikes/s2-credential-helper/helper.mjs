#!/usr/bin/env node
// Prototype of the Paca git credential helper. Implements git's credential
// protocol: `get` asks the local broker for a credential for this one
// invocation; `store` and `erase` are no-ops so nothing is ever persisted.
import http from "node:http";

const op = process.argv[2];
if (op !== "get") process.exit(0); // store/erase: never persist, never fail

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const kv = Object.fromEntries(input.split("\n").filter(Boolean).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
  const body = JSON.stringify({ host: kv.host, path: kv.path, protocol: kv.protocol, access: process.env.PACA_GIT_ACCESS === "write" ? "write" : "read" });
  const req = http.request({ socketPath: process.env.PACA_GIT_SOCK, path: "/credential", method: "POST", timeout: 5000 }, (res) => {
    let out = ""; res.on("data", (c) => (out += c)); res.on("end", () => {
      if (res.statusCode !== 200) process.exit(0); // no answer => git fails cleanly, never prompts
      const c = JSON.parse(out);
      process.stdout.write(`username=${c.username}\npassword=${c.secret}\n`);
    });
  });
  req.on("error", () => process.exit(0));
  req.end(body);
});
