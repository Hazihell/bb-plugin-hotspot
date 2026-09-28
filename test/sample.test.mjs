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
      if (mac.failNext) {
        mac.failNext = false;
        throw new Error("ps: interrupted");
      }
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
  mac.takeReading = takeReading;
  mac.read = (store = false) => takeReading(mac.clockMs, { store });
  return mac;
}

const threadCpu = (sample) => Object.fromEntries(sample.threads.map((entry) => [entry.threadId, entry.cpu]));
const procCpu = (sample) => Object.fromEntries(sample.procs.map((entry) => [entry.pid, entry.cpu]));

function withAgent(mac, pcpu = 40) {
  mac.procs.set(200, { ppid: 1, pcpu, cpuMs: 60_000, start: EARLY, command: `node agent.js BB_THREAD_ID=${THREAD}` });
}

test("one ps per reading, and the first reading after a load falls back to ps pcpu", async () => {
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

test("a reused pid is a new process, not measured against the old one's time", async () => {
  const mac = fakeMac();
  mac.procs.set(300, { ppid: 1, pcpu: 1, cpuMs: 100_000, start: EARLY, command: "/usr/bin/old" });
  await mac.read();
  // Same pid, a different process: its 1 s of CPU time all fell inside the 2 s window.
  mac.procs.set(300, { ppid: 1, pcpu: 90, cpuMs: 1_000, start: LATE, command: "/usr/bin/new" });
  mac.advance(2);
  const { live } = await mac.read();
  assert.deepEqual(procCpu(live), { 300: 12.5 });
});

test("a new process counts all its CPU time in its first reading and an exited one drops out", async () => {
  const mac = fakeMac();
  mac.procs.set(300, { ppid: 1, pcpu: 0, cpuMs: 1_000, start: EARLY, command: "/usr/bin/leaving" });
  await mac.read();
  mac.procs.delete(300);
  // Started inside the window and used 1.6 s of one core; ps's pcpu (80) is not used.
  mac.procs.set(301, { ppid: 1, pcpu: 80, cpuMs: 1_600, start: LATE, command: "/usr/bin/arriving" });
  mac.advance(2);
  const { live } = await mac.read();
  assert.deepEqual(procCpu(live), { 301: 20 });

  mac.advance(2, { 301: 1 });
  assert.deepEqual(procCpu((await mac.read()).live), { 301: 25 });
});

test("a process is never credited more than every core for the whole window", async () => {
  const mac = fakeMac();
  await mac.read();
  mac.procs.set(302, { ppid: 1, pcpu: 5, cpuMs: 500_000, start: LATE, command: "/usr/bin/odd" });
  mac.advance(2);
  assert.deepEqual(procCpu((await mac.read()).live), { 302: 100 });
});

test("after a failed ps, a process the reading could not see keeps ps pcpu", async () => {
  const mac = fakeMac();
  withAgent(mac, 12);
  await mac.read();
  mac.failNext = true;
  mac.advance(2);
  const failed = await mac.read();
  assert.deepEqual(failed.live.threads, []);
  mac.procs.get(200).cpuMs += 4_000;
  mac.advance(2);
  // The agent was running all along; the failed reading just could not see it.
  assert.deepEqual(threadCpu((await mac.read()).live), { [THREAD]: 3 });
});

test("a peek measures the live window without moving it", async () => {
  const mac = fakeMac();
  withAgent(mac);
  await mac.read();
  mac.advance(1, { 200: 2 });
  const peeked = await mac.takeReading(mac.clockMs, { store: false, peek: true });
  assert.deepEqual(threadCpu(peeked.live), { [THREAD]: 50 });
  mac.advance(1);
  // The next reading still covers both seconds, not only the one since the peek.
  assert.deepEqual(threadCpu((await mac.read()).live), { [THREAD]: 25 });
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

test("the BB total counts BB's own processes and every thread's, and nothing else", async () => {
  const mac = fakeMac();
  const add = (pid, ppid, command) => mac.procs.set(pid, { ppid, pcpu: 0, cpuMs: 0, start: EARLY, command });
  add(100, 1, "/Applications/bb.app/Contents/MacOS/bb");
  add(101, 100, "/Applications/bb.app/Contents/Frameworks/bb Helper (Renderer).app/Contents/MacOS/bb Helper (Renderer)");
  // The agent carries its thread's id; the compiler it forked inherits it.
  add(200, 100, `/Users/me/.local/bin/claude --verbose BB_THREAD_ID=${THREAD}`);
  add(201, 200, "node tsc --watch");
  // A `bb` CLI call the agent made is BB's binary but its thread's work.
  add(202, 200, `/Users/me/.local/bin/bb hotspot status BB_THREAD_ID=${THREAD}`);
  // Outside BB, and a child of BB no thread claims: neither counts.
  add(300, 1, "/Applications/Slack.app/Contents/MacOS/Slack");
  add(400, 100, "/Users/me/.bb/plugins/toolchain/node_modules/@esbuild/darwin-arm64/bin/esbuild");
  await mac.read();
  mac.advance(2, { 100: 0.25, 101: 0.25, 200: 0.5, 201: 1, 202: 0.5, 300: 2, 400: 1 });
  const { live } = await mac.read();
  // Four cores: a busy core is 25% of the machine. Each fake process holds 1 MiB resident.
  assert.deepEqual(live.bb, {
    cpu: 62.5,
    memBytes: 5 * 1024 ** 2,
    processes: 5,
    app: { cpu: 12.5, memBytes: 2 * 1024 ** 2, processes: 2 },
    threads: { cpu: 50, memBytes: 3 * 1024 ** 2, processes: 3 },
  });
});

test("without a process table there is no BB total", async () => {
  const mac = fakeMac();
  mac.failNext = true;
  const { live } = await mac.read();
  assert.equal(live.bb, null);
});
