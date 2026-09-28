import assert from "node:assert/strict";
import { test } from "node:test";
import { bucketSamples, describeSample, describeWindow, summarizeWindow } from "../lib/report.ts";

const sample = (at, cpu, thermal = 0, mem = null) => ({ at, cpu, thermal, load: cpu / 100, mem });

test("bucketSamples keeps each bucket's peak and leaves empty buckets null", () => {
  const { bucketMs, points } = bucketSamples(
    [sample(0, 10, 0, 60), sample(5, 70, 1, 55), sample(25, 30, null), sample(99, 5), sample(100, 99)],
    0,
    100,
    4,
  );
  assert.equal(bucketMs, 25);
  assert.deepEqual(points, [
    { at: 0, cpu: 70, thermal: 1, mem: 60, load: 0.7 },
    { at: 25, cpu: 30, thermal: null, mem: null, load: 0.3 },
    { at: 50, cpu: null, thermal: null, mem: null, load: null },
    { at: 75, cpu: 5, thermal: 0, mem: null, load: 0.05 },
  ]);
});

import { clampText, describeEpisode, parseWhen } from "../lib/report.ts";

test("parseWhen reads relative spans, clock times and ISO", () => {
  const now = new Date(2026, 8, 28, 16, 30).getTime();
  assert.equal(parseWhen("90m", now), now - 90 * 60_000);
  assert.equal(parseWhen("2d", now), now - 2 * 86_400_000);
  assert.equal(parseWhen("15:00", now), new Date(2026, 8, 28, 15, 0).getTime());
  // A clock time later than now means yesterday.
  assert.equal(parseWhen("17:00", now), new Date(2026, 8, 27, 17, 0).getTime());
  assert.equal(parseWhen("2026-09-27T10:00:00Z", now), Date.UTC(2026, 8, 27, 10));
  assert.equal(parseWhen("25:00", now), null);
  assert.equal(parseWhen("yesterday-ish", now), null);
});

test("describeEpisode names culprits with average CPU per hot sample", () => {
  const lines = describeEpisode(
    {
      id: 7,
      startAt: new Date(2026, 8, 28, 15, 0).getTime(),
      endAt: new Date(2026, 8, 28, 15, 20).getTime(),
      lastHotAt: 0,
      peakThermal: 2,
      peakCpu: 91,
      samples: 20,
      culprits: [
        { threadId: "thr_aaaaaaaaaa", title: "Build", cpuSum: 800, samples: 20, peakCpu: 60 },
        { threadId: "thr_bbbbbbbbbb", title: null, cpuSum: 40, samples: 2, peakCpu: 30 },
      ],
      others: [{ name: "WindowServer", cpuSum: 60, samples: 20 }],
    },
    1,
  );
  assert.deepEqual(lines, [
    "#7  2026-09-28 15:00 → 2026-09-28 15:20  (20m), peak thermal heavy, peak CPU 91%",
    "  1. Build (thr_aaaaaaaaaa)  avg 40%, peak 60%, in 20/20 hot samples",
    "  outside threads: WindowServer avg 3%",
  ]);
});

test("clampText cuts at a line boundary under the limit", () => {
  const text = Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n");
  const clamped = clampText(text, 200);
  assert.ok(clamped.length <= 200);
  assert.ok(clamped.endsWith("… (truncated)"));
  assert.equal(clampText("short", 200), "short");
});

test("status and the window summary include the BB total, with its split", () => {
  const bb = {
    cpu: 23.4,
    memBytes: 3.1 * 1024 ** 3,
    processes: 41,
    app: { cpu: 5, memBytes: 1.2 * 1024 ** 3, processes: 30 },
    threads: { cpu: 18.4, memBytes: 1.9 * 1024 ** 3, processes: 11 },
  };
  const base = { at: 0, thermal: 0, cpu: 50, load: 0.5, memory: null, threads: [], procs: [] };
  assert.match(
    describeSample({ ...base, bb }).join("\n"),
    /BB total 23%, 3\.1 GB, 41 processes \(app 5%, 1\.2 GB; threads 18%, 1\.9 GB\); memory sums/,
  );
  assert.doesNotMatch(describeSample({ ...base, bb: null }).join("\n"), /BB total/);
  const window = summarizeWindow([{ ...base, bb }, { ...base, bb: { ...bb, cpu: 40 } }, { ...base, bb: null }]);
  assert.deepEqual(window.bb, { samples: 2, avgCpu: 31.7, peakCpu: 40, peakMemBytes: bb.memBytes });
  assert.match(describeWindow(window, []).join("\n"), /BB total \(app and all threads\) CPU avg 32%, peak 40%; peak memory 3\.1 GB/);
  assert.match(describeWindow(summarizeWindow([{ ...base, bb: null }]), []).join("\n"), /BB total: not recorded/);
});
