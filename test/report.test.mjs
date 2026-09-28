import assert from "node:assert/strict";
import { test } from "node:test";
import { bucketSamples } from "../lib/report.ts";

const sample = (at, cpu, thermal = 0) => ({ at, cpu, thermal, load: 0, threads: [], procs: [] });

test("bucketSamples keeps each bucket's peak and leaves empty buckets null", () => {
  const { bucketMs, points } = bucketSamples(
    [sample(0, 10), sample(5, 70, 1), sample(25, 30, null), sample(99, 5), sample(100, 99)],
    0,
    100,
    4,
  );
  assert.equal(bucketMs, 25);
  assert.deepEqual(points, [
    { at: 0, cpu: 70, thermal: 1 },
    { at: 25, cpu: 30, thermal: null },
    { at: 50, cpu: null, thermal: null },
    { at: 75, cpu: 5, thermal: 0 },
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
