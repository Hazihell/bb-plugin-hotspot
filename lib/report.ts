/**
 * Read-side shaping shared by the page, the CLI and the agent tool.
 */
import type { Sample } from "./sample";

export interface TimelinePoint {
  at: number;
  cpu: number | null;
  thermal: number | null;
}

/**
 * Fold samples into `count` equal buckets over [from, to).
 *
 * Each bucket keeps its *highest* CPU and thermal level, so a one-minute
 * spike is still visible on a seven-day chart. Buckets with no sample stay
 * null and draw as gaps, which is how the chart shows the Mac was asleep.
 */
export function bucketSamples(
  samples: Sample[],
  from: number,
  to: number,
  count: number,
): { bucketMs: number; points: TimelinePoint[] } {
  const bucketMs = Math.max(1, Math.ceil((to - from) / count));
  const points: TimelinePoint[] = Array.from({ length: count }, (_, index) => ({
    at: from + index * bucketMs,
    cpu: null,
    thermal: null,
  }));
  for (const sample of samples) {
    const index = Math.floor((sample.at - from) / bucketMs);
    const point = points[index];
    if (point === undefined) continue;
    point.cpu = Math.max(point.cpu ?? 0, sample.cpu);
    if (sample.thermal !== null) point.thermal = Math.max(point.thermal ?? 0, sample.thermal);
  }
  return { bucketMs, points };
}
