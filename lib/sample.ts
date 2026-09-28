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
  attributeThreads,
  groupByThread,
  readProcesses,
  systemProcessSource,
  topUnattributed,
} from "./procs";
import { type MemorySource, readMemory, systemMemorySource } from "./memory";
import type { Memory, Sample } from "./schemas";
import { readThermal } from "./thermal";

export const TOP_THREADS = 5;
/**
 * Threads kept per sample. A few beyond the five shown, so an id that turns
 * out to name no thread can be dropped when read without shortening the list.
 */
export const STORED_THREADS = TOP_THREADS + 3;
export const TOP_PROCESSES = 5;

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
  /** Each process's CPU time in ms, by process key (pid and start time). */
  times: Map<string, number>;
}

/** Below this much wall time between readings, per-process CPU time is too coarse to trust. */
export const MIN_ELAPSED_MS = 500;

/**
 * Each row's CPU over the window since `baseline`, in percent of one core:
 * the CPU time it used divided by the wall time between the readings. A
 * process the baseline did not see (new, a reused pid, or the first
 * reading after a load) keeps `ps`'s own figure, and so does every process
 * when the window is too short to measure. A process that exited is simply
 * absent from `rows`.
 */
export function cpuSince(rows: readonly ProcessRow[], baseline: Baseline, clockMs: number): ProcessRow[] {
  const elapsed = clockMs - baseline.clockMs;
  if (elapsed < MIN_ELAPSED_MS) return [...rows];
  return rows.map((row) => {
    const before = row.key === null ? undefined : baseline.times.get(row.key);
    if (before === undefined || row.cpuMs === null || row.cpuMs < before) return row;
    return { ...row, cpuPercent: ((row.cpuMs - before) / elapsed) * 100 };
  });
}

function timesOf(rows: readonly ProcessRow[] | null): Map<string, number> {
  const times = new Map<string, number>();
  for (const row of rows ?? []) if (row.key !== null && row.cpuMs !== null) times.set(row.key, row.cpuMs);
  return times;
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

export type TakeReading = (at: number, options: { store: boolean }) => Promise<Measurement>;

/**
 * Takes readings. Each one advances the live window; one taken with
 * `store` also advances the stored window. Readings must not overlap.
 */
export function createSampler(options: SamplerOptions = {}): TakeReading {
  const source = options.processes ?? systemProcessSource;
  const thermalReader = options.thermal ?? readThermal;
  const memorySource = options.memory ?? systemMemorySource;
  const clock = options.clock ?? (() => performance.now());
  const ticksNow = options.ticks ?? readTicks;
  const cores = options.cores ?? Math.max(1, os.cpus().length);
  // Until the first reading no process has a baseline, so every process falls back to `ps`.
  const loaded: Baseline = { clockMs: clock(), ticks: ticksNow(), times: new Map() };
  let live = loaded;
  let stored = loaded;

  return async function takeReading(at, { store }) {
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
    const now: Baseline = { clockMs: clock(), ticks: ticksNow(), times: timesOf(rows) };
    const load = loadPerCore(cores);

    const measure = (since: Baseline): Sample => {
      const kernelCpu = cpuBetween(since.ticks, now.ticks);
      const enoughTicks = now.ticks.total - since.ticks.total >= MIN_TICK_MS_PER_CORE * cores;
      const measured = rows === null ? null : cpuSince(rows, since, now.clockMs);
      // Right after a load the tick interval is too short to mean anything, so
      // the process sum stands in; without `ps`, the short interval is all there is.
      const psCpu =
        measured === null ? null : clampPercent(measured.reduce((sum, row) => sum + row.cpuPercent, 0) / cores);
      const cpu = (enoughTicks ? kernelCpu : (psCpu ?? kernelCpu)) ?? 0;
      if (measured === null) return { at, thermal, cpu, load, memory, threads: [], procs: [] };

      const attribution = attributeThreads(measured);
      const threads = groupByThread(measured, attribution)
        .filter((entry) => entry.cpuPercent > 0)
        .slice(0, STORED_THREADS);
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
        })),
        procs: topUnattributed(measured, attribution, TOP_PROCESSES).map((row) => ({
          pid: row.pid,
          name: row.name,
          cpu: round(row.cpuPercent / cores),
        })),
      };
    };

    const measurement: Measurement = { live: measure(live), stored: store ? measure(stored) : null };
    live = now;
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
