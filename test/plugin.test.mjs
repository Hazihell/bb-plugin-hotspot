import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { MIGRATIONS, createStore } from "../lib/store.ts";

const MINUTE = 60_000;

const THREADS = {
  // An untitled thread: BB names it by its fallback title.
  thr_hotthread1: { title: null, titleFallback: "Run the e2e suite" },
};

/** Load the plugin in the SDK's fake host with one stored episode. */
async function loadWithEpisode() {
  const { bb, harness } = createFakePluginHost({ pluginId: "hotspot" });
  harness.sdk.stub("threads.get", async ({ threadId }) => {
    const thread = THREADS[threadId];
    if (thread === undefined) throw Object.assign(new Error("HTTP 404: Thread not found"), { status: 404 });
    return { id: threadId, ...thread };
  });
  await plugin(bb);
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
  return { bb, harness };
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
  assert.equal(MIGRATIONS.length, 3);
});

test("hotspot_history names the culprit thread for a window", async () => {
  const { harness } = await loadWithEpisode();
  const text = await runTool(harness, { since: "2h" });
  assert.match(text, /peak thermal heavy, peak CPU 94%/);
  assert.match(text, /1\. Run the e2e suite \(thr_hotthread1\)\s+avg 45%/);
  assert.match(text, /Window:\n1 samples: CPU avg 94%/);
  assert.match(text, /  1\. Run the e2e suite \(thr_hotthread1\)  avg 70%/);
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
  const { harness } = await loadWithEpisode();
  const episodes = await harness.runCli(["episodes", "--since", "1h"]);
  assert.equal(episodes.exitCode, 0);
  assert.match(episodes.stdout, /Run the e2e suite/);

  const json = await harness.runCli(["episodes", "--since", "1h", "--json"]);
  assert.equal(JSON.parse(json.stdout).episodes.length, 1);

  const status = await harness.runCli(["status"]);
  assert.match(status.stdout, /thermal heavy, CPU 94%/);
  assert.match(status.stdout, /thread  70%  Run the e2e suite/);
  assert.doesNotMatch(status.stdout + episodes.stdout + json.stdout, /thr_aaaaaaaaaa/);

  const bad = await harness.runCli(["episodes", "--limit", "500"]);
  assert.notEqual(bad.exitCode, 0);
});
