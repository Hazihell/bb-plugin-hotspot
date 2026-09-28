/**
 * The shapes Hotspot stores and sends, as zod schemas. Every TypeScript type
 * for a sample or an episode is inferred from here, and every value read
 * back from storage is parsed with these schemas, never cast.
 */
import { z } from "zod";

/**
 * Stored rows hold thread ids only; titles are looked up when shown
 * (lib/threads.ts). A `title` in a row from an older build is stripped.
 */
export const threadEntrySchema = z.object({
  threadId: z.string(),
  /** Share of the whole machine, 0–100 (not per-core `ps` percent). */
  cpu: z.number(),
  processes: z.number(),
  /** Resident memory summed over the thread's processes, in bytes; null in rows from older builds. */
  memBytes: z.number().nullable().default(null),
});

export const processEntrySchema = z.object({
  pid: z.number(),
  name: z.string(),
  /** Share of the whole machine, 0–100. */
  cpu: z.number(),
});

/** Physical memory at one reading (lib/memory.ts). */
export const memorySchema = z.object({
  /** Used (app + wired + compressed) as a share of physical memory, 0–100. */
  percent: z.number(),
  totalBytes: z.number(),
  usedBytes: z.number(),
  appBytes: z.number(),
  wiredBytes: z.number(),
  compressedBytes: z.number(),
  swapUsedBytes: z.number(),
  /** The kernel's memory pressure level; null where it cannot be read. */
  pressure: z.enum(["normal", "warn", "critical"]).nullable(),
});

export const sampleSchema = z.object({
  at: z.number(),
  /** macOS thermal pressure 0–4, or null where it cannot be read. */
  thermal: z.number().nullable(),
  /** Machine-wide CPU busy, 0–100. */
  cpu: z.number(),
  /** One-minute load average divided by core count. */
  load: z.number(),
  /** Null when memory could not be read, and in rows from older builds. */
  memory: memorySchema.nullable().default(null),
  threads: z.array(threadEntrySchema),
  procs: z.array(processEntrySchema),
});

export const culpritSchema = z.object({
  threadId: z.string(),
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

/** The detector's memory between samples (see lib/episodes.ts). */
export const detectorStateSchema = z.object({
  /** Hot samples seen so far that have not yet opened an episode. */
  streak: episodeSchema.nullable(),
  open: episodeSchema.nullable(),
  normalStreak: z.number().int().min(0),
  lastAt: z.number().nullable(),
  /** The sample interval in force when `lastAt` was taken; absent in older state. */
  lastIntervalMs: z.number().positive().nullable().default(null),
});

/* What the page, CLI and tool show: stored shapes with titles attached. */
const titled = { title: z.string().nullable() };
export const threadViewSchema = threadEntrySchema.extend(titled);
export const culpritViewSchema = culpritSchema.extend(titled);
export const sampleViewSchema = sampleSchema.extend({ threads: z.array(threadViewSchema) });
export const episodeViewSchema = episodeSchema.extend({ culprits: z.array(culpritViewSchema) });

export const timelinePointSchema = z.object({
  at: z.number(),
  /** Highest machine CPU in the bucket, or null when nothing was sampled. */
  cpu: z.number().nullable(),
  /** Highest thermal level in the bucket, or null when unknown. */
  thermal: z.number().nullable(),
  /** Highest memory used %, or null when nothing in the bucket read memory. */
  mem: z.number().nullable(),
  /** Highest load per core, or null when nothing was sampled. */
  load: z.number().nullable(),
});

export type ThreadEntry = z.infer<typeof threadEntrySchema>;
export type Memory = z.infer<typeof memorySchema>;
export type ProcessEntry = z.infer<typeof processEntrySchema>;
export type Sample = z.infer<typeof sampleSchema>;
export type Culprit = z.infer<typeof culpritSchema>;
export type OtherCulprit = z.infer<typeof otherCulpritSchema>;
export type Episode = z.infer<typeof episodeSchema>;
export type SampleView = z.infer<typeof sampleViewSchema>;
export type EpisodeView = z.infer<typeof episodeViewSchema>;
export type DetectorState = z.infer<typeof detectorStateSchema>;
export type TimelinePoint = z.infer<typeof timelinePointSchema>;
