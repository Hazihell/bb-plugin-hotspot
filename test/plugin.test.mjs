import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { createHotspot } from "../server.ts";
import { MIGRATIONS, createStore } from "../lib/store.ts";

const MINUTE = 60_000;

const THREADS = {
  // An untitled thread: BB names it by its fallback title.
  thr_hotthread1: { title: null, titleFallback: "Run the e2e suite" },
};

/** What an on-demand reading sees: the same hot machine as the stored sample. */
function hotReading(at) {
  return {
    at,
    thermal: 2,
    cpu: 94,
    load: 1.4,
    memory: null,
    threads: [
      { threadId: "thr_aaaaaaaaaa", cpu: 90, processes: 1, memBytes: null },
      { threadId: "thr_hotthread1", cpu: 70, processes: 6, memBytes: null },
    ],
    procs: [],
  };
}

/** Load the plugin in the SDK's fake host with one stored episode. */
async function loadWithEpisode() {
  const { bb, harness } = createFakePluginHost({ pluginId: "hotspot" });
  const readings = [];
  harness.sdk.stub("threads.get", async ({ threadId }) => {
    const thread = THREADS[threadId];
    if (thread === undefined) throw Object.assign(new Error("HTTP 404: Thread not found"), { status: 404 });
    return { id: threadId, ...thread };
  });
  await createHotspot(bb, {
    takeReading: async (at, options) => {
      readings.push(options);
      return { live: hotReading(at), stored: null };
    },
  });
  const store = createStore(bb.storage.database());
  const start = Date.now() - 30 * MINUTE;
  store.saveEpisode({
    id: null,
    startAt: start,
    endAt: start + 20 * MINUTE,
    lastHotAt: start + 20 * MINUTE,
    peakThermal: 2,
    peakCpu: 94,
    samples: 20,
    // Written the way an older build stored it: a frozen null title, and a
    // culprit id that names no thread. Both must read correctly.
    culprits: [
      { threadId: "thr_aaaaaaaaaa", title: "Stale", cpuSum: 1200, samples: 20, peakCpu: 90 },
      { threadId: "thr_hotthread1", title: null, cpuSum: 900, samples: 20, peakCpu: 70 },
    ],
    others: [{ name: "WindowServer", cpuSum: 40, samples: 20 }],
  });
  store.addSample({
    at: start + 5 * MINUTE,
    thermal: 2,
    cpu: 94,
    load: 1.4,
    threads: [
      { threadId: "thr_aaaaaaaaaa", cpu: 90, processes: 1 },
      { threadId: "thr_hotthread1", cpu: 70, processes: 6 },
    ],
    procs: [],
  });
  return { bb, harness, readings };
}

function runTool(harness, params) {
  const tool = harness.registrations.agentTools.find((entry) => entry.name === "hotspot_history");
  const parsed = tool.parse(params);
  assert.equal(parsed.ok, true, parsed.error);
  return tool.execute(parsed.value, { threadId: "thr_caller0000", projectId: "proj_x", signal: new AbortController().signal });
}

test("the plugin loads in the fake host with one sampler service", async () => {
  const { harness } = await loadWithEpisode();
  assert.deepEqual(harness.registrations.services.map((entry) => entry.name), ["sampler"]);
  assert.equal(MIGRATIONS.length, 7);
});

test("hotspot_history names the culprit thread for a window", async () => {
  const { harness } = await loadWithEpisode();
  const text = await runTool(harness, { since: "2h" });
  assert.match(text, /peak thermal heavy, peak CPU 94%/);
  assert.match(text, /1\. Run the e2e suite \(thr_hotthread1\)\s+avg 45%/);
  assert.match(text, /Window:\n1 samples: CPU avg 94%/);
  assert.match(text, /  1\. Run the e2e suite \(thr_hotthread1\)  CPU avg 70%/);
  assert.match(text, /Memory: not recorded in this window/);
  assert.doesNotMatch(text, /thr_aaaaaaaaaa|Stale/);
  assert.ok(text.length <= 8_000);
});

test("hotspot_history reports an unreadable time as a tool error", async () => {
  const { harness } = await loadWithEpisode();
  const result = await runTool(harness, { since: "teatime" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Cannot read time "teatime"/);
});

test("bb hotspot episodes and status print bounded text", async () => {
  const { harness, readings } = await loadWithEpisode();
  const episodes = await harness.runCli(["episodes", "--since", "1h"]);
  assert.equal(episodes.exitCode, 0);
  assert.match(episodes.stdout, /Run the e2e suite/);

  const json = await harness.runCli(["episodes", "--since", "1h", "--json"]);
  assert.equal(JSON.parse(json.stdout).episodes.length, 1);

  const status = await harness.runCli(["status"]);
  assert.match(status.stdout, /thermal heavy, CPU 94%/);
  assert.match(status.stdout, /thread  70%  Run the e2e suite/);
  // Status takes a fresh reading that leaves the live window alone, and reuses it for a few seconds.
  assert.deepEqual(readings, [{ store: false, peek: true }]);
  await harness.runCli(["status"]);
  assert.equal(readings.length, 1);
  assert.doesNotMatch(status.stdout + episodes.stdout + json.stdout, /thr_aaaaaaaaaa/);

  const bad = await harness.runCli(["episodes", "--limit", "500"]);
  assert.notEqual(bad.exitCode, 0);
});

test("detector state kept in KV by an earlier build is adopted once and the key removed", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "hotspot" });
  const streak = { id: null, startAt: 1, endAt: null, lastHotAt: 1, peakThermal: 1, peakCpu: 50, samples: 2, culprits: [], others: [] };
  await bb.storage.kv.set("detector", { streak, open: null, normalStreak: 0, lastAt: 1 });
  await plugin(bb);
  assert.equal((await bb.storage.kv.get("detector")) ?? null, null);
  assert.deepEqual(createStore(bb.storage.database()).detectorState().streak, streak);
  assert.equal(harness.registrations.services.length, 1);
});

test("an episode left open behind a reset detector state is closed at load", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "hotspot" });
  await plugin(bb);
  const db = bb.storage.database();
  const orphan = createStore(db).saveEpisode({
    id: null, startAt: 1_000, endAt: null, lastHotAt: 4_000, peakThermal: 2, peakCpu: 90, samples: 3, culprits: [], others: [],
  });
  db.prepare(`INSERT OR REPLACE INTO state (key, value) VALUES ('detector', '{"garbage":true}')`).run();
  const reloaded = await harness.reload(plugin);
  assert.equal(createStore(reloaded.bb.storage.database()).episode(orphan.id).endAt, 4_000);
});
