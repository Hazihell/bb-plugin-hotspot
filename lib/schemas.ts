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
/** One of a thread's busiest processes in a reading (the popover's drill-down). */
export const threadProcessSchema = z.object({
  pid: z.number(),
  /** A safe short name (lib/proc-name.ts), never the command line. */
  name: z.string(),
  /** Share of the whole machine, 0–100. */
  cpu: z.number(),
  memBytes: z.number(),
});

export const threadEntrySchema = z.object({
  threadId: z.string(),
  /** Share of the whole machine, 0–100 (not per-core `ps` percent). */
  cpu: z.number(),
  processes: z.number(),
  /** Resident memory summed over the thread's processes, in bytes; null in rows from older builds. */
  memBytes: z.number().nullable().default(null),
  /**
   * The thread's busiest processes, by CPU, at most TOP_PROCESSES_PER_THREAD.
   * Live readings only: stored samples leave it out (null).
   */
  top: z.array(threadProcessSchema).nullable().default(null),
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

/** CPU, memory and process count over a set of processes. */
export const bbPartSchema = z.object({
  /** Share of the whole machine, 0–100. */
  cpu: z.number(),
  /** Resident memory summed over the processes; shared pages count once per process. */
  memBytes: z.number(),
  processes: z.number(),
});

/**
 * Everything BB is running (lib/procs.ts, bbTotals): the total, and its two
 * parts, which never overlap: BB's own processes, and every process
 * attributed to a thread.
 */
export const bbTotalSchema = bbPartSchema.extend({
  app: bbPartSchema,
  threads: bbPartSchema,
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
  /** Null when `ps` failed, and in rows from older builds. */
  bb: bbTotalSchema.nullable().default(null),
});

/** A process name inside a culprit thread, summed over the hot samples, by name (pids change). */
export const culpritProcessSchema = z.object({
  name: z.string(),
  cpuSum: z.number(),
  samples: z.number(),
  peakCpu: z.number(),
});

export const culpritSchema = z.object({
  threadId: z.string(),
  /** Sum of the thread's CPU % over the hot samples it appeared in. */
  cpuSum: z.number(),
  /** Hot samples in which the thread was in the top five. */
  samples: z.number(),
  peakCpu: z.number(),
  /** Its busiest processes by name, top 3 once the episode closes; null in episodes from older builds. */
  procs: z.array(culpritProcessSchema).nullable().default(null),
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
export type ThreadProcess = z.infer<typeof threadProcessSchema>;
export type CulpritProcess = z.infer<typeof culpritProcessSchema>;
export type Memory = z.infer<typeof memorySchema>;
export type BbTotal = z.infer<typeof bbTotalSchema>;
export type ProcessEntry = z.infer<typeof processEntrySchema>;
export type Sample = z.infer<typeof sampleSchema>;
export type Culprit = z.infer<typeof culpritSchema>;
export type OtherCulprit = z.infer<typeof otherCulpritSchema>;
export type Episode = z.infer<typeof episodeSchema>;
export type SampleView = z.infer<typeof sampleViewSchema>;
export type EpisodeView = z.infer<typeof episodeViewSchema>;
export type DetectorState = z.infer<typeof detectorStateSchema>;
export type TimelinePoint = z.infer<typeof timelinePointSchema>;
