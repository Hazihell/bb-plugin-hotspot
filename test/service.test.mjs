import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createHotspot } from "../server.ts";
import { startupDelay } from "../lib/sample.ts";
import { createStore } from "../lib/store.ts";

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const sample = (at) => ({ at, thermal: 0, cpu: 10, load: 0.1, threads: [], procs: [] });

test("startupDelay waits out the rest of the interval after a recent sample", () => {
  assert.equal(startupDelay(null, 100_000, 60_000), 0);
  assert.equal(startupDelay(100_000, 110_000, 60_000), 50_000);
  assert.equal(startupDelay(100_000, 160_000, 60_000), 0);
  assert.equal(startupDelay(200_000, 100_000, 60_000), 0);
});

test("a restarted service does not sample while the last sample is younger than one interval", async () => {
  let calls = 0;
  const { bb, harness } = createFakePluginHost({ pluginId: "hotspot" });
  await createHotspot(bb, {
    takeSample: async (at) => {
      calls += 1;
      return sample(at);
    },
  });
  createStore(bb.storage.database()).addSample(sample(Date.now() - 1_000));
  const service = harness.runService("sampler");
  await tick();
  assert.equal(calls, 0);
  service.controller.abort();
  await service.done;
});

test("a sample that finishes after the service stopped is not written", async () => {
  let release;
  const { bb, harness } = createFakePluginHost({ pluginId: "hotspot" });
  await createHotspot(bb, {
    takeSample: (at) => new Promise((resolve) => (release = () => resolve(sample(at)))),
  });
  const service = harness.runService("sampler");
  await tick();
  assert.equal(typeof release, "function");
  service.controller.abort();
  release();
  await service.done;
  assert.equal(createStore(bb.storage.database()).latestAt(), null);
});
