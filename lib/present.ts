/**
 * The words and numbers the popover and the Hotspot page show: the verdict
 * that leads every surface, human times and durations, chart ticks, and the
 * kill summary. Pure and free of Node and zod, so the app bundle imports it
 * and tests pin the wording. Times use the viewer's time zone; `locale`
 * exists so tests can pin the format.
 */
import { type FooterInput, type FooterTone, footerView } from "./footer";
import { thermalLabel } from "./labels";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Below this share of the Mac a thread is not "the one to blame". */
export const BLAME_MIN_CPU = 5;

export const pct = (value: number) => `${Math.round(value)}%`;

/** A thread's CPU for a list: `41%`, or `<1%` rather than a misleading `0%`. */
export function cpuText(cpu: number): string {
  return cpu < 0.5 ? "<1%" : pct(cpu);
}

export interface Verdict {
  /** The same dot colour as the footer indicator. */
  tone: FooterTone;
  /** `Running hot`, `Warming up`, `Working hard`, `Running cool`. */
  headline: string;
  /** Start of the open hot episode, if one is open. */
  since: number | null;
  /** `83% CPU · thermal pressure heavy`. */
  detail: string;
  /** The thread to blame, when one uses a real share of the Mac. */
  culprit: { threadId: string; title: string | null; cpu: number } | null;
  /** Said instead of a culprit. */
  reassurance: string | null;
}

/**
 * The answer every surface leads with: is the Mac hot, and who is to blame.
 * The dot keeps the footer's rule (heat by thermal level); the words also
 * say when the CPU alone is over the threshold.
 */
export function verdict(input: FooterInput & { openSince: number | null }): Verdict {
  const { latest } = input;
  if (latest === null) {
    return {
      tone: "idle",
      headline: "Waiting for the first reading",
      since: null,
      detail: "Hotspot checks the Mac every few seconds while BB is on screen, and once a minute otherwise.",
      culprit: null,
      reassurance: null,
    };
  }
  const { tone } = footerView(input);
  const overCpu = latest.cpu >= input.cpuThreshold;
  const thermal = latest.thermal ?? 0;
  const headline =
    input.hot || thermal >= 2 || (latest.thermal === null && overCpu)
      ? "Running hot"
      : thermal === 1
        ? "Warming up"
        : overCpu
          ? "Working hard"
          : "Running cool";
  const detail =
    latest.thermal === null
      ? `${pct(latest.cpu)} CPU`
      : `${pct(latest.cpu)} CPU · thermal pressure ${thermalLabel(latest.thermal)}`;
  const top = latest.threads[0];
  const culprit = top !== undefined && top.cpu >= BLAME_MIN_CPU ? top : null;
  const calm = headline === "Running cool";
  const reassurance =
    culprit !== null ? null : calm ? "Nothing in BB is working hard." : "No BB thread is the main cause.";
  return { tone, headline, since: input.hot ? input.openSince : null, detail, culprit, reassurance };
}

function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** `2:13 PM` (or `14:13`, by locale). */
export function clockText(at: number, locale?: string): string {
  return new Date(at).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
}

/** `2:13 PM` today, `Yesterday 2:13 PM`, `Mon 2:13 PM` this week, else `Sep 20, 2:13 PM`. */
export function dayClockText(at: number, now: number, locale?: string): string {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY);
  const clock = clockText(at, locale);
  if (days <= 0) return clock;
  if (days === 1) return `Yesterday ${clock}`;
  if (days < 7) return `${new Date(at).toLocaleDateString(locale, { weekday: "short" })} ${clock}`;
  return `${new Date(at).toLocaleDateString(locale, { month: "short", day: "numeric" })}, ${clock}`;
}

/** `2 min`, `1 h`, `1 h 5 min`; never less than a minute. */
export function durationText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** `7 processes · running a turn` under a thread's title; `running` is null while unknown. */
export function threadMeta(processes: number, running: boolean | null): string {
  const count = `${processes} process${processes === 1 ? "" : "es"}`;
  return running === null ? count : `${count} · ${running ? "running a turn" : "no turn running"}`;
}

/** A thread holding less resident memory than this, at under 1% CPU, is idle. */
export const IDLE_MEM_BYTES = 1024 ** 3;

/**
 * Busy threads, most CPU first, and the idle ones the popover folds away:
 * under 1% CPU as shown (`<1%`) and under `IDLE_MEM_BYTES` of memory. A
 * thread whose memory is unknown counts as small.
 */
export function splitIdle<T extends { cpu: number; memBytes?: number | null }>(
  threads: readonly T[],
): { busy: T[]; idle: T[] } {
  const isIdle = (thread: T) => cpuText(thread.cpu) === "<1%" && (thread.memBytes ?? 0) < IDLE_MEM_BYTES;
  const byCpu = [...threads].sort((a, b) => b.cpu - a.cpu);
  return { busy: byCpu.filter((thread) => !isIdle(thread)), idle: byCpu.filter(isIdle) };
}

export interface Tick {
  at: number;
  label: string;
}

const TICK_STEPS = [HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY];

/**
 * Round-aligned time ticks for the chart: whole local hours for a day,
 * local midnights for a week, as many as fit in `maxTicks`.
 */
export function timeTicks(from: number, to: number, maxTicks: number, locale?: string): Tick[] {
  const span = to - from;
  const step = TICK_STEPS.find((candidate) => span / candidate <= maxTicks) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const ticks: Tick[] = [];
  if (step < DAY) {
    const hours = step / HOUR;
    const first = new Date(from);
    first.setMinutes(0, 0, 0);
    while (first.getTime() < from || first.getHours() % hours !== 0) first.setHours(first.getHours() + 1);
    for (const at = first; at.getTime() <= to; at.setHours(at.getHours() + hours)) {
      ticks.push({ at: at.getTime(), label: at.toLocaleTimeString(locale, { hour: "numeric" }) });
    }
  } else {
    const days = step / DAY;
    const first = new Date(startOfDay(from));
    if (first.getTime() < from) first.setDate(first.getDate() + 1);
    for (const at = first; at.getTime() <= to; at.setDate(at.getDate() + days)) {
      ticks.push({ at: at.getTime(), label: at.toLocaleDateString(locale, { weekday: "short" }) });
    }
  }
  return ticks;
}

/** `node ×7 · esbuild ×2 · next-server · 2 more`: what a kill hits, most common name first. */
export function processSummary(names: readonly string[], max = 4): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  const shown = ranked.slice(0, max).map(([name, count]) => (count === 1 ? name : `${name} ×${count}`));
  const rest = ranked.length - shown.length;
  return rest > 0 ? [...shown, `${rest} more`].join(" · ") : shown.join(" · ");
}

export interface GapLabel {
  text: string;
  /** Centre of the label, in the same units as the span. */
  x: number;
}

/** Rough width of chart label text: 11px system sans averages about 6px a character. */
export const labelWidth = (text: string, charPx = 6) => text.length * charPx;

/**
 * The note for the stretch of the chart before the first reading: centred
 * in that stretch, and left out when the stretch cannot fit it with
 * `padding` on each side. `firstAt` is null when there is no reading at all,
 * and the whole plot is the stretch.
 */
export function gapLabel(
  plotStart: number,
  plotEnd: number,
  firstX: number | null,
  firstAt: number | null,
  locale?: string,
  padding = 8,
): GapLabel | null {
  const end = firstX ?? plotEnd;
  const text = firstAt === null ? "No readings yet" : `No readings before ${clockText(firstAt, locale)}`;
  if (end - plotStart < labelWidth(text) + 2 * padding) return null;
  return { text, x: (plotStart + end) / 2 };
}

/**
 * The episode under a point on the timeline, or the nearest one within
 * `toleranceMs`, so a short hot spell can be hit with a finger.
 */
export function episodeNear<T extends { startAt: number; endAt: number | null; lastHotAt: number }>(
  episodes: readonly T[],
  at: number,
  toleranceMs: number,
  now: number,
): T | null {
  let best: T | null = null;
  let bestDistance = Infinity;
  for (const episode of episodes) {
    const end = episode.endAt ?? now;
    const distance = at < episode.startAt ? episode.startAt - at : at > end ? at - end : 0;
    if (distance <= toleranceMs && distance < bestDistance) {
      best = episode;
      bestDistance = distance;
    }
  }
  return best;
}
