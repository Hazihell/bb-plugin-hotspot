/**
 * One reading of the machine: heat, load, and who is using the CPU.
 *
 * A sample costs one `ps` and one `notifyutil`. Machine-wide CPU comes from
 * the kernel's per-core tick counters (`os.cpus()`), which are exact over the
 * interval; per-process CPU comes from `ps`, which is only used for ranking.
 */
import os from "node:os";
import { attributeThreads, groupByThread, readProcesses, topUnattributed } from "./procs";
import { readThermal } from "./thermal";

export const TOP_THREADS = 5;
export const TOP_PROCESSES = 5;

export interface ThreadEntry {
  threadId: string;
  title: string | null;
  /** Share of the whole machine, 0–100 (not per-core `ps` percent). */
  cpu: number;
  processes: number;
}

export interface ProcessEntry {
  pid: number;
  name: string;
  /** Share of the whole machine, 0–100. */
  cpu: number;
}

export interface Sample {
  at: number;
  /** macOS thermal pressure 0–4, or null where it cannot be read. */
  thermal: number | null;
  /** Machine-wide CPU busy, 0–100. */
  cpu: number;
  /** One-minute load average divided by core count. */
  load: number;
  threads: ThreadEntry[];
  procs: ProcessEntry[];
}

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

export type TitleResolver = (threadIds: string[]) => Promise<Map<string, string>>;

export function createSampler(resolveTitles: TitleResolver) {
  let previousTicks: CpuTicks | null = null;
  const cores = Math.max(1, os.cpus().length);

  return async function takeSample(now = Date.now()): Promise<Sample> {
    const [rows, thermal] = await Promise.all([readProcesses(), readThermal()]);
    const ticks = readTicks();
    // The first sample after a load has no interval yet; `ps` is the fallback.
    const psCpu = clampPercent(rows.reduce((sum, row) => sum + row.cpuPercent, 0) / cores);
    const cpu = (previousTicks === null ? null : cpuBetween(previousTicks, ticks)) ?? psCpu;
    previousTicks = ticks;

    const attribution = attributeThreads(rows);
    const threads = groupByThread(rows, attribution)
      .filter((entry) => entry.cpuPercent > 0)
      .slice(0, TOP_THREADS);
    const titles = await resolveTitles(threads.map((entry) => entry.threadId)).catch(
      () => new Map<string, string>(),
    );
    return {
      at: now,
      thermal,
      cpu,
      load: Math.round((os.loadavg()[0] / cores) * 100) / 100,
      threads: threads.map((entry) => ({
        threadId: entry.threadId,
        title: titles.get(entry.threadId) ?? null,
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
