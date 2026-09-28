/**
 * Secrets on real command lines never reach any surface: the popover's
 * payload, stored rows, `bb hotspot status`, the agent tool, and kill plans.
 * Each command is a leak the naming review found, run through the real
 * sampler and the real plugin.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createHotspot } from "../server.ts";
import { step } from "../lib/episodes.ts";
import { parseKillLine } from "../lib/kill.ts";
import { createSampler } from "../lib/sample.ts";
import { createStore } from "../lib/store.ts";

const SECRET = "hunter2";
const THREAD = "thr_leaktest01";
const START = "Mon Sep 28 09:00:00 2026";
/** The review's cases, and the older helper's: short secrets no "looks like a key" test catches. */
const LEAKS = [
  `npm --otp ${SECRET} publish`,
  `yarn --cwd ${SECRET} dev`,
  `pnpm --filter ${SECRET} dev`,
  `node --cpu-prof-dir ${SECRET} app.js`,
  `ruby -I ${SECRET} x.rb`,
  `mytool ${SECRET} /Applications/X.app/Contents/MacOS/X`,
  `/Applications/Foo.app/Contents/MacOS/Foo ${SECRET}`,
  `mysql -p${SECRET} app`,
  // Second review: words shown only from lists, inline code, per-interpreter flags.
  `node ${SECRET}`,
  `npm ${SECRET}`,
  `npm run ${SECRET}`,
  `make ${SECRET}`,
  `python3 -m ${SECRET}`,
  `node --eval=main ${SECRET}`,
  `php -r echo ${SECRET}`,
  `git commit -m --${SECRET}`,
];

/** A Mac whose thread runs the first half of LEAKS and whose other apps run the rest. */
function processSource() {
  let minutes = 0;
  const exec = async () => {
    // Each reading, every process has used ten more seconds of CPU.
    minutes += 1;
    const time = `${minutes * 10}:00.00`;
    const lines = [`200 1 5.0 1024 ${time} ${START} /Users/me/.local/bin/claude --verbose BB_THREAD_ID=${THREAD}`];
    LEAKS.forEach((command, index) => {
      const inThread = index % 2 === 0;
      lines.push(`${300 + index} ${inThread ? 200 : 1} ${(40 - index).toFixed(1)} 1024 ${time} ${START} ${command}`);
    });
    return lines.join("\n");
  };
  return { platform: "darwin", exec, readEnviron: async () => null };
}

async function load() {
  const { bb, harness } = createFakePluginHost({ pluginId: "hotspot" });
  harness.sdk.stub("threads.get", async ({ threadId }) => ({ id: threadId, title: "Leaky", titleFallback: null, status: "idle" }));
  let clock = 0;
  const takeReading = createSampler({
    processes: processSource(),
    memory: { platform: "linux", exec: async () => "", readFile: async () => "MemTotal: 1000 kB\nMemAvailable: 500 kB" },
    thermal: async () => 2,
    cores: 4,
    clock: () => (clock += 60_000),
    ticks: () => ({ busy: clock * 3, total: clock * 4 }),
  });
  await createHotspot(bb, { takeReading });
  return { bb, harness, takeReading };
}

const clean = (surface, text) => assert.doesNotMatch(text, new RegExp(SECRET), `${surface} leaks: ${text.slice(0, 2000)}`);

test("no surface shows a secret from a command line", async () => {
  const { bb, harness, takeReading } = await load();

  // Three hot stored samples open a hot spell, written the way the service writes them.
  const store = createStore(bb.storage.database());
  let state = { streak: null, open: null, normalStreak: 0, lastAt: null, lastIntervalMs: null };
  const now = Date.now();
  for (let minute = 3; minute >= 1; minute -= 1) {
    const { stored } = await takeReading(now - minute * 60_000, { store: true });
    const result = step(state, stored, { cpuThreshold: 80, openAfter: 3, closeAfter: 3, intervalMs: 60_000, gapIntervals: 3 });
    state = store.commitStep({ sample: stored, closed: result.closed, updated: result.updated, state: result.state }).state;
  }

  const status = await harness.runCli(["status"]);
  assert.equal(status.exitCode, 0);
  clean("bb hotspot status", status.stdout);
  // The drill-down and the outside-BB line are really there, just safely named.
  assert.match(status.stdout, /npm \(pid 300\)/);
  assert.match(status.stdout, /other .* yarn \(pid 301\)/);
  clean("bb hotspot status --json", (await harness.runCli(["status", "--json"])).stdout);

  const popover = await harness.callRpc("status", null);
  assert.ok(popover.latest.threads[0].top.length > 0);
  clean("status RPC (popover)", JSON.stringify(popover));
  clean("overview RPC", JSON.stringify(await harness.callRpc("overview", null)));

  const db = bb.storage.database();
  const rows = JSON.stringify([
    db.prepare("SELECT * FROM samples").all(),
    db.prepare("SELECT * FROM episodes").all(),
    db.prepare("SELECT * FROM state").all(),
  ]);
  assert.match(db.prepare("SELECT culprits FROM episodes").get().culprits, /"procs":\[\{"name":"npm"/, "a culprit's processes are stored");
  clean("stored rows", rows);

  const tool = harness.registrations.agentTools.find((entry) => entry.name === "hotspot_history");
  const result = await tool.execute(tool.parse({ since: "1h" }).value, {
    threadId: "thr_caller0000", projectId: "proj_x", signal: new AbortController().signal,
  });
  const text = typeof result === "string" ? result : JSON.stringify(result);
  assert.match(text, /processes: npm avg/);
  clean("hotspot_history tool", text);
  clean("bb hotspot episodes", (await harness.runCli(["episodes", "--since", "1h", "--json"])).stdout);
});

test("kill plans, their results and bb hotspot kill show no secret", async () => {
  const uid = process.getuid();
  const line = (pid, ppid, command) => `${pid} ${ppid} ${uid} ?? 10.0 ${START}     ${command}`;
  let rows = [
    line(100, 1, "/Applications/bb.app/Contents/MacOS/bb"),
    line(150, 100, `/Users/me/.local/bin/claude --verbose BB_THREAD_ID=${THREAD}`),
    line(160, 150, "/bin/zsh -c work"),
    ...LEAKS.map((command, index) => line(400 + index, 160, command)),
    line(600, 100, "/Applications/bb.app/Contents/MacOS/bb bb-plugin-host-worker.mjs"),
  ].join("\n");
  const { bb, harness } = createFakePluginHost({ pluginId: "hotspot" });
  harness.sdk.stub("threads.get", async ({ threadId }) => ({ id: threadId, title: "Leaky", titleFallback: null, status: "idle" }));
  await createHotspot(bb, {
    takeReading: async (at) => ({ live: { at, thermal: 0, cpu: 10, load: 0.1, threads: [], procs: [] }, stored: null }),
    kill: {
      readRows: async () => rows.split("\n").map((entry) => parseKillLine(entry)).filter(Boolean),
      signal: (pid) => {
        rows = rows.split("\n").filter((entry) => !entry.startsWith(`${pid} `)).join("\n");
      },
      sleep: async () => undefined,
      selfPid: 600,
    },
  });
  const plan = await harness.callRpc("killPlan", { threadId: THREAD });
  const listed = new Set([...plan.targets, ...plan.excluded].map((entry) => entry.pid));
  assert.ok(LEAKS.every((_, index) => listed.has(400 + index)), "every leaky process is in the plan");
  clean("kill plan", JSON.stringify(plan));
  clean("bb hotspot kill", (await harness.runCli(["kill", THREAD])).stdout);
  clean("bb hotspot kill --json", (await harness.runCli(["kill", THREAD, "--json"])).stdout);
  clean("kill result", JSON.stringify(await harness.callRpc("killApply", { planId: plan.planId })));
  clean("logs", JSON.stringify(harness.inspection.logEntries));
});
