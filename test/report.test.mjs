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
