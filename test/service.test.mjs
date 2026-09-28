import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createHotspot } from "../server.ts";
import { startupDelay } from "../lib/sample.ts";
import { LIVE, RUNNING_CHANGED, SAMPLED } from "../lib/signals.ts";
import { createStore } from "../lib/store.ts";

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const sample = (at, cpu = 10) => ({ at, thermal: 0, cpu, load: 0.1, threads: [], procs: [] });

/** A sampler that records what it was asked for and reports `cpu` (and `threads`) on both windows. */
function recordingSampler(cpu = 10, threads = []) {
  const calls = [];
  return {
    calls,
    takeReading: async (at, options) => {
      calls.push(options.store);
      const reading = () => ({ ...sample(at, cpu), threads });
      return { live: reading(), stored: options.store ? reading() : null };
    },
  };
}

test("startupDelay waits out the rest of the interval after a recent sample", () => {
  assert.equal(startupDelay(null, 100_000, 60_000), 0);
  assert.equal(startupDelay(100_000, 110_000, 60_000), 50_000);
  assert.equal(startupDelay(100_000, 160_000, 60_000), 0);
  assert.equal(startupDelay(200_000, 100_000, 60_000), 0);
});

test("a restarted service does not sample while the last sample is younger than one interval", async () => {
  const sampler = recordingSampler();
  const { bb, harness } = createFakePluginHost({ pluginId: "hotspot" });
  await createHotspot(bb, { takeReading: sampler.takeReading });
  createStore(bb.storage.database()).addSample(sample(Date.now() - 1_000));
  const service = harness.runService("sampler");
  await tick();
  assert.deepEqual(sampler.calls, []);
  service.controller.abort();
  await service.done;
});

test("a sample that finishes after the service stopped is not written", async () => {
  let release;
  const { bb, harness } = createFakePluginHost({ pluginId: "hotspot" });
  await createHotspot(bb, {
    takeReading: (at, options) =>
      new Promise((resolve) => (release = () => resolve({ live: sample(at), stored: options.store ? sample(at) : null }))),
  });
  const service = harness.runService("sampler");
  await tick();
  assert.equal(typeof release, "function");
  service.controller.abort();
  release();
  await service.done;
  assert.equal(createStore(bb.storage.database()).latestAt(), null);
});

/** Loaded with a stored sample a second old, so the next stored one is a minute away. */
async function loadWatched(cpu) {
  const sampler = recordingSampler(cpu);
  const { bb, harness } = createFakePluginHost({ pluginId: "hotspot" });
  await createHotspot(bb, { takeReading: sampler.takeReading, liveIntervalMs: 10, watchLeaseMs: 150 });
  const store = createStore(bb.storage.database());
  store.addSample(sample(Date.now() - 1_000));
  const service = harness.runService("sampler");
  const signals = (channel) => harness.inspection.realtimeSignals.filter((signal) => signal.channel === channel);
  return { sampler, harness, store, service, signals };
}

test("live readings are pushed but never stored and never open an episode", async () => {
  const { sampler, harness, store, service, signals } = await loadWatched(100);
  await tick();
  assert.deepEqual(sampler.calls, [], "nobody watches yet");

  await harness.callRpc("watch", null);
  await tick(100);
  assert.ok(sampler.calls.length >= 4, `live readings: ${sampler.calls.length}`);
  assert.ok(sampler.calls.every((store) => store === false));
  assert.ok(signals(LIVE).length >= 4);
  assert.equal(signals(LIVE).at(-1).payload.cpu, 100);
  assert.equal(signals(SAMPLED).length, 0);
  assert.equal(store.samples(0, Date.now()).length, 1);
  // Fifty readings at 100% CPU would open an episode after three if they counted.
  assert.equal(store.episodes(0, Date.now() + 1, 10).length, 0);
  assert.equal(store.detectorState()?.streak ?? null, null);

  const status = await harness.callRpc("status", null);
  assert.equal(status.latest.cpu, 100, "status shows the newest live reading");
  service.controller.abort();
  await service.done;
});

test("live readings stop when the lease lapses and start again on the next heartbeat", async () => {
  const { sampler, harness, service } = await loadWatched(10);
  await harness.callRpc("watch", null);
  await tick(250);
  const stopped = sampler.calls.length;
  assert.ok(stopped > 0);
  await tick(100);
  assert.equal(sampler.calls.length, stopped, "no readings once the lease lapsed");
  assert.ok(
    harness.inspection.logEntries.some((entry) => /live readings stopped: the last heartbeat arrived 0\.\d s ago/.test(entry.message)),
  );

  await harness.callRpc("watch", { reason: "focus" });
  await tick(50);
  assert.ok(sampler.calls.length > stopped, "a heartbeat wakes the sleeping sampler");
  assert.ok(harness.inspection.logEntries.some((entry) => entry.message === "live readings started by a heartbeat (focus)"));
  await assert.rejects(harness.callRpc("watch", { reason: "because" }));
  service.controller.abort();
  await service.done;
});

test("a due sample is stored once per interval while live readings run", async () => {
  const sampler = recordingSampler();
  const { bb, harness } = createFakePluginHost({ pluginId: "hotspot" });
  await createHotspot(bb, { takeReading: sampler.takeReading, liveIntervalMs: 10, watchLeaseMs: 1_000 });
  const store = createStore(bb.storage.database());
  await harness.callRpc("watch", null);
  const service = harness.runService("sampler");
  await tick(100);
  // No earlier sample: the first reading is stored, the rest are live only.
  assert.equal(sampler.calls[0], true);
  assert.ok(sampler.calls.slice(1).every((stored) => stored === false));
  assert.ok(sampler.calls.length >= 4);
  assert.equal(store.samples(0, Date.now()).length, 1);
  service.controller.abort();
  await service.done;
});

test("setting the wall clock back an hour neither stalls live readings, stores an extra sample nor stretches the lease", async () => {
  const realNow = Date.now;
  const { sampler, harness, store, service, signals } = await loadWatched(10);
  try {
    await harness.callRpc("watch", null);
    await tick(60);
    const before = sampler.calls.length;
    Date.now = () => realNow() - 3_600_000;
    await harness.callRpc("watch", null);
    await tick(100);
    assert.ok(sampler.calls.length >= before + 4, `live readings after the jump: ${sampler.calls.length - before}`);
    assert.ok(sampler.calls.every((stored) => stored === false));
    assert.equal(store.samples(0, realNow()).length, 1);
    assert.equal(signals(SAMPLED).length, 0);
    // The newest reading is the live one, though its stamp is an hour older than the stored sample.
    const status = await harness.callRpc("status", null);
    assert.equal(status.latest.at, signals(LIVE).at(-1).payload.at);
    // And the lease still lapses on time: a wall-clock lease would last another hour.
    await tick(250);
    const lapsed = sampler.calls.length;
    await tick(100);
    assert.equal(sampler.calls.length, lapsed);
  } finally {
    Date.now = realNow;
    service.controller.abort();
    await service.done;
  }
});

test("a shown thread starting or ending a turn is announced; other threads are not", async () => {
  const shown = { threadId: "thr_shownthread", cpu: 40, processes: 2, memBytes: null };
  const sampler = recordingSampler(50, [shown]);
  const { bb, harness } = createFakePluginHost({ pluginId: "hotspot" });
  harness.sdk.stub("threads.get", async ({ threadId }) => ({ id: threadId, title: "Shown", titleFallback: null, status: "idle" }));
  await createHotspot(bb, { takeReading: sampler.takeReading });
  await harness.runCli(["status"]);
  const thread = (id) => ({ thread: { id } });
  await harness.emitThreadEvent("thread.active", thread("thr_shownthread"));
  await harness.emitThreadEvent("thread.idle", { ...thread("thr_shownthread"), lastAssistantText: null });
  await harness.emitThreadEvent("thread.active", thread("thr_otherthread"));
  const announced = harness.inspection.realtimeSignals.filter((signal) => signal.channel === RUNNING_CHANGED);
  assert.deepEqual(announced.map((signal) => signal.payload), [
    { threadId: "thr_shownthread", running: true },
    { threadId: "thr_shownthread", running: false },
  ]);
});
