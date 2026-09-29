/**
 * Read-side shaping shared by the page, the CLI and the agent tool.
 */
import { CULPRIT_PROCS, bytesText, thermalLabel } from "./labels";
import type { KillPlanView, KillResultView } from "./contract";
import type { BbTotal, EpisodeView, Memory, Sample, SampleView, TimelinePoint } from "./schemas";

/**
 * Fold samples into `count` equal buckets over [from, to).
 *
 * Each bucket keeps its *highest* CPU, memory, load and thermal level, so a
 * one-minute spike is still visible on a seven-day chart. Buckets with no
 * sample stay null and draw as gaps, which is how the chart shows the Mac
 * was asleep.
 */
export function bucketSamples(
  samples: ReadonlyArray<Pick<Sample, "at" | "cpu" | "thermal" | "load"> & { mem: number | null }>,
  from: number,
  to: number,
  count: number,
): { bucketMs: number; points: TimelinePoint[] } {
  const bucketMs = Math.max(1, Math.ceil((to - from) / count));
  const points: TimelinePoint[] = Array.from({ length: count }, (_, index) => ({
    at: from + index * bucketMs,
    cpu: null,
    thermal: null,
    mem: null,
    load: null,
  }));
  for (const sample of samples) {
    const index = Math.floor((sample.at - from) / bucketMs);
    const point = points[index];
    if (point === undefined) continue;
    point.cpu = Math.max(point.cpu ?? 0, sample.cpu);
    point.load = Math.max(point.load ?? 0, sample.load);
    if (sample.mem !== null) point.mem = Math.max(point.mem ?? 0, sample.mem);
    if (sample.thermal !== null) point.thermal = Math.max(point.thermal ?? 0, sample.thermal);
  }
  return { bucketMs, points };
}

/* ------------------------------------------------------------------ */
/* Text for the CLI and the agent tool                                 */
/* ------------------------------------------------------------------ */

const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
};

/**
 * A point in time from what a person or agent would type.
 *
 * `90m`, `3h`, `2d`, `1w` count back from now; `15:00` is the most recent
 * 15:00 in server-local time; anything else goes to `Date.parse` (ISO dates
 * and times). Returns null for text that names no time.
 */
export function parseWhen(text: string, now: number): number | null {
  const trimmed = text.trim().toLowerCase();
  const relative = /^(\d+(?:\.\d+)?)\s*([mhdw])$/.exec(trimmed);
  if (relative !== null) return now - Number(relative[1]) * UNIT_MS[relative[2]];
  const clockMatch = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (clockMatch !== null) {
    const [hours, minutes] = [Number(clockMatch[1]), Number(clockMatch[2])];
    if (hours > 23 || minutes > 59) return null;
    const at = new Date(now);
    at.setHours(hours, minutes, 0, 0);
    const value = at.getTime();
    return value > now ? value - UNIT_MS.d : value;
  }
  const parsed = Date.parse(text.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** `2026-09-28 15:02`, server-local time. */
export function formatWhen(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${pad(minutes % 60)}m`;
}

const pct = (value: number) => `${Math.round(value)}%`;
const threadName = (entry: { threadId: string; title: string | null }) =>
  entry.title === null ? entry.threadId : `${entry.title} (${entry.threadId})`;

/** `memory 76% used (12.9 of 16 GB: app 5.2 GB, …), swap 5.7 GB, pressure normal`. */
export function describeMemory(memory: Memory): string {
  const parts = [
    `app ${bytesText(memory.appBytes)}`,
    `wired ${bytesText(memory.wiredBytes)}`,
    `compressed ${bytesText(memory.compressedBytes)}`,
  ];
  return (
    `memory ${pct(memory.percent)} used (${bytesText(memory.usedBytes)} of ${bytesText(memory.totalBytes)}: ${parts.join(", ")}), ` +
    `swap ${bytesText(memory.swapUsedBytes)}, pressure ${memory.pressure ?? "unknown"}`
  );
}

/** `BB total 23%, 3.1 GB, 41 processes (app 5%, 1.2 GB; threads 18%, 1.9 GB)`. Memory sums RSS, so shared pages count more than once. */
export function describeBbTotal(bb: BbTotal): string {
  const part = (entry: BbTotal["app"]) => `${pct(entry.cpu)}, ${bytesText(entry.memBytes)}`;
  return (
    `BB total ${part(bb)}, ${bb.processes} processes (app ${part(bb.app)}; threads ${part(bb.threads)}); ` +
    "memory sums each process's resident size, so shared pages count more than once"
  );
}

const memCell = (bytes: number | null) => (bytes === null ? "" : `  ${bytesText(bytes).padStart(6)}`);

export function describeSample(sample: SampleView): string[] {
  const lines = [
    `${formatWhen(sample.at)}  thermal ${thermalLabel(sample.thermal)}, CPU ${pct(sample.cpu)}, load/core ${sample.load.toFixed(2)}`,
    sample.memory === null ? "  memory: not read" : `  ${describeMemory(sample.memory)}`,
  ];
  if (sample.bb != null) lines.push(`  ${describeBbTotal(sample.bb)}`);
  if (sample.threads.length === 0) lines.push("  threads: none using CPU");
  for (const thread of sample.threads) {
    lines.push(`  thread ${pct(thread.cpu).padStart(4)}${memCell(thread.memBytes)}  ${threadName(thread)}, ${thread.processes} proc`);
    // Its busiest processes, indented under it, in the same columns.
    for (const proc of thread.top ?? []) {
      lines.push(`         ${pct(proc.cpu).padStart(4)}${memCell(proc.memBytes)}    ${proc.name} (pid ${proc.pid})`);
    }
    const rest = thread.processes - (thread.top?.length ?? thread.processes);
    if (rest > 0) lines.push(`                       …and ${rest} more`);
  }
  for (const proc of sample.procs) {
    lines.push(`  other  ${pct(proc.cpu).padStart(4)}  ${proc.name} (pid ${proc.pid})`);
  }
  return lines;
}

export function describeEpisode(episode: EpisodeView, culpritLimit: number): string[] {
  const end = episode.endAt ?? episode.lastHotAt;
  const lines = [
    `#${episode.id ?? "?"}  ${formatWhen(episode.startAt)} → ${episode.endAt === null ? "ongoing" : formatWhen(end)}` +
      `  (${formatDuration(end - episode.startAt)}), peak thermal ${thermalLabel(episode.peakThermal)}, peak CPU ${pct(episode.peakCpu)}`,
  ];
  const samples = Math.max(1, episode.samples);
  const culprits = episode.culprits.slice(0, culpritLimit);
  if (culprits.length === 0) lines.push("  no BB thread was busy");
  for (const [index, culprit] of culprits.entries()) {
    lines.push(
      `  ${index + 1}. ${threadName(culprit)}  avg ${pct(culprit.cpuSum / samples)}, peak ${pct(culprit.peakCpu)}, in ${culprit.samples}/${episode.samples} hot samples`,
    );
    const procs = (culprit.procs ?? []).slice(0, CULPRIT_PROCS);
    if (procs.length > 0) {
      lines.push(`     processes: ${procs.map((proc) => `${proc.name} avg ${pct(proc.cpuSum / samples)}`).join(", ")}`);
    }
  }
  const others = episode.others.slice(0, 3);
  if (others.length > 0) {
    lines.push(
      `  outside threads: ${others.map((other) => `${other.name} avg ${pct(other.cpuSum / samples)}`).join(", ")}`,
    );
  }
  return lines;
}

export interface WindowThread {
  threadId: string;
  avgCpu: number;
  peakCpu: number;
  /** Highest resident memory seen, in bytes; null when no sample recorded it. */
  peakMemBytes: number | null;
}

export interface WindowSummary {
  samples: number;
  peakCpu: number;
  avgCpu: number;
  peakThermal: number | null;
  /** Memory used %, over the samples that read memory; null when none did. */
  avgMem: number | null;
  peakMem: number | null;
  peakSwapBytes: number | null;
  /** The worst kernel memory pressure seen. */
  peakPressure: Memory["pressure"];
  /** BB's total CPU and memory over the samples that recorded it; null when none did. */
  bb: { samples: number; avgCpu: number; peakCpu: number; peakMemBytes: number } | null;
  /** Every thread seen, by CPU summed over all samples in the window. */
  threads: WindowThread[];
}

const PRESSURES = ["normal", "warn", "critical"] as const;

export function summarizeWindow(samples: Sample[]): WindowSummary {
  const threads = new Map<string, { threadId: string; sum: number; peak: number; peakMem: number | null }>();
  let peakCpu = 0;
  let cpuSum = 0;
  let peakThermal: number | null = null;
  let memSum = 0;
  let memCount = 0;
  let peakMem: number | null = null;
  let peakSwapBytes: number | null = null;
  let pressureRank = -1;
  let bb: { samples: number; cpuSum: number; peakCpu: number; peakMemBytes: number } | null = null;
  for (const sample of samples) {
    if (sample.bb != null) {
      bb ??= { samples: 0, cpuSum: 0, peakCpu: 0, peakMemBytes: 0 };
      bb.samples += 1;
      bb.cpuSum += sample.bb.cpu;
      bb.peakCpu = Math.max(bb.peakCpu, sample.bb.cpu);
      bb.peakMemBytes = Math.max(bb.peakMemBytes, sample.bb.memBytes);
    }
    peakCpu = Math.max(peakCpu, sample.cpu);
    cpuSum += sample.cpu;
    if (sample.thermal !== null) peakThermal = Math.max(peakThermal ?? 0, sample.thermal);
    const { memory } = sample;
    if (memory !== null) {
      memSum += memory.percent;
      memCount += 1;
      peakMem = Math.max(peakMem ?? 0, memory.percent);
      peakSwapBytes = Math.max(peakSwapBytes ?? 0, memory.swapUsedBytes);
      pressureRank = Math.max(pressureRank, PRESSURES.indexOf(memory.pressure ?? "normal"));
    }
    for (const thread of sample.threads) {
      const entry = threads.get(thread.threadId) ?? { threadId: thread.threadId, sum: 0, peak: 0, peakMem: null };
      entry.sum += thread.cpu;
      entry.peak = Math.max(entry.peak, thread.cpu);
      if (thread.memBytes !== null) entry.peakMem = Math.max(entry.peakMem ?? 0, thread.memBytes);
      threads.set(thread.threadId, entry);
    }
  }
  const count = Math.max(1, samples.length);
  return {
    samples: samples.length,
    peakCpu,
    avgCpu: cpuSum / count,
    peakThermal,
    avgMem: memCount === 0 ? null : memSum / memCount,
    peakMem,
    peakSwapBytes,
    peakPressure: pressureRank < 0 ? null : PRESSURES[pressureRank],
    bb:
      bb === null
        ? null
        : { samples: bb.samples, avgCpu: bb.cpuSum / bb.samples, peakCpu: bb.peakCpu, peakMemBytes: bb.peakMemBytes },
    threads: [...threads.values()]
      .sort((a, b) => b.sum - a.sum)
      .map((entry) => ({
        threadId: entry.threadId,
        avgCpu: entry.sum / count,
        peakCpu: entry.peak,
        peakMemBytes: entry.peakMem,
      })),
  };
}

/** `threads` is the summary's list after naming (see lib/threads.ts `named`). */
export function describeWindow(
  summary: WindowSummary,
  threads: Array<WindowThread & { title: string | null }>,
): string[] {
  if (summary.samples === 0) return ["No samples in this window (the Mac was asleep or Hotspot was off)."];
  const lines = [
    `${summary.samples} samples: CPU avg ${pct(summary.avgCpu)}, peak ${pct(summary.peakCpu)}; peak thermal ${thermalLabel(summary.peakThermal)}`,
    summary.avgMem === null || summary.peakMem === null
      ? "Memory: not recorded in this window"
      : `Memory used avg ${pct(summary.avgMem)}, peak ${pct(summary.peakMem)}; peak swap ${bytesText(summary.peakSwapBytes ?? 0)}; worst pressure ${summary.peakPressure ?? "unknown"}`,
    summary.bb === null
      ? "BB total: not recorded in this window"
      : `BB total (app and all threads) CPU avg ${pct(summary.bb.avgCpu)}, peak ${pct(summary.bb.peakCpu)}; peak memory ${bytesText(summary.bb.peakMemBytes)} (summed resident size)`,
  ];
  for (const [index, thread] of threads.entries()) {
    const mem = thread.peakMemBytes === null ? "" : `, peak memory ${bytesText(thread.peakMemBytes)}`;
    lines.push(`  ${index + 1}. ${threadName(thread)}  CPU avg ${pct(thread.avgCpu)}, peak ${pct(thread.peakCpu)}${mem}`);
  }
  return lines;
}

/** Cut text at a line boundary so output never exceeds `maxChars`. */
export function clampText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.lastIndexOf("\n", maxChars - 40);
  return `${text.slice(0, cut > 0 ? cut : maxChars - 40)}\n… (truncated)`;
}

const processLine = (entry: { name: string; pid: number; cpu: number }) =>
  `  ${entry.name.slice(0, 40).padEnd(40)} pid ${String(entry.pid).padEnd(7)} ${`${entry.cpu.toFixed(1)}%`.padStart(6)}`;

/** A kill plan as the CLI prints it: what gets SIGTERM and what is spared, with the reason. */
export function describeKillPlan(plan: KillPlanView): string[] {
  const name = plan.title === null ? plan.threadId : `"${plan.title}" (${plan.threadId})`;
  const selected = plan.selected;
  const what = selected === null ? name : `${selected.name ?? "process"} (pid ${selected.pid}) in ${name}`;
  const lines =
    plan.targets.length === 0
      ? [selected?.reason == null ? `Nothing to kill in ${name}.` : `Nothing to kill: ${what} is ${selected.reason}.`]
      : [
          `Kill plan for ${what}: ${plan.targets.length} process(es) get SIGTERM, then SIGKILL after 5 s if still running:`,
          ...plan.targets.map(processLine),
        ];
  if (plan.excluded.length > 0) {
    lines.push("", "Spared:", ...plan.excluded.map((entry) => `${processLine(entry)}  ${entry.reason}`));
  }
  return lines;
}

export function describeKillResult(result: KillResultView): string[] {
  return [
    `Killed in ${result.threadId}: ${result.terminated} exited on SIGTERM, ${result.killed} needed SIGKILL, ${result.refused} refused.`,
    ...result.outcomes.map(
      (outcome) => `${processLine(outcome)}  ${outcome.result}${outcome.detail === null ? "" : ` (${outcome.detail})`}`,
    ),
  ];
}
