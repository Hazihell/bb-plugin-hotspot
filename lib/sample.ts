/**
 * One reading of the machine: heat, load, and who is using the CPU.
 *
 * A sample costs one `ps` and one `notifyutil`. Machine-wide CPU comes from
 * the kernel's per-core tick counters (`os.cpus()`), which are exact over the
 * interval; per-process CPU comes from `ps`, which is only used for ranking.
 */
import os from "node:os";
import {
  type ProcessRow,
  type ProcessSource,
  attributeThreads,
  groupByThread,
  readProcesses,
  systemProcessSource,
  topUnattributed,
} from "./procs";
import type { Sample } from "./schemas";
import { readThermal } from "./thermal";

export const TOP_THREADS = 5;
/**
 * Threads kept per sample. A few beyond the five shown, so an id that turns
 * out to name no thread can be dropped when read without shortening the list.
 */
export const STORED_THREADS = TOP_THREADS + 3;
export const TOP_PROCESSES = 5;

interface CpuTicks {
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

export interface SamplerOptions {
  processes?: ProcessSource;
  thermal?: () => Promise<number | null>;
  /** Told when `ps` fails; the sample is still taken, without processes. */
  onProcessError?: (error: unknown) => void;
}

/** Less than this much CPU time per core since the last reading is too noisy to trust. */
const MIN_TICK_MS_PER_CORE = 1_000;

export function createSampler(options: SamplerOptions = {}) {
  const source = options.processes ?? systemProcessSource;
  const thermalReader = options.thermal ?? readThermal;
  const cores = Math.max(1, os.cpus().length);
  let previousTicks: CpuTicks = readTicks();

  return async function takeSample(now = Date.now()): Promise<Sample> {
    const [rows, thermal] = await Promise.all([
      readProcesses(source).catch((error: unknown): ProcessRow[] | null => {
        options.onProcessError?.(error);
        return null;
      }),
      thermalReader(),
    ]);
    const ticks = readTicks();
    const kernelCpu = cpuBetween(previousTicks, ticks);
    const enoughTicks = ticks.total - previousTicks.total >= MIN_TICK_MS_PER_CORE * cores;
    previousTicks = ticks;
    // Right after a load the tick interval is too short to mean anything, so
    // the `ps` sum stands in; without `ps`, the short interval is all there is.
    const psCpu =
      rows === null ? null : clampPercent(rows.reduce((sum, row) => sum + row.cpuPercent, 0) / cores);
    const cpu = (enoughTicks ? kernelCpu : (psCpu ?? kernelCpu)) ?? 0;
    if (rows === null) {
      return { at: now, thermal, cpu, load: loadPerCore(cores), threads: [], procs: [] };
    }

    const attribution = attributeThreads(rows);
    const threads = groupByThread(rows, attribution)
      .filter((entry) => entry.cpuPercent > 0)
      .slice(0, STORED_THREADS);
    return {
      at: now,
      thermal,
      cpu,
      load: loadPerCore(cores),
      threads: threads.map((entry) => ({
        threadId: entry.threadId,
        cpu: round(entry.cpuPercent / cores),
        processes: entry.processCount,
      })),
      procs: topUnattributed(rows, attribution, TOP_PROCESSES).map((row) => ({
        pid: row.pid,
        name: row.name,
        cpu: round(row.cpuPercent / cores),
      })),
    };
  };
}
