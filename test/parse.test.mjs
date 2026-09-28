import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attributeThreads,
  groupByThread,
  parsePs,
  parseThreadId,
  processName,
  topUnattributed,
} from "../lib/procs.ts";
import { parseThermal, thermalLabel } from "../lib/thermal.ts";

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

test("parseThreadId falls back to a worktree path and ignores short ids", () => {
  assert.equal(
    parseThreadId("node /Users/me/.bb/worktrees/thr_cyjs4d8nvp-1/ui/tsc --watch"),
    "thr_cyjs4d8nvp",
  );
  assert.equal(parseThreadId("node BB_THREAD_ID=thr_ HOME=/x"), null);
  assert.equal(parseThreadId("/sbin/launchd"), null);
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
  "    1     0   0.0 /sbin/launchd",
  "  100     1   2.0 /Applications/bb.app/Contents/MacOS/bb",
  "  200   100  12.5 /Users/me/.local/bin/claude --verbose HOME=/Users/me BB_THREAD_ID=thr_aaaaaaaaaa",
  "  300   200  80.0 /bin/zsh -c npx tsc",
  "  301   300  40.0 node /repo/node_modules/.bin/tsc",
  "  400   100   5.0 /Users/me/.local/bin/claude BB_THREAD_ID=thr_bbbbbbbbbb",
  "  500     1  33.3 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "garbage line",
  "",
].join("\n");

test("parsePs reads pid, ppid, cpu and skips malformed lines", () => {
  const rows = parsePs(PS);
  assert.equal(rows.length, 7);
  assert.deepEqual(rows[2], {
    pid: 200,
    ppid: 100,
    cpuPercent: 12.5,
    name: "claude",
    threadId: "thr_aaaaaaaaaa",
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
    { threadId: "thr_aaaaaaaaaa", cpuPercent: 132.5, processCount: 3 },
    { threadId: "thr_bbbbbbbbbb", cpuPercent: 5, processCount: 1 },
  ]);
  assert.deepEqual(
    topUnattributed(rows, attribution, 5).map((row) => row.name),
    ["Google Chrome", "bb"],
  );
});

test("a pid cycle in ppid links does not hang attribution", () => {
  const rows = parsePs(["  10    11   1.0 a", "  11    10   1.0 b"].join("\n"));
  const attribution = attributeThreads(rows);
  assert.equal(attribution.get(10), null);
  assert.equal(attribution.get(11), null);
});
