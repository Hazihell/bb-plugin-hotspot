import assert from "node:assert/strict";
import { test } from "node:test";
import { DARWIN_PS, PORTABLE_PS, attributeThreads, groupByThread, readProcesses } from "../lib/procs.ts";
import { createSampler } from "../lib/sample.ts";

const LINUX_PS = [
  "    1     0  0.0 /sbin/init",
  "  200     1 12.5 /usr/bin/node /home/me/.local/bin/claude --verbose",
  "  300   200 80.0 node /repo/node_modules/.bin/tsc PWD=/not/env",
  "  400     1  9.0 node /home/me/.bb/worktrees/thr_bbbbbbbbbb-2/app/server.js",
  "  500     1 30.0 grep thr_cccccccccc",
].join("\n");

const ENVIRONS = {
  200: "HOME=/home/me\0PWD=/home/me/.bb/workspaces/thr_dddddddddd\0BB_THREAD_ID=thr_aaaaaaaaaa\0",
};

function linuxSource(overrides = {}) {
  const commands = [];
  return {
    commands,
    source: {
      platform: "linux",
      async exec(command) {
        commands.push(command);
        return LINUX_PS;
      },
      async readEnviron(pid) {
        return ENVIRONS[pid] ?? null;
      },
      ...overrides,
    },
  };
}

test("off macOS, ps runs without -E and the thread comes from /proc environ", async () => {
  const { source, commands } = linuxSource();
  const rows = await readProcesses(source);
  assert.deepEqual(commands, [PORTABLE_PS]);
  assert.ok(!/\s-\w*E/.test(PORTABLE_PS) && /\s-\w*E/.test(DARWIN_PS));

  const byPid = Object.fromEntries(rows.map((row) => [row.pid, row]));
  assert.equal(byPid[200].threadId, "thr_aaaaaaaaaa");
  assert.equal(byPid[200].name, "node");
  assert.equal(byPid[400].threadId, "thr_bbbbbbbbbb");
  assert.equal(byPid[500].threadId, null);

  const threads = groupByThread(rows, attributeThreads(rows));
  assert.deepEqual(
    threads.map((entry) => [entry.threadId, entry.cpuPercent]),
    [["thr_aaaaaaaaaa", 92.5], ["thr_bbbbbbbbbb", 9]],
  );
});

test("when ps fails, a sample is still stored with kernel CPU and no threads", async () => {
  const errors = [];
  const { source } = linuxSource({
    async exec() {
      throw new Error("ps: command not found");
    },
  });
  const takeSample = createSampler(async () => new Map(), {
    processes: source,
    thermal: async () => null,
    onProcessError: (error) => errors.push(error.message),
  });
  const sample = await takeSample(123);
  assert.equal(sample.at, 123);
  assert.equal(sample.thermal, null);
  assert.deepEqual(sample.threads, []);
  assert.deepEqual(sample.procs, []);
  assert.ok(sample.cpu >= 0 && sample.cpu <= 100);
  assert.deepEqual(errors, ["ps: command not found"]);
});

test("a Linux sample ranks threads found through /proc", async () => {
  const { source } = linuxSource();
  const takeSample = createSampler(
    async (ids) => new Map(ids.map((id) => [id, null])),
    { processes: source, thermal: async () => null },
  );
  const sample = await takeSample(1);
  assert.deepEqual(sample.threads.map((entry) => entry.threadId), ["thr_aaaaaaaaaa", "thr_bbbbbbbbbb"]);
  assert.deepEqual(sample.procs.map((entry) => entry.pid), [500]);
});
