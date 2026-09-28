import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createHotspot } from "../server.ts";
import { findMonitor, openMonitor } from "../lib/monitor.ts";

/** A runner for `platform` that records what it runs; `onPath` lists the executables it has. */
function fakeRunner({ platform, env = {}, onPath = [], fail = null } = {}) {
  const calls = [];
  return {
    calls,
    platform,
    env,
    onPath: async (file) => onPath.includes(file),
    run: async (file, args, timeoutMs) => {
      calls.push({ how: "run", file, args: [...args], timeoutMs });
      if (fail !== null) throw new Error(fail);
    },
    start: async (file, args) => {
      calls.push({ how: "start", file, args: [...args] });
      if (fail !== null) throw new Error(fail);
    },
  };
}

test("macOS opens Activity Monitor with `open -a`, fixed argv, waiting at most a few seconds", async () => {
  const runner = fakeRunner({ platform: "darwin" });
  const monitor = await findMonitor(runner);
  assert.equal(monitor.app, "Activity Monitor");
  assert.deepEqual(await openMonitor(monitor, runner), { ok: true, app: "Activity Monitor" });
  assert.equal(runner.calls.length, 1);
  const [call] = runner.calls;
  assert.deepEqual([call.how, call.file, call.args], ["run", "open", ["-a", "Activity Monitor"]]);
  assert.ok(call.timeoutMs > 0 && call.timeoutMs <= 10_000);
});

test("Linux prefers GNOME's monitor, then KDE's, and starts it detached", async () => {
  const env = { DISPLAY: ":0" };
  const gnome = fakeRunner({ platform: "linux", env, onPath: ["ksysguard", "gnome-system-monitor"] });
  const found = await findMonitor(gnome);
  assert.equal(found.file, "gnome-system-monitor");
  assert.deepEqual(await openMonitor(found, gnome), { ok: true, app: "System Monitor" });
  assert.deepEqual(gnome.calls, [{ how: "start", file: "gnome-system-monitor", args: [] }]);

  assert.equal((await findMonitor(fakeRunner({ platform: "linux", env, onPath: ["plasma-systemmonitor", "ksysguard"] }))).file, "plasma-systemmonitor");
  assert.equal((await findMonitor(fakeRunner({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" }, onPath: ["ksysguard"] }))).app, "KSysGuard");
});

test("no monitor on Linux without one installed or without a display, nor on other platforms", async () => {
  assert.equal(await findMonitor(fakeRunner({ platform: "linux", env: { DISPLAY: ":0" } })), null);
  assert.equal(await findMonitor(fakeRunner({ platform: "linux", onPath: ["gnome-system-monitor"] })), null);
  assert.equal(await findMonitor(fakeRunner({ platform: "win32" })), null);
  const runner = fakeRunner({ platform: "win32" });
  const result = await openMonitor(null, runner);
  assert.equal(result.ok, false);
  assert.match(result.error, /No system monitor/);
  assert.deepEqual(runner.calls, [], "nothing is run");
});

test("a failed launch comes back as a message, never a throw", async () => {
  const runner = fakeRunner({ platform: "darwin", fail: "Unable to find application named 'Activity Monitor'" });
  const result = await openMonitor(await findMonitor(runner), runner);
  assert.deepEqual(result, {
    ok: false,
    app: "Activity Monitor",
    error: "Could not open Activity Monitor: Unable to find application named 'Activity Monitor'",
  });
});

async function load(runner) {
  const { bb, harness } = createFakePluginHost({ pluginId: "hotspot" });
  await createHotspot(bb, {
    takeReading: async (at) => ({ live: { at, thermal: 0, cpu: 10, load: 0.1, threads: [], procs: [] }, stored: null }),
    monitor: runner,
  });
  return harness;
}

test("status names the monitor and the machine it opens on; openMonitor runs it", async () => {
  const runner = fakeRunner({ platform: "darwin" });
  const harness = await load(runner);
  const status = await harness.callRpc("status", null);
  assert.equal(status.monitor.app, "Activity Monitor");
  assert.ok(status.monitor.host.length > 0);
  assert.deepEqual(await harness.callRpc("openMonitor", null), { ok: true, app: "Activity Monitor" });
  assert.equal(runner.calls.length, 1);
});

test("with no monitor, status says so and openMonitor answers with an error instead of throwing", async () => {
  const runner = fakeRunner({ platform: "freebsd" });
  const harness = await load(runner);
  assert.equal((await harness.callRpc("status", null)).monitor, null);
  const result = await harness.callRpc("openMonitor", null);
  assert.equal(result.ok, false);
  assert.deepEqual(runner.calls, []);
});
