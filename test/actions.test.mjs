import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createHotspot } from "../server.ts";
import { parseKillLine } from "../lib/kill.ts";

const THREAD = "thr_target0001";
const START = "Mon Sep 28 14:04:23 2026";
const uid = process.getuid();

function line(pid, ppid, command, cpu = 0, tty = "??") {
  return `${pid} ${ppid} ${uid} ${tty} ${cpu.toFixed(1)} ${START}     ${command}`;
}

/** BB (and, below it, the plugin host at pid 600), the thread's agent at 300, and a dev server under its shell. */
const TABLE = [
  line(100, 1, "/Applications/bb.app/Contents/MacOS/bb"),
  line(200, 100, "/Applications/bb.app/Contents/MacOS/bb bb-provider-bridge-worker.mjs"),
  line(300, 200, `/Users/me/.local/bin/claude --verbose BB_THREAD_ID=${THREAD}`),
  line(310, 300, "/bin/zsh -c npm run dev"),
  line(311, 310, "node vite --port 5173", 90),
  line(600, 100, "/Applications/bb.app/Contents/MacOS/bb bb-plugin-host-worker.mjs"),
];

async function load({ status = "active", extra = [] } = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "hotspot" });
  harness.sdk.stub("threads.get", async ({ threadId }) => {
    if (threadId !== THREAD) throw Object.assign(new Error("HTTP 404: Thread not found"), { status: 404 });
    return { id: threadId, title: "Home page", titleFallback: null, status };
  });
  const stopped = [];
  harness.sdk.stub("threads.stop", async ({ threadId }) => {
    stopped.push(threadId);
    return { ok: true };
  });
  let rows = [...TABLE, ...extra].join("\n");
  const signals = [];
  await createHotspot(bb, {
    takeReading: async (at) => ({ live: { at, thermal: 0, cpu: 10, load: 0.1, threads: [], procs: [] }, stored: null }),
    kill: {
      readRows: async () => rows.split("\n").map((entry) => parseKillLine(entry)).filter(Boolean),
      signal: (pid, signal) => {
        signals.push([pid, signal]);
        rows = rows.split("\n").filter((entry) => !entry.startsWith(`${pid} `)).join("\n");
      },
      sleep: async () => undefined,
      selfPid: 600,
    },
  });
  return { bb, harness, signals, stopped };
}

test("agents get no kill or stop tool; only hotspot_history", async () => {
  const { harness } = await load();
  assert.deepEqual(harness.registrations.agentTools.map((tool) => tool.name), ["hotspot_history"]);
});

test("killPlan lists targets and the spared agent; killApply accepts only a minted plan id, once", async () => {
  const { harness, signals } = await load();
  const plan = await harness.callRpc("killPlan", { threadId: THREAD });
  assert.deepEqual(plan.targets.map((target) => target.pid), [311, 310]);
  assert.deepEqual(plan.excluded.map((entry) => [entry.pid, entry.reason]), [[300, "the thread's agent (launched by BB)"]]);
  assert.equal(plan.title, "Home page");

  await assert.rejects(harness.callRpc("killApply", { pid: 311 }));
  await assert.rejects(harness.callRpc("killApply", { planId: "00000000-0000-4000-8000-000000000000" }), /expired/);

  const result = await harness.callRpc("killApply", { planId: plan.planId });
  assert.deepEqual(signals, [[311, "SIGTERM"], [310, "SIGTERM"]]);
  assert.equal(result.terminated, 2);
  await assert.rejects(harness.callRpc("killApply", { planId: plan.planId }), /already used/);
});

test("killPlan refuses a malformed or unknown thread id", async () => {
  const { harness } = await load();
  await assert.rejects(harness.callRpc("killPlan", { threadId: "../../etc" }));
  await assert.rejects(harness.callRpc("killPlan", { threadId: "thr_unknown0001" }), /No BB thread/);
});

test("allowKill off refuses planning, applying and the CLI", async () => {
  const { harness } = await load();
  const plan = await harness.callRpc("killPlan", { threadId: THREAD });
  await harness.setSettings({ allowKill: false });
  await assert.rejects(harness.callRpc("killPlan", { threadId: THREAD }), /turned off/);
  await assert.rejects(harness.callRpc("killApply", { planId: plan.planId }), /turned off/);
  const cli = await harness.runCli(["kill", THREAD]);
  assert.notEqual(cli.exitCode, 0);
  const overview = await harness.callRpc("overview", null);
  assert.equal(overview.allowKill, false);
});

test("bb hotspot kill prints the plan without --yes and applies it with --yes", async () => {
  const { harness, signals } = await load();
  const dry = await harness.runCli(["kill", THREAD]);
  assert.equal(dry.exitCode, 0);
  assert.match(dry.stdout, /Kill plan for "Home page" \(thr_target0001\): 2 process\(es\) get SIGTERM/);
  assert.match(dry.stdout, /Spared:\n  claude .* the thread's agent/);
  assert.match(dry.stdout, /Run again with --yes/);
  assert.deepEqual(signals, []);

  // Run from an agent's shell (no terminal, no caller found): refused.
  const refused = await harness.runCli(["kill", THREAD, "--yes"]);
  assert.notEqual(refused.exitCode, 0);
  assert.match(refused.stderr + refused.stdout, /Refusing --yes/);
  assert.deepEqual(signals, []);
});

test("bb hotspot kill --yes applies the plan when a person runs it in a terminal", async () => {
  const cli = `node /Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/bb hotspot kill ${THREAD} --yes`;
  const { harness, signals } = await load({
    extra: [
      line(900, 1, "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"),
      line(902, 900, "-zsh", 0, "ttys003"),
      line(903, 902, cli, 0, "ttys003"),
    ],
  });
  const applied = await harness.runCli(["kill", THREAD, "--yes"]);
  assert.equal(applied.exitCode, 0);
  assert.match(applied.stdout, /2 exited on SIGTERM, 0 needed SIGKILL, 0 refused/);
  assert.equal(signals.length, 2);
});

test("stopTurn stops a running thread and refuses an idle one", async () => {
  const running = await load();
  assert.deepEqual(await running.harness.callRpc("stopTurn", { threadId: THREAD }), { ok: true });
  assert.deepEqual(running.stopped, [THREAD]);

  const idle = await load({ status: "idle" });
  await assert.rejects(idle.harness.callRpc("stopTurn", { threadId: THREAD }), /not running/);
  assert.deepEqual(idle.stopped, []);
});
