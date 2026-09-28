/**
 * The shapes Hotspot stores and sends, as zod schemas. Every TypeScript type
 * for a sample or an episode is inferred from here, and every value read
 * back from storage is parsed with these schemas, never cast.
 */
import { z } from "zod";

export const threadEntrySchema = z.object({
  threadId: z.string(),
  title: z.string().nullable(),
  /** Share of the whole machine, 0–100 (not per-core `ps` percent). */
  cpu: z.number(),
  processes: z.number(),
});

export const processEntrySchema = z.object({
  pid: z.number(),
  name: z.string(),
  /** Share of the whole machine, 0–100. */
  cpu: z.number(),
});

export const sampleSchema = z.object({
  at: z.number(),
  /** macOS thermal pressure 0–4, or null where it cannot be read. */
  thermal: z.number().nullable(),
  /** Machine-wide CPU busy, 0–100. */
  cpu: z.number(),
  /** One-minute load average divided by core count. */
  load: z.number(),
  threads: z.array(threadEntrySchema),
  procs: z.array(processEntrySchema),
});

export const culpritSchema = z.object({
  threadId: z.string(),
  title: z.string().nullable(),
  /** Sum of the thread's CPU % over the hot samples it appeared in. */
  cpuSum: z.number(),
  /** Hot samples in which the thread was in the top five. */
  samples: z.number(),
  peakCpu: z.number(),
});

export const otherCulpritSchema = z.object({
  name: z.string(),
  cpuSum: z.number(),
  samples: z.number(),
});

export const episodeSchema = z.object({
  /** Row id once stored; null while it only exists in memory. */
  id: z.number().nullable(),
  startAt: z.number(),
  /** Null while the episode is open. */
  endAt: z.number().nullable(),
  lastHotAt: z.number(),
  peakThermal: z.number().nullable(),
  peakCpu: z.number(),
  /** Hot samples counted into the episode. */
  samples: z.number(),
  culprits: z.array(culpritSchema),
  others: z.array(otherCulpritSchema),
});

export const timelinePointSchema = z.object({
  at: z.number(),
  /** Highest machine CPU in the bucket, or null when nothing was sampled. */
  cpu: z.number().nullable(),
  /** Highest thermal level in the bucket, or null when unknown. */
  thermal: z.number().nullable(),
});

export type ThreadEntry = z.infer<typeof threadEntrySchema>;
export type ProcessEntry = z.infer<typeof processEntrySchema>;
export type Sample = z.infer<typeof sampleSchema>;
export type Culprit = z.infer<typeof culpritSchema>;
export type OtherCulprit = z.infer<typeof otherCulpritSchema>;
export type Episode = z.infer<typeof episodeSchema>;
export type TimelinePoint = z.infer<typeof timelinePointSchema>;
