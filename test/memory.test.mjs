import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DARWIN_MEMORY,
  parseDarwinMemory,
  parseMeminfo,
  parsePressure,
  parseSwapUsage,
  readMemory,
} from "../lib/memory.ts";
import { describeMemory, summarizeWindow } from "../lib/report.ts";
import { bytesText } from "../lib/labels.ts";

const GB = 1024 ** 3;
const PAGE = 16384;

/** `vm_stat; echo --sysctl--; sysctl -n …` from a 16 GB Apple silicon Mac. */
const DARWIN = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    28685.
Pages active:                                 249390.
Pages inactive:                               248048.
Pages speculative:                              1254.
Pages throttled:                                   0.
Pages wired down:                             222948.
Pages purgeable:                                3827.
"Translation faults":                    32526264645.
File-backed pages:                            175583.
Anonymous pages:                              323109.
Pages stored in compressor:                  1838077.
Pages occupied by compressor:                 258766.
Swapins:                                   140273292.
Swapouts:                                  163890081.
--sysctl--
17179869184
total = 7168.00M  used = 5877.25M  free = 1290.75M  (encrypted)
1
`;

test("macOS memory: used is app + wired + compressed, as Activity Monitor counts it", () => {
  const memory = parseDarwinMemory(DARWIN);
  const app = (323109 - 3827) * PAGE;
  const wired = 222948 * PAGE;
  const compressed = 258766 * PAGE;
  assert.deepEqual(memory, {
    percent: Math.round(((app + wired + compressed) / (16 * GB)) * 1000) / 10,
    totalBytes: 16 * GB,
    usedBytes: app + wired + compressed,
    appBytes: app,
    wiredBytes: wired,
    compressedBytes: compressed,
    swapUsedBytes: 5877.25 * 1024 ** 2,
    pressure: "normal",
  });
  assert.equal(memory.percent, 76.4);
});

test("macOS memory without a readable total is no reading, not a zero", () => {
  assert.equal(parseDarwinMemory(DARWIN.replace("17179869184", "")), null);
  assert.equal(parseDarwinMemory("vm_stat: command not found"), null);
});

test("swap and pressure parse every unit and level", () => {
  assert.deepEqual(parseSwapUsage("total = 2.00G  used = 512.00K  free = 1.99G"), {
    totalBytes: 2 * GB,
    usedBytes: 512 * 1024,
  });
  assert.deepEqual(parseSwapUsage("total = 0.00M  used = 0.00M  free = 0.00M"), { totalBytes: 0, usedBytes: 0 });
  assert.deepEqual(["1", "2", "4", "", "7"].map(parsePressure), ["normal", "warn", "critical", null, null]);
});

test("Linux memory comes from MemAvailable, and swap from its total and free", () => {
  const memory = parseMeminfo(
    ["MemTotal:       16000000 kB", "MemFree:         1000000 kB", "MemAvailable:    6000000 kB",
      "SwapTotal:       4000000 kB", "SwapFree:        3000000 kB", "SUnreclaim:       200000 kB"].join("\n"),
  );
  assert.equal(memory.percent, 62.5);
  assert.equal(memory.usedBytes, 10_000_000 * 1024);
  assert.equal(memory.swapUsedBytes, 1_000_000 * 1024);
  assert.equal(memory.wiredBytes, 200_000 * 1024);
  assert.equal(memory.pressure, null);
  assert.equal(parseMeminfo("garbage"), null);
});

test("one shell on macOS, one file on Linux", async () => {
  const commands = [];
  const darwin = await readMemory({
    platform: "darwin",
    exec: async (command) => (commands.push(command), DARWIN),
    readFile: async () => assert.fail("no file read on macOS"),
  });
  assert.deepEqual(commands, [DARWIN_MEMORY]);
  assert.equal(darwin?.pressure, "normal");
  const paths = [];
  await readMemory({
    platform: "linux",
    exec: async () => assert.fail("no exec on Linux"),
    readFile: async (path) => (paths.push(path), "MemTotal: 1000 kB\nMemAvailable: 500 kB"),
  });
  assert.deepEqual(paths, ["/proc/meminfo"]);
});

test("bytesText rounds to what a person reads", () => {
  assert.deepEqual([0.4 * GB, 1.24 * GB, 9.96 * GB, 16 * GB].map(bytesText), ["410 MB", "1.2 GB", "10 GB", "16 GB"]);
});

test("the CLI and tool describe memory and summarise it over a window", () => {
  const memory = parseDarwinMemory(DARWIN);
  assert.match(describeMemory(memory), /^memory 76% used \(12 GB of 16 GB: app 4\.9 GB, wired 3\.4 GB, compressed 3\.9 GB\), swap 5\.7 GB, pressure normal$/);
  const base = { thermal: 0, cpu: 10, load: 0.1, procs: [] };
  const summary = summarizeWindow([
    { ...base, at: 1, memory, threads: [{ threadId: "thr_aaaaaaaaaa", cpu: 5, processes: 1, memBytes: GB }] },
    { ...base, at: 2, memory: { ...memory, percent: 90, pressure: "warn" }, threads: [] },
    { ...base, at: 3, memory: null, threads: [{ threadId: "thr_aaaaaaaaaa", cpu: 5, processes: 1, memBytes: null }] },
  ]);
  assert.equal(summary.avgMem, (76.4 + 90) / 2);
  assert.equal(summary.peakMem, 90);
  assert.equal(summary.peakPressure, "warn");
  assert.equal(summary.threads[0].peakMemBytes, GB);
});
