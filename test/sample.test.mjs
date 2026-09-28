import assert from "node:assert/strict";
import { test } from "node:test";
import { DARWIN_PS } from "../lib/procs.ts";
import { createSampler } from "../lib/sample.ts";

const THREAD = "thr_aaaaaaaaaa";
const EARLY = "Mon Sep 28 09:00:00 2026";
const LATE = "Mon Sep 28 14:04:23 2026";

/** `ps time` the way macOS prints it: minutes, seconds, centiseconds. */
function psTime(ms) {
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}:${((ms % 60_000) / 1000).toFixed(2).padStart(5, "0")}`;
}

/**
 * A fake Mac with four cores: a process table the test edits between
 * readings, a clock it moves, and kernel ticks it sets.
 */
function fakeMac() {
  const mac = {
    /** pid → { ppid, pcpu, cpuMs, start, command } */
    procs: new Map(),
    clockMs: 0,
    ticks: { busy: 0, total: 0 },
    commands: [],
  };
  const processes = {
    platform: "darwin",
    async exec(command) {
      mac.commands.push(command);
      return [...mac.procs]
        .map(([pid, p]) => `${pid} ${p.ppid} ${p.pcpu.toFixed(1)} 1024 ${psTime(p.cpuMs)} ${p.start} ${p.command}`)
        .join("\n");
    },
    async readEnviron() {
      return null;
    },
  };
  const memory = { platform: "linux", exec: async () => "", readFile: async () => "MemTotal: 1000 kB\nMemAvailable: 500 kB" };
  const takeReading = createSampler({
    processes,
    memory,
    thermal: async () => 0,
    cores: 4,
    clock: () => mac.clockMs,
    ticks: () => mac.ticks,
  });
  /** Let `seconds` pass, with each named pid using `busy[pid]` cores meanwhile. */
  mac.advance = (seconds, busy = {}) => {
    mac.clockMs += seconds * 1000;
    mac.ticks = { busy: mac.ticks.busy, total: mac.ticks.total + seconds * 1000 * 4 };
    for (const [pid, cores] of Object.entries(busy)) {
      mac.procs.get(Number(pid)).cpuMs += seconds * 1000 * cores;
      mac.ticks.busy += seconds * 1000 * cores;
    }
  };
  mac.read = (store = false) => takeReading(mac.clockMs, { store });
  return mac;
}

const threadCpu = (sample) => Object.fromEntries(sample.threads.map((entry) => [entry.threadId, entry.cpu]));
const procCpu = (sample) => Object.fromEntries(sample.procs.map((entry) => [entry.pid, entry.cpu]));

function withAgent(mac, pcpu = 40) {
  mac.procs.set(200, { ppid: 1, pcpu, cpuMs: 60_000, start: EARLY, command: `node agent.js BB_THREAD_ID=${THREAD}` });
}

test("one ps per reading, and the first reading falls back to ps pcpu", async () => {
  const mac = fakeMac();
  withAgent(mac, 40);
  mac.advance(2);
  const { live } = await mac.read();
  assert.deepEqual(mac.commands, [DARWIN_PS]);
  // 40% of one core is 10% of four.
  assert.deepEqual(threadCpu(live), { [THREAD]: 10 });
});

test("per-process CPU is CPU time over wall time, as a share of all cores", async () => {
  const mac = fakeMac();
  withAgent(mac, 5);
  await mac.read();
  mac.advance(2, { 200: 2 });
  const { live } = await mac.read();
  // Two busy cores of four, whatever ps's decaying pcpu says.
  assert.deepEqual(threadCpu(live), { [THREAD]: 50 });
  assert.equal(live.cpu, 50);

  mac.advance(2);
  const idle = await mac.read();
  assert.deepEqual(threadCpu(idle.live), {});
});

test("a reused pid falls back to pcpu instead of spiking", async () => {
  const mac = fakeMac();
  mac.procs.set(300, { ppid: 1, pcpu: 1, cpuMs: 1_000, start: EARLY, command: "/usr/bin/old" });
  await mac.read();
  // Same pid, a different process with far more CPU time than the old one had.
  mac.procs.set(300, { ppid: 1, pcpu: 20, cpuMs: 500_000, start: LATE, command: "/usr/bin/new" });
  mac.advance(2);
  const { live } = await mac.read();
  assert.deepEqual(procCpu(live), { 300: 5 });
});

test("a new process falls back to pcpu and an exited one drops out", async () => {
  const mac = fakeMac();
  mac.procs.set(300, { ppid: 1, pcpu: 0, cpuMs: 1_000, start: EARLY, command: "/usr/bin/leaving" });
  await mac.read();
  mac.procs.delete(300);
  mac.procs.set(301, { ppid: 1, pcpu: 80, cpuMs: 900, start: LATE, command: "/usr/bin/arriving" });
  mac.advance(2, { 301: 0 });
  const { live } = await mac.read();
  assert.deepEqual(procCpu(live), { 301: 20 });

  mac.advance(2, { 301: 1 });
  assert.deepEqual(procCpu((await mac.read()).live), { 301: 25 });
});

test("readings too close together keep ps pcpu rather than divide by almost nothing", async () => {
  const mac = fakeMac();
  withAgent(mac, 12);
  await mac.read();
  mac.procs.get(200).cpuMs += 10;
  const { live } = await mac.read();
  assert.deepEqual(threadCpu(live), { [THREAD]: 3 });
});

test("a stored sample measures its whole interval, not the last live reading", async () => {
  const mac = fakeMac();
  withAgent(mac);
  await mac.read(true);
  // Busy on two cores for the first half of the minute, idle for the rest,
  // with a live reading every two seconds.
  for (let second = 2; second <= 60; second += 2) {
    mac.advance(2, second <= 30 ? { 200: 2 } : {});
    if (second < 60) {
      const { live, stored } = await mac.read();
      assert.equal(stored, null);
      assert.equal(threadCpu(live)[THREAD] ?? 0, second <= 30 ? 50 : 0);
    }
  }
  const { live, stored } = await mac.read(true);
  assert.deepEqual(threadCpu(live), {});
  assert.deepEqual(threadCpu(stored), { [THREAD]: 25 });
  assert.equal(stored.cpu, 25);
  assert.equal(live.cpu, 0);
});
