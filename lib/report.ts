/**
 * Read-side shaping shared by the page, the CLI and the agent tool.
 */
import { thermalLabel } from "./labels";
import type { Episode, Sample, TimelinePoint } from "./schemas";

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

export function describeSample(sample: Sample): string[] {
  const lines = [
    `${formatWhen(sample.at)}  thermal ${thermalLabel(sample.thermal)}, CPU ${pct(sample.cpu)}, load/core ${sample.load.toFixed(2)}`,
  ];
  if (sample.threads.length === 0) lines.push("  threads: none using CPU");
  for (const thread of sample.threads) {
    lines.push(`  thread ${pct(thread.cpu).padStart(4)}  ${threadName(thread)}, ${thread.processes} proc`);
  }
  for (const proc of sample.procs) {
    lines.push(`  other  ${pct(proc.cpu).padStart(4)}  ${proc.name} (pid ${proc.pid})`);
  }
  return lines;
}

export function describeEpisode(episode: Episode, culpritLimit: number): string[] {
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
  }
  const others = episode.others.slice(0, 3);
  if (others.length > 0) {
    lines.push(
      `  outside threads: ${others.map((other) => `${other.name} avg ${pct(other.cpuSum / samples)}`).join(", ")}`,
    );
  }
  return lines;
}

export interface WindowSummary {
  samples: number;
  peakCpu: number;
  avgCpu: number;
  peakThermal: number | null;
  /** Threads by CPU summed over every sample in the window. */
  threads: Array<{ threadId: string; title: string | null; avgCpu: number; peakCpu: number }>;
}

export function summarizeWindow(samples: Sample[], threadLimit: number): WindowSummary {
  const threads = new Map<string, { threadId: string; title: string | null; sum: number; peak: number }>();
  let peakCpu = 0;
  let cpuSum = 0;
  let peakThermal: number | null = null;
  for (const sample of samples) {
    peakCpu = Math.max(peakCpu, sample.cpu);
    cpuSum += sample.cpu;
    if (sample.thermal !== null) peakThermal = Math.max(peakThermal ?? 0, sample.thermal);
    for (const thread of sample.threads) {
      const entry = threads.get(thread.threadId) ?? { threadId: thread.threadId, title: null, sum: 0, peak: 0 };
      entry.sum += thread.cpu;
      entry.peak = Math.max(entry.peak, thread.cpu);
      entry.title = thread.title ?? entry.title;
      threads.set(thread.threadId, entry);
    }
  }
  const count = Math.max(1, samples.length);
  return {
    samples: samples.length,
    peakCpu,
    avgCpu: cpuSum / count,
    peakThermal,
    threads: [...threads.values()]
      .sort((a, b) => b.sum - a.sum)
      .slice(0, threadLimit)
      .map((entry) => ({
        threadId: entry.threadId,
        title: entry.title,
        avgCpu: entry.sum / count,
        peakCpu: entry.peak,
      })),
  };
}

export function describeWindow(summary: WindowSummary): string[] {
  if (summary.samples === 0) return ["No samples in this window (the Mac was asleep or Hotspot was off)."];
  const lines = [
    `${summary.samples} samples: CPU avg ${pct(summary.avgCpu)}, peak ${pct(summary.peakCpu)}; peak thermal ${thermalLabel(summary.peakThermal)}`,
  ];
  for (const [index, thread] of summary.threads.entries()) {
    lines.push(`  ${index + 1}. ${threadName(thread)}  avg ${pct(thread.avgCpu)}, peak ${pct(thread.peakCpu)}`);
  }
  return lines;
}

/** Cut text at a line boundary so output never exceeds `maxChars`. */
export function clampText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.lastIndexOf("\n", maxChars - 40);
  return `${text.slice(0, cut > 0 ? cut : maxChars - 40)}\n… (truncated)`;
}
