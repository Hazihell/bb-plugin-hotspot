import assert from "node:assert/strict";
import { test } from "node:test";
import { applyKill, checkInteractiveCaller, isInteractiveShell, parseKillLine, planKill, readKillRows } from "../lib/kill.ts";

const THREAD = "thr_target0001";
const OTHER = "thr_other00001";
const UID = 501;
const START = "Mon Sep 28 14:04:23 2026";

/** One `ps -axwwE -o pid=,ppid=,uid=,pcpu=,lstart=,command=` line. */
function line(pid, ppid, command, { uid = UID, cpu = 0, start = START, tty = "??" } = {}) {
  return `${String(pid).padStart(6)} ${String(ppid).padStart(6)} ${String(uid).padStart(5)} ${tty.padEnd(8)} ${cpu.toFixed(1).padStart(5)} ${start}     ${command}`;
}

const BB = "/Applications/bb.app/Contents/MacOS/bb";
const BRIDGE = `${BB} /Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/bb-provider-bridge-worker.mjs`;
const PLUGIN_HOST = `${BB} /Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/bb-plugin-host-worker.mjs`;
const BB_CLI = "node /Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/bb hotspot kill thr_target0001";

/** BB, one agent for THREAD with work under it, another thread, and the user's own apps. */
function table(overrides = {}) {
  const rows = {
    1: line(1, 0, "/sbin/launchd", { uid: 0 }),
    100: line(100, 1, BB),
    200: line(200, 100, BRIDGE),
    300: line(300, 200, `/Users/me/.local/bin/claude --output-format stream-json BB_THREAD_ID=${THREAD} HOME=/Users/me`, { cpu: 6 }),
    // A background tool shell running a dev server with a worker.
    310: line(310, 300, "/bin/zsh -c npm run dev"),
    311: line(311, 310, "node /Users/me/app/node_modules/.bin/next dev", { cpu: 80 }),
    312: line(312, 311, "node /Users/me/app/node_modules/next/dist/server/worker.js", { cpu: 20 }),
    313: line(313, 310, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new --remote-debugging-port=9222", { cpu: 10 }),
    // The foreground tool shell running `bb hotspot kill` itself.
    320: line(320, 300, "/bin/zsh -c bb hotspot kill thr_target0001 | head"),
    321: line(321, 320, BB_CLI),
    322: line(322, 320, "head -c 2500"),
    // A shell that opened the user's editor and ran a system tool and sudo.
    330: line(330, 300, "/bin/zsh -c code ."),
    331: line(331, 330, "/Applications/Visual Studio Code.app/Contents/MacOS/Electron ."),
    340: line(340, 300, "/bin/zsh -c sudo thing"),
    341: line(341, 340, "/usr/libexec/xpcproxy something"),
    342: line(342, 340, "/usr/bin/sudo thing", { uid: 0 }),
    // Another thread's agent and dev server.
    400: line(400, 200, `/Users/me/.local/bin/claude BB_THREAD_ID=${OTHER}`),
    401: line(401, 400, "node vite", { cpu: 50 }),
    // The user's own browser, and the plugin host running Hotspot.
    500: line(500, 1, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", { cpu: 30 }),
    600: line(600, 100, PLUGIN_HOST),
    ...overrides,
  };
  return Object.values(rows).filter((entry) => entry !== null).join("\n");
}

const rowsOf = (stdout) => stdout.split("\n").map((entry) => parseKillLine(entry)).filter(Boolean);
const context = { uid: UID, selfPids: new Set([600, 100, 1]) };

test("parses pid, uid, start time, argv and the thread from a ps -E line", () => {
  const row = parseKillLine(line(311, 310, `node next dev BB_THREAD_ID=${THREAD} PATH=/bin`, { cpu: 12.5 }));
  assert.deepEqual(row, {
    pid: 311,
    ppid: 310,
    uid: 501,
    tty: null,
    cpuPercent: 12.5,
    startedAt: START,
    argv: "node next dev",
    name: "node next dev",
    label: "node · next dev",
    threadId: THREAD,
  });
  assert.equal(parseKillLine("garbage"), null);
});

test("targets only the thread's work, children first", () => {
  const plan = planKill(rowsOf(table()), THREAD, context);
  assert.deepEqual(plan.targets.map((target) => target.pid), [312, 311, 313, 310]);
});

test("never selects the agent, BB, the calling shell, other users, system or app processes", () => {
  const plan = planKill(rowsOf(table()), THREAD, context);
  const reasons = Object.fromEntries(plan.excluded.map((entry) => [entry.pid, entry.reason]));
  assert.match(reasons[300], /agent/);
  assert.match(reasons[321], /BB itself/);
  assert.match(reasons[320], /parent of a protected process/);
  assert.match(reasons[322], /same command as a bb CLI call/);
  assert.match(reasons[331], /an app/);
  assert.match(reasons[330], /parent of a protected process/);
  assert.match(reasons[341], /system/);
  assert.match(reasons[342], /another user/);
  assert.match(reasons[340], /parent of a protected process/);
  // Nothing outside the thread is even listed.
  for (const pid of [1, 100, 200, 400, 401, 500, 600]) {
    assert.equal(plan.targets.some((target) => target.pid === pid), false, `targeted ${pid}`);
    assert.equal(plan.excluded.some((entry) => entry.pid === pid), false, `listed ${pid}`);
  }
});

test("an app launched from a thread is a wall: its terminals are never the thread's", () => {
  // The live tree from the review: Orca was opened from thr_tabbvgxkey, so
  // its helper carries the id and launchd adopted it; its terminals run
  // through login (root) into interactive zsh.
  const orca = "thr_tabbvgxkey";
  const helper = `/Applications/Orca.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper /Applications/Orca.app/Contents/Resources/app.asar`;
  const stdout = table({
    44304: line(44304, 1, `${helper} BB_THREAD_ID=${orca}`),
    45728: line(45728, 44304, "/usr/bin/login -flpq me /bin/bash --noprofile --norc -p -c export", { uid: 0 }),
    45761: line(45761, 45728, "-/bin/zsh -l"),
    45800: line(45800, 45761, "node /Users/me/app/node_modules/.bin/vite", { cpu: 30 }),
    91794: line(91794, 44304, "/usr/bin/login -flpq me /bin/bash --noprofile --norc -p -c export", { uid: 0 }),
    92020: line(92020, 91794, `-/bin/zsh -l BB_THREAD_ID=${orca}`),
  });
  const plan = planKill(rowsOf(stdout), orca, context);
  assert.deepEqual(plan.targets, []);
  const reasons = Object.fromEntries(plan.excluded.map((entry) => [entry.pid, entry.reason]));
  assert.match(reasons[44304], /an app/);
  assert.match(reasons[45728], /another user/);
  assert.match(reasons[92020], /interactive terminal/);
  assert.match(reasons[45761], /interactive terminal/);
  assert.match(reasons[45800], /under zsh \(pid 45761\)/);
});

test("a detached dev server that carries the thread id is the thread's work", () => {
  const stdout = table({
    700: line(700, 1, `node /Users/me/app/node_modules/.bin/next dev BB_THREAD_ID=${THREAD}`, { cpu: 40 }),
    701: line(701, 700, "next-server (v15.5.26)", { cpu: 20 }),
  });
  const plan = planKill(rowsOf(stdout), THREAD, context);
  assert.ok(plan.targets.some((target) => target.pid === 700));
  assert.ok(plan.targets.some((target) => target.pid === 701));
});

test("an interactive shell is recognised by a login dash or by having no command", () => {
  const shell = (argv) => isInteractiveShell({ argv });
  assert.equal(shell("-/bin/zsh -l"), true);
  assert.equal(shell("/bin/zsh -i"), true);
  assert.equal(shell("/bin/bash"), true);
  assert.equal(shell("/bin/zsh -c npm run dev"), false);
  assert.equal(shell("/bin/zsh -lc npm test"), false);
  assert.equal(shell("bash ./start.sh"), false);
  assert.equal(shell("node server.js"), false);
});

test("a relaunching agent and its MCP servers are spared; only work under its shells is targeted", () => {
  // Gemini CLI: BB starts node, which relaunches itself with more heap.
  const gemini = "/opt/homebrew/lib/node_modules/@google/gemini-cli/dist/index.js";
  const stdout = table({
    300: line(300, 200, `node ${gemini} --experimental-acp BB_THREAD_ID=${THREAD}`),
    301: line(301, 300, `node --max-old-space-size=8192 ${gemini} --experimental-acp`, { cpu: 12 }),
    302: line(302, 301, "uvx mcp-server-fetch", { cpu: 1 }),
    303: line(303, 302, "python -m mcp_server_fetch"),
    304: line(304, 301, "/opt/homebrew/bin/rg --json needle"),
    310: line(310, 301, "/bin/bash -c npm run dev"),
    311: line(311, 310, "node /Users/me/app/node_modules/.bin/vite", { cpu: 50 }),
    312: null,
    313: null,
    320: null,
    321: null,
    330: null,
    331: null,
    340: null,
    341: null,
    342: null,
  });
  const plan = planKill(rowsOf(stdout), THREAD, context);
  assert.deepEqual(plan.targets.map((target) => target.pid), [311, 310]);
  const reasons = Object.fromEntries(plan.excluded.map((entry) => [entry.pid, entry.reason]));
  assert.match(reasons[300], /agent \(launched by BB\)/);
  assert.match(reasons[301], /agent, or a launcher/);
  assert.match(reasons[302], /helper/);
  assert.match(reasons[303], /helper/);
  assert.match(reasons[304], /helper/);
});

test("an agent started through npx is spared down to its own shells", () => {
  const stdout = table({
    300: line(300, 200, `node /opt/homebrew/lib/node_modules/npm/bin/npx-cli.js -y @google/gemini-cli BB_THREAD_ID=${THREAD}`),
    301: line(301, 300, "sh -c gemini --yolo"),
    302: line(302, 301, "node /Users/me/.npm/_npx/1a2b/node_modules/.bin/gemini --yolo", { cpu: 8 }),
    303: line(303, 302, "npm exec @playwright/mcp@latest"),
    304: line(304, 303, "/Users/me/Library/Caches/ms-playwright/chromium-1187/chrome-mac/Chromium.app/Contents/MacOS/Chromium --headless"),
    310: line(310, 302, "/bin/zsh -c pytest -q"),
    311: line(311, 310, "python -m pytest -q", { cpu: 70 }),
    312: null,
    313: null,
    320: null,
    321: null,
    330: null,
    331: null,
    340: null,
    341: null,
    342: null,
  });
  const plan = planKill(rowsOf(stdout), THREAD, context);
  assert.deepEqual(plan.targets.map((target) => target.pid), [311, 310]);
  const reasons = Object.fromEntries(plan.excluded.map((entry) => [entry.pid, entry.reason]));
  assert.match(reasons[301], /launcher/);
  assert.match(reasons[302], /launcher/);
  assert.match(reasons[303], /helper/);
  assert.match(reasons[304], /helper/);
});

test("kill --yes is accepted only from a terminal that no agent runs", () => {
  const cli = `node /Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/bb hotspot kill ${THREAD} --yes`;
  const fromTerminal = rowsOf(table({
    900: line(900, 1, "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"),
    901: line(901, 900, "login -pf me", { uid: 0, tty: "ttys003" }),
    902: line(902, 901, "-zsh", { tty: "ttys003" }),
    903: line(903, 902, cli, { tty: "ttys003" }),
  }));
  assert.deepEqual(checkInteractiveCaller(fromTerminal, THREAD), { ok: true });

  // The agent's tool shell: no terminal.
  const fromAgent = rowsOf(table({ 321: line(321, 320, cli) }));
  assert.match(checkInteractiveCaller(fromAgent, THREAD).reason, /not run from an interactive terminal/);

  // An agent whose provider gives its commands a pty is still under the bridge.
  const fromAgentPty = rowsOf(table({ 321: line(321, 320, cli, { tty: "ttys009" }) }));
  assert.match(checkInteractiveCaller(fromAgentPty, THREAD).reason, /run by an agent/);

  assert.match(checkInteractiveCaller(rowsOf(table()), THREAD).reason, /could not find/);
});

test("Codex's commands under sandbox-exec are work; Codex itself is spared", () => {
  const profile = "(version 1) (deny default) (allow file-read*) (allow process-exec)";
  const stdout = table({
    300: line(300, 200, `/opt/homebrew/bin/codex app-server BB_THREAD_ID=${THREAD}`, { cpu: 5 }),
    301: line(301, 300, `/usr/bin/sandbox-exec -p ${profile} -D WRITABLE_ROOT_0=/Users/me/app -- /bin/zsh -lc npm run dev`),
    302: line(302, 301, "/bin/zsh -lc npm run dev"),
    303: line(303, 302, "node /Users/me/app/node_modules/.bin/vite", { cpu: 60 }),
    304: line(304, 300, "/opt/homebrew/bin/rg --files"),
    305: line(305, 300, `/usr/bin/sandbox-exec -p ${profile} -- /opt/homebrew/bin/some-mcp-server`),
    310: null,
    311: null,
    312: null,
    313: null,
    320: null,
    321: null,
    330: null,
    331: null,
    340: null,
    341: null,
    342: null,
  });
  const plan = planKill(rowsOf(stdout), THREAD, context);
  assert.deepEqual(plan.targets.map((target) => target.pid), [303, 302, 301]);
  const reasons = Object.fromEntries(plan.excluded.map((entry) => [entry.pid, entry.reason]));
  assert.match(reasons[300], /agent \(launched by BB\)/);
  assert.match(reasons[304], /helper/);
  assert.match(reasons[305], /helper/);
});

test("a Homebrew terminal opened from a thread is a wall, and so is tmux", () => {
  const stdout = table({
    800: line(800, 1, `/opt/homebrew/Caskroom/alacritty/0.15.1/Alacritty.app/Contents/MacOS/alacritty BB_THREAD_ID=${THREAD}`),
    801: line(801, 800, `/bin/zsh -c tmux attach BB_THREAD_ID=${THREAD}`),
    802: line(802, 801, "tmux attach"),
    810: line(810, 1, `tmux new-session -d BB_THREAD_ID=${THREAD}`),
    811: line(811, 810, "-zsh"),
    812: line(812, 811, "node /Users/me/app/server.js", { cpu: 30 }),
    820: line(820, 1, `/opt/homebrew/bin/kitty BB_THREAD_ID=${THREAD}`),
    821: line(821, 820, "/bin/zsh -c npm start"),
    310: null,
    311: null,
    312: null,
    313: null,
  });
  const plan = planKill(rowsOf(stdout), THREAD, context);
  assert.deepEqual(plan.targets.map((target) => target.pid), []);
  const reasons = Object.fromEntries(plan.excluded.map((entry) => [entry.pid, entry.reason]));
  assert.match(reasons[800], /a terminal/);
  assert.match(reasons[801], /under alacritty \(pid 800\)/);
  assert.match(reasons[810], /a terminal/);
  assert.match(reasons[812], /under zsh \(pid 811\)/);
  assert.match(reasons[820], /a terminal/);
});

test("an app bundle anywhere is a wall; an argument naming a bundle is not", () => {
  const stdout = table({
    850: line(850, 1, `/Users/me/Applications/Zed.app/Contents/MacOS/zed BB_THREAD_ID=${THREAD}`),
    851: line(851, 850, "/bin/zsh -c cargo build"),
    860: line(860, 1, `/opt/homebrew/bin/node /Users/me/tools/Fake.app/Contents/x.js BB_THREAD_ID=${THREAD}`, { cpu: 5 }),
    870: line(870, 1, `/Users/me/Library/Caches/ms-playwright/chromium-1187/chrome-mac/Chromium.app/Contents/MacOS/Chromium --headless BB_THREAD_ID=${THREAD}`),
    880: line(880, 1, `/opt/homebrew/Cellar/python@3.14/3.14.7/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python -m http.server 8899 BB_THREAD_ID=${THREAD}`),
    310: null,
    311: null,
    312: null,
    313: null,
  });
  const plan = planKill(rowsOf(stdout), THREAD, context);
  const reasons = Object.fromEntries(plan.excluded.map((entry) => [entry.pid, entry.reason]));
  assert.match(reasons[850], /an app/);
  assert.match(reasons[851], /under zed/);
  assert.deepEqual(plan.targets.map((target) => target.pid).sort(), [860, 870, 880]);
});

test("a thread with no work of its own plans nothing", () => {
  const plan = planKill(rowsOf(table()), "thr_nothing0001", context);
  assert.deepEqual(plan, { threadId: "thr_nothing0001", targets: [], excluded: [] });
});

test("the plugin's own process chain is never a target even inside the thread", () => {
  const stdout = table({ 312: line(312, 311, "node worker.js", { cpu: 20 }) });
  const plan = planKill(rowsOf(stdout), THREAD, { uid: UID, selfPids: new Set([312]) });
  assert.equal(plan.targets.some((target) => target.pid === 312), false);
  assert.match(plan.excluded.find((entry) => entry.pid === 312).reason, /Hotspot's own/);
});

test("an agent whose parent BB process names the thread is still protected", () => {
  // BB_THREAD_ID on the bridge too: the provider CLI below it is the agent.
  const stdout = table({ 200: line(200, 100, `${BRIDGE} BB_THREAD_ID=${THREAD}`) });
  const plan = planKill(rowsOf(stdout), THREAD, context);
  const reasons = Object.fromEntries(plan.excluded.map((entry) => [entry.pid, entry.reason]));
  assert.match(reasons[200], /BB itself/);
  assert.match(reasons[300], /agent/);
  assert.equal(plan.targets.some((target) => target.pid === 300 || target.pid === 200), false);
});

/** A fake machine: `ps` returns the current table; signals are recorded and can end processes. */
function machine(initial) {
  let stdout = initial;
  const signals = [];
  return {
    signals,
    set(next) {
      stdout = next;
    },
    deps: (overrides = {}) => ({
      readRows: async () => rowsOf(stdout),
      context,
      signal: (pid, signal) => signals.push([pid, signal]),
      sleep: async () => undefined,
      log: () => undefined,
      ...overrides,
    }),
  };
}

test("apply refuses a recycled pid and signals only verified targets", async () => {
  const fake = machine(table());
  const plan = planKill(rowsOf(table()), THREAD, context);
  // Between plan and apply, the headless browser exits and its pid is reused
  // by a new process under the same shell: same pid, still the thread's.
  fake.set(table({ 313: line(313, 310, "/usr/bin/yes", { start: "Mon Sep 28 15:00:00 2026" }) }));
  const logs = [];
  const result = await applyKill(plan, fake.deps({ log: (message) => logs.push(message), sleep: async () => fake.set(table({ 311: null, 312: null, 313: null, 310: null })) }));
  assert.deepEqual(fake.signals, [
    [312, "SIGTERM"],
    [311, "SIGTERM"],
    [310, "SIGTERM"],
  ]);
  const byPid = Object.fromEntries(result.outcomes.map((entry) => [entry.pid, entry]));
  assert.equal(byPid[313].result, "refused");
  assert.match(byPid[313].detail, /different process/);
  assert.equal(result.terminated, 3);
  assert.equal(result.refused, 1);
  assert.match(logs[0], /kill thr_target0001: 4 planned, 3 exited on SIGTERM, 0 needed SIGKILL/);
});

test("apply refuses a target that is no longer the thread's", async () => {
  const fake = machine(table());
  const plan = planKill(rowsOf(table()), THREAD, context);
  // Same pid, start time and command, but now under another thread's agent.
  fake.set(table({ 313: line(313, 400, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new --remote-debugging-port=9222") }));
  const result = await applyKill(plan, fake.deps());
  assert.equal(fake.signals.some(([pid]) => pid === 313), false);
  assert.equal(result.outcomes.find((entry) => entry.pid === 313).result, "refused");
});

test("SIGKILL goes only to verified survivors after the grace period", async () => {
  const fake = machine(table());
  const plan = planKill(rowsOf(table()), THREAD, context);
  let waited = 0;
  const result = await applyKill(
    plan,
    fake.deps({
      graceMs: 5_000,
      sleep: async (ms) => {
        waited = ms;
        // 312 ignored SIGTERM and was reparented to launchd; 313's pid was
        // recycled; 310 and 311 exited.
        fake.set(
          table({
            310: null,
            311: null,
            312: line(312, 1, "node /Users/me/app/node_modules/next/dist/server/worker.js"),
            313: line(313, 1, "/usr/bin/yes", { start: "Mon Sep 28 15:00:00 2026" }),
          }),
        );
      },
    }),
  );
  assert.equal(waited, 5_000);
  assert.deepEqual(
    fake.signals.filter(([, signal]) => signal === "SIGKILL"),
    [[312, "SIGKILL"]],
  );
  assert.equal(result.killed, 1);
  assert.equal(result.terminated, 3);
});

test("readKillRows uses /proc environ off macOS", async () => {
  const stdout = [line(10, 1, "node server.js"), line(11, 10, "node child.js")].join("\n");
  const rows = await readKillRows({
    platform: "linux",
    exec: async (command) => {
      assert.match(command, /ps -eww/);
      return stdout;
    },
    readEnviron: async (pid) => (pid === 10 ? `HOME=/root\0BB_THREAD_ID=${THREAD}\0` : null),
  });
  assert.deepEqual(rows.map((row) => [row.pid, row.threadId, row.argv]), [
    [10, THREAD, "node server.js"],
    [11, null, "node child.js"],
  ]);
});
