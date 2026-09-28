import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attributeThreads,
  groupByThread,
  parseCpuTime,
  parseProcStat,
  parsePs,
  parseThreadId,
  processName,
  topUnattributed,
} from "../lib/procs.ts";
import { thermalLabel } from "../lib/labels.ts";
import { parseThermal } from "../lib/thermal.ts";

test("parseThermal reads the level notifyutil prints", () => {
  assert.equal(parseThermal("com.apple.system.thermalpressurelevel 0\n"), 0);
  assert.equal(parseThermal("com.apple.system.thermalpressurelevel 3"), 3);
});

test("parseThermal rejects empty, foreign and out-of-range output", () => {
  assert.equal(parseThermal(""), null);
  assert.equal(parseThermal("com.apple.system.thermalpressurelevel"), null);
  assert.equal(parseThermal("com.apple.other 2"), null);
  assert.equal(parseThermal("com.apple.system.thermalpressurelevel 9"), null);
  assert.equal(thermalLabel(null), "unknown");
  assert.equal(thermalLabel(2), "heavy");
});

test("parseThreadId prefers BB_THREAD_ID from the environment", () => {
  const command =
    "/usr/local/bin/node /Users/me/.bb/worktrees/thr_aaaaaaaaaa/app/x.js TERM=xterm BB_THREAD_ID=thr_bbbbbbbbbb HOME=/Users/me";
  assert.equal(parseThreadId(command), "thr_bbbbbbbbbb");
});

test("parseThreadId falls back to a worktree or workspace path in argv", () => {
  assert.equal(
    parseThreadId("node /Users/me/.bb/plugins/prepared-worktree/host-data/worktrees/thr_cyjs4d8nvp-1/ui/tsc --watch"),
    "thr_cyjs4d8nvp",
  );
  assert.equal(
    parseThreadId("node /Users/me/.bb/plugins/env/host-data/workspaces/thr_7fryv3rwfg HOME=/Users/me"),
    "thr_7fryv3rwfg",
  );
  assert.equal(parseThreadId("node BB_THREAD_ID=thr_ HOME=/x"), null);
  assert.equal(parseThreadId("/sbin/launchd"), null);
});

test("a bare thr_ id in argv or a worktree path in another variable names no thread", () => {
  assert.equal(parseThreadId("ugrep -I thr_abcdefghij TERM=xterm"), null);
  assert.equal(parseThreadId("/bin/zsh -c echo thr_abcdefghij"), null);
  assert.equal(
    parseThreadId("/bin/zsh TERM=xterm PWD=/x/worktrees/thr_abcdefghij OLDPWD=/x/workspaces/thr_bcdefghijk"),
    null,
  );
  assert.equal(parseThreadId("/usr/bin/cat /x/worktrees/thr_abcdefghijXYZ/f"), null);
});

test("processName keeps spaces in app paths and stops at the environment", () => {
  assert.equal(
    processName("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=gpu"),
    "Google Chrome",
  );
  assert.equal(processName("/opt/homebrew/bin/node server.js PATH=/usr/bin"), "node server.js");
  assert.equal(processName("/usr/libexec/logd"), "logd");
});

const PS = [
  "    1     0   0.0  2048 1:02.50 Mon Sep  8 14:04:23 2026 /sbin/launchd",
  "  100     1   2.0  2048 1:02.50 Mon Sep  8 14:04:23 2026 /Applications/bb.app/Contents/MacOS/bb",
  "  200   100  12.5  2048 1:02.50 Mon Sep  8 14:04:23 2026 /Users/me/.local/bin/claude --verbose HOME=/Users/me BB_THREAD_ID=thr_aaaaaaaaaa",
  "  300   200  80.0  2048 1:02.50 Mon Sep  8 14:04:23 2026 /bin/zsh -c npx tsc",
  "  301   300  40.0  2048 1:02.50 Mon Sep  8 14:04:23 2026 node /repo/node_modules/.bin/tsc",
  "  400   100   5.0  2048 1:02.50 Mon Sep  8 14:04:23 2026 /Users/me/.local/bin/claude BB_THREAD_ID=thr_bbbbbbbbbb",
  "  500     1  33.3  2048 1:02.50 Mon Sep  8 14:04:23 2026 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "garbage line",
  "",
].join("\n");

test("parsePs reads pid, ppid, cpu, resident memory and skips malformed lines", () => {
  const rows = parsePs(PS);
  assert.equal(rows.length, 7);
  assert.deepEqual(rows[2], {
    pid: 200,
    ppid: 100,
    cpuPercent: 12.5,
    rssBytes: 2048 * 1024,
    cpuMs: 62_500,
    key: "200@Mon Sep 8 14:04:23 2026",
    name: "claude",
    threadId: "thr_aaaaaaaaaa",
    bb: false,
    argv: "/Users/me/.local/bin/claude --verbose",
  });
});

test("children inherit the nearest ancestor's thread", () => {
  const rows = parsePs(PS);
  const attribution = attributeThreads(rows);
  assert.equal(attribution.get(301), "thr_aaaaaaaaaa");
  assert.equal(attribution.get(300), "thr_aaaaaaaaaa");
  assert.equal(attribution.get(100), null);
  assert.equal(attribution.get(500), null);

  const threads = groupByThread(rows, attribution);
  assert.deepEqual(threads, [
    { threadId: "thr_aaaaaaaaaa", cpuPercent: 132.5, rssBytes: 3 * 2048 * 1024, processCount: 3 },
    { threadId: "thr_bbbbbbbbbb", cpuPercent: 5, rssBytes: 2048 * 1024, processCount: 1 },
  ]);
  assert.deepEqual(
    topUnattributed(rows, attribution, 5).map((row) => row.name),
    ["Google Chrome", "bb"],
  );
});

test("a pid cycle in ppid links does not hang attribution", () => {
  const rows = parsePs(
    ["  10    11   1.0  1 0:00.01 Mon Sep 28 14:04:23 2026 a", "  11    10   1.0  1 0:00.01 Mon Sep 28 14:04:23 2026 b"].join("\n"),
  );
  const attribution = attributeThreads(rows);
  assert.equal(attribution.get(10), null);
  assert.equal(attribution.get(11), null);
});

test("parseCpuTime reads macOS minutes with centiseconds and procps hours and days", () => {
  assert.equal(parseCpuTime("0:02.89"), 2_890);
  assert.equal(parseCpuTime("870:19.60"), 870 * 60_000 + 19_600);
  assert.equal(parseCpuTime("01:02:03"), 3_723_000);
  assert.equal(parseCpuTime("2-01:00:00"), 49 * 3_600_000);
  assert.equal(parseCpuTime("-"), null);
});

test("parseProcStat reads CPU and start ticks past a command name with spaces", () => {
  const fields = ["S", ...Array.from({ length: 10 }, () => "0"), "150", "50", ...Array.from({ length: 6 }, () => "0"), "98765", "0"];
  assert.deepEqual(parseProcStat(`42 (my (odd) cmd) ${fields.join(" ")}`), { cpuMs: 2_000, started: "98765" });
  assert.equal(parseProcStat(null), null);
  assert.equal(parseProcStat("42 (x) S 1"), null);
});
