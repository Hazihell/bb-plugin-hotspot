/**
 * One reading of the machine: heat, CPU, memory, load, and who is using them.
 *
 * A reading costs one `ps`, one `notifyutil` and one memory read (`vm_stat`
 * and `sysctl` in one shell), all in parallel. CPU is measured between two
 * readings: machine-wide from the kernel's per-core tick counters
 * (`os.cpus()`), per process from the CPU time `ps` reports. One reading
 * serves two windows. The live window runs from the previous reading of
 * any kind and is what the UI shows now; the stored window runs from the
 * previous stored sample, so a minute's sample describes the whole minute
 * however many live readings fell inside it.
 */
import os from "node:os";
import { performance } from "node:perf_hooks";
import {
  type ProcessRow,
  type ProcessSource,
  type ProcessTotal,
  attributeThreads,
  bbTotals,
  groupByThread,
  readProcesses,
  systemProcessSource,
  topUnattributed,
} from "./procs";
import { type MemorySource, readMemory, systemMemorySource } from "./memory";
import { friendlyName } from "./proc-name";
import type { Memory, Sample } from "./schemas";
import { readThermal } from "./thermal";

export const TOP_THREADS = 5;
/**
 * Threads kept per sample. A few beyond the five shown, so an id that turns
 * out to name no thread can be dropped when read without shortening the list.
 */
export const STORED_THREADS = TOP_THREADS + 3;
export const TOP_PROCESSES = 5;
/** Processes kept per thread for the popover's drill-down. */
export const TOP_PROCESSES_PER_THREAD = 5;

export interface CpuTicks {
  busy: number;
  total: number;
}

function readTicks(): CpuTicks {
  let busy = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const { user, nice, sys, idle, irq } = cpu.times;
    busy += user + nice + sys + irq;
    total += user + nice + sys + idle + irq;
  }
  return { busy, total };
}

/** Busy fraction of all cores between two tick readings, 0–100. */
export function cpuBetween(previous: CpuTicks, next: CpuTicks): number | null {
  const total = next.total - previous.total;
  if (total <= 0) return null;
  return clampPercent(((next.busy - previous.busy) / total) * 100);
}

function clampPercent(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

const round = (value: number) => Math.round(value * 10) / 10;

const loadPerCore = (cores: number) => Math.round((os.loadavg()[0] / cores) * 100) / 100;

/** What a later reading is measured against. */
export interface Baseline {
  /** Monotonic clock, ms. */
  clockMs: number;
  ticks: CpuTicks;
  /**
   * Every process this reading saw, by key (pid and start time), with its
   * CPU time in ms, or null where that was unknown.
   */
  times: Map<string, number | null>;
  /**
   * Pids this reading saw without a key (on Linux, an unreadable
   * `/proc/<pid>/stat`). A keyed process at one of these pids later may be
   * the same process, so it is not counted from zero.
   */
  unkeyed: Set<number>;
  /**
   * Whether `times` is the whole process table. False before the first
   * reading and when `ps` failed, so an absent key says nothing about
   * whether the process is new.
   */
  complete: boolean;
}

/** Below this much wall time between readings, per-process CPU time is too coarse to trust. */
export const MIN_ELAPSED_MS = 500;

/**
 * Each row's CPU over the window since `baseline`, in percent of one core:
 * the CPU time it used divided by the wall time between the readings. A
 * process a complete baseline did not see at all started inside the window
 * (new, or a reused pid), so all its CPU time counts. It keeps `ps`'s own figure
 * when the baseline is incomplete (the first reading after a load, or a
 * failed `ps`), when its CPU time or start is unknown, and so does every
 * process when the window is too short to measure. No process is credited
 * more than every core for the whole window. A process that exited is
 * simply absent from `rows`.
 */
export function cpuSince(
  rows: readonly ProcessRow[],
  baseline: Baseline,
  clockMs: number,
  cores: number,
): ProcessRow[] {
  const elapsed = clockMs - baseline.clockMs;
  if (elapsed < MIN_ELAPSED_MS) return [...rows];
  return rows.map((row) => {
    if (row.key === null || row.cpuMs === null) return row;
    const seen = baseline.times.get(row.key);
    const before = seen === undefined && baseline.complete && !baseline.unkeyed.has(row.pid) ? 0 : seen;
    if (before === undefined || before === null || row.cpuMs < before) return row;
    return { ...row, cpuPercent: Math.min(((row.cpuMs - before) / elapsed) * 100, cores * 100) };
  });
}

function baselineOf(rows: readonly ProcessRow[] | null, clockMs: number, ticks: CpuTicks): Baseline {
  const times = new Map<string, number | null>();
  const unkeyed = new Set<number>();
  for (const row of rows ?? []) {
    if (row.key === null) unkeyed.add(row.pid);
    else times.set(row.key, row.cpuMs);
  }
  return { clockMs, ticks, times, unkeyed, complete: rows !== null };
}

export interface SamplerOptions {
  processes?: ProcessSource;
  thermal?: () => Promise<number | null>;
  memory?: MemorySource;
  /** Monotonic ms; injected by tests. */
  clock?: () => number;
  /** The kernel's tick counters; injected by tests. */
  ticks?: () => CpuTicks;
  /** Core count, for the share of the whole machine; injected by tests. */
  cores?: number;
  /** Told when `ps` fails; the sample is still taken, without processes. */
  onProcessError?: (error: unknown) => void;
  /** Told when memory cannot be read; the sample is still taken, without memory. */
  onMemoryError?: (error: unknown) => void;
}

/** One reading, seen over both windows. */
export interface Measurement {
  /** Since the previous reading of any kind: what the UI shows now. */
  live: Sample;
  /** Since the previous stored sample; null unless one was asked for. */
  stored: Sample | null;
}

/** Less than this much CPU time per core since the last reading is too noisy to trust. */
const MIN_TICK_MS_PER_CORE = 1_000;

export interface ReadingOptions {
  /** Also measure the stored window, and start the next one here. */
  store: boolean;
  /** Measure the live window without moving it, so the next live reading still covers its full interval. */
  peek?: boolean;
}

export type TakeReading = (at: number, options: ReadingOptions) => Promise<Measurement>;

/**
 * Takes readings. Each one advances the live window unless it peeks; one
 * taken with `store` also advances the stored window. Readings must not
 * overlap.
 */
export function createSampler(options: SamplerOptions = {}): TakeReading {
  const source = options.processes ?? systemProcessSource;
  const thermalReader = options.thermal ?? readThermal;
  const memorySource = options.memory ?? systemMemorySource;
  const clock = options.clock ?? (() => performance.now());
  const ticksNow = options.ticks ?? readTicks;
  const cores = options.cores ?? Math.max(1, os.cpus().length);
  // Until the first reading no process has a baseline, so every process falls back to `ps`.
  const loaded = baselineOf(null, clock(), ticksNow());
  let live = loaded;
  let stored = loaded;

  return async function takeReading(at, { store, peek = false }) {
    const [rows, thermal, memory] = await Promise.all([
      readProcesses(source).catch((error: unknown): ProcessRow[] | null => {
        options.onProcessError?.(error);
        return null;
      }),
      thermalReader(),
      readMemory(memorySource).catch((error: unknown): Memory | null => {
        options.onMemoryError?.(error);
        return null;
      }),
    ]);
    const now = baselineOf(rows, clock(), ticksNow());
    const load = loadPerCore(cores);

    const measure = (since: Baseline): Sample => {
      const kernelCpu = cpuBetween(since.ticks, now.ticks);
      const enoughTicks = now.ticks.total - since.ticks.total >= MIN_TICK_MS_PER_CORE * cores;
      const measured = rows === null ? null : cpuSince(rows, since, now.clockMs, cores);
      // Right after a load the tick interval is too short to mean anything, so
      // the process sum stands in; without `ps`, the short interval is all there is.
      const psCpu =
        measured === null ? null : clampPercent(measured.reduce((sum, row) => sum + row.cpuPercent, 0) / cores);
      const cpu = (enoughTicks ? kernelCpu : (psCpu ?? kernelCpu)) ?? 0;
      if (measured === null) return { at, thermal, cpu, load, memory, threads: [], procs: [], bb: null };

      const attribution = attributeThreads(measured);
      const part = (total: ProcessTotal) => ({
        cpu: round(total.cpuPercent / cores),
        memBytes: total.rssBytes,
        processes: total.processes,
      });
      const { app, threads: inThreads } = bbTotals(measured, attribution);
      const threads = groupByThread(measured, attribution)
        .filter((entry) => entry.cpuPercent > 0)
        .slice(0, STORED_THREADS);
      // Each kept thread's busiest processes, named without their command lines.
      const byThread = new Map<string, ProcessRow[]>(threads.map((entry) => [entry.threadId, []]));
      for (const row of measured) byThread.get(attribution.get(row.pid) ?? "")?.push(row);
      const topOf = (threadId: string) =>
        (byThread.get(threadId) ?? [])
          .sort((a, b) => b.cpuPercent - a.cpuPercent || b.rssBytes - a.rssBytes)
          .slice(0, TOP_PROCESSES_PER_THREAD)
          .map((row) => ({ pid: row.pid, name: friendlyName(row.argv), cpu: round(row.cpuPercent / cores), memBytes: row.rssBytes }));
      return {
        at,
        thermal,
        cpu,
        load,
        memory,
        threads: threads.map((entry) => ({
          threadId: entry.threadId,
          cpu: round(entry.cpuPercent / cores),
          processes: entry.processCount,
          memBytes: entry.rssBytes,
          top: topOf(entry.threadId),
        })),
        procs: topUnattributed(measured, attribution, TOP_PROCESSES).map((row) => ({
          pid: row.pid,
          name: row.name,
          cpu: round(row.cpuPercent / cores),
        })),
        bb: {
          ...part({
            cpuPercent: app.cpuPercent + inThreads.cpuPercent,
            rssBytes: app.rssBytes + inThreads.rssBytes,
            processes: app.processes + inThreads.processes,
          }),
          app: part(app),
          threads: part(inThreads),
        },
      };
    };

    const measurement: Measurement = { live: measure(live), stored: store ? measure(stored) : null };
    if (!peek) live = now;
    if (store) stored = now;
    return measurement;
  };
}

/** How long a (re)started sampler waits so samples stay one interval apart. */
export function startupDelay(lastAt: number | null, now: number, intervalMs: number): number {
  if (lastAt === null) return 0;
  const elapsed = now - lastAt;
  return elapsed >= 0 && elapsed < intervalMs ? intervalMs - elapsed : 0;
}
