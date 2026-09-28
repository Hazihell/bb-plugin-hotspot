import assert from "node:assert/strict";
import { test } from "node:test";
import { friendlyName, looksSecret } from "../lib/proc-name.ts";

test("interpreters name the script they run, and its package for index.js and friends", () => {
  assert.equal(friendlyName("node /repo/node_modules/vite/bin/vite.js"), "node · vite");
  assert.equal(friendlyName("node /repo/node_modules/.bin/next dev --port 3000"), "node · next dev");
  assert.equal(friendlyName("node /repo/node_modules/typescript/bin/tsc --watch"), "node · tsc --watch");
  assert.equal(friendlyName("/opt/homebrew/bin/node --max-old-space-size=4096 /repo/node_modules/@biomejs/biome/bin/index.js check"), "node · biome check");
  assert.equal(friendlyName("/usr/bin/python3 -m http.server 8000"), "python3 · http.server");
  assert.equal(friendlyName("node"), "node");
  assert.equal(
    friendlyName("/Users/me/.local/share/fnm/bin/node --conditions node --require /repo/setup.cjs /repo/node_modules/vitest/dist/workers/forks.js"),
    "node · forks",
  );
  assert.equal(friendlyName("node -e require('child_process').exec('curl https://x') /repo/app.js"), "node", "inline code names nothing");
  assert.equal(friendlyName("python3 -c import os; print(os.environ) /repo/x.py"), "python3");
});

test("package runners name the script or package, skipping run and flags", () => {
  assert.equal(friendlyName("/opt/homebrew/bin/pnpm run test"), "pnpm · test");
  assert.equal(friendlyName("pnpm test"), "pnpm · test");
  assert.equal(friendlyName("npm run dev:web"), "npm · dev:web");
  assert.equal(friendlyName("npx -y @playwright/mcp"), "npx · @playwright/mcp");
  assert.equal(friendlyName("npx"), "npx");
});

test("other programs are their basename, plus a known verb or --watch", () => {
  assert.equal(friendlyName("/Users/me/.local/bin/claude --verbose --output-format stream-json"), "claude");
  assert.equal(friendlyName("/opt/homebrew/bin/codex app-server"), "codex app-server");
  assert.equal(friendlyName("/repo/node_modules/@esbuild/darwin-arm64/bin/esbuild --service=0.25.0 --ping"), "esbuild");
  assert.equal(friendlyName("/usr/bin/yes"), "yes");
  assert.equal(friendlyName("tsc --watch --project tsconfig.json"), "tsc --watch");
  assert.equal(friendlyName("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=renderer"), "Google Chrome");
});

test("secrets on the command line never reach the name", () => {
  const secrets = [
    "sk-ant-api03-abcdefghijklmnop",
    "ghp_16C7e42F292c6912E7710c838347Ae178B4a",
    "hunter2hunter2hunter2hunter2",
    "eyJhbGciOiJIUzI1NiJ9",
    "a8f5f167f44f4964e6c998dee827110c",
    "s3cr3tP4ssw0rdXYZ1",
  ];
  const lines = [
    (secret) => `curl -H Authorization: Bearer ${secret} https://api.example.com`,
    (secret) => `node ${secret}`,
    (secret) => `node --token ${secret}`,
    (secret) => `node /repo/server.js --api-key=${secret}`,
    (secret) => `mytool ${secret}`,
    (secret) => `npx ${secret}`,
    (secret) => `pnpm run ${secret}`,
    (secret) => `psql postgres://admin:${secret}@db.internal/app`,
    (secret) => `python3 https://user:${secret}@host/x.py`,
  ];
  for (const secret of secrets) {
    assert.ok(looksSecret(secret), secret);
    for (const make of lines) {
      const name = friendlyName(make(secret));
      assert.ok(!name.includes(secret) && !name.includes(secret.slice(0, 8)), `${make(secret)} → ${name}`);
    }
  }
  assert.equal(friendlyName("mysql -u root -p hunter2 app"), "mysql");
  assert.equal(friendlyName("node --token hunter2 /repo/dev.js"), "node · hunter2", "a plain word after a flag reads as the script; still no flag or value shown with it");
});

test("names stay short", () => {
  assert.ok(friendlyName(`/bin/${"a".repeat(80)}`).length <= 40);
});
