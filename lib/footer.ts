/**
 * What the sidebar footer indicator says. Pure and free of Node and zod, so
 * the app bundle imports it and tests pin the wording.
 *
 * The footer row is shared with other plugins' readouts, so every number
 * carries its label ("CPU 16%", "MEM 62%") and the flame icon names the
 * plugin. When the row is narrow the readout sheds words before numbers:
 * the thread title first, then it stacks the two metrics on two short lines
 * with the heat word beside them, then drops the heat word (the icon's
 * colour still says it), then the second metric. It never drops a label to
 * keep a number.
 */
import { bytesText, thermalLabel } from "./labels";

export interface FooterInput {
  latest: {
    thermal: number | null;
    cpu: number;
    load: number;
    memory?: {
      percent: number;
      swapUsedBytes: number;
      pressure: "normal" | "warn" | "critical" | null;
    } | null;
    threads: ReadonlyArray<{ threadId: string; title: string | null; cpu: number; memBytes?: number | null }>;
  } | null;
  /** True while a hot episode is open. */
  hot: boolean;
  cpuThreshold: number;
}

/** Dot colour: nominal, moderate, heavy or worse; unknown thermal falls back to the CPU rule. */
export type FooterTone = "calm" | "warm" | "hot" | "idle";

/** The word shown beside the icon when the Mac is not calm. */
export type FooterHeat = "Hot" | "Warm" | "Busy";

/** Whether a number deserves a colour: amber for `warn`, red for `hot`. */
export type MetricAlert = "warn" | "hot" | null;

export interface FooterMetric {
  label: "CPU" | "MEM";
  /** `16%`, or `—` before the first sample. */
  value: string;
  alert: MetricAlert;
}

export interface FooterView {
  tone: FooterTone;
  /** Null while calm; the icon colour follows it. */
  heat: FooterHeat | null;
  cpu: FooterMetric;
  /** Null when memory has not been read. */
  mem: FooterMetric | null;
  /** The top thread's short title, while the Mac is not calm. */
  title: string | null;
  /** The full line for the native hover tooltip. */
  tooltip: string;
}

/**
 * One way to fill the footer, from the full line down to a single labelled
 * number. A `row` is one line of parts joined with ` · `; a `stack` puts
 * the metrics on two lines in a smaller size, with the heat word beside them.
 */
export interface FooterLine {
  layout: "row" | "stack";
  heat: FooterHeat | null;
  metrics: FooterMetric[];
  title: string | null;
  /** The whole readout as one string: the tooltip-free summary, and the row as drawn. */
  text: string;
}

/** How wide `text` draws: `line` in the footer's text size, `stack` in the stacked metrics' smaller size. */
export type FooterMeasure = (text: string, size: "line" | "stack") => number;

/** Pixels between the stacked metrics and the heat word. */
export const STACK_GAP = 4;

export const TITLE_CHARS = 20;

const pct = (value: number) => `${Math.round(value)}%`;

export function shortTitle(title: string, max = TITLE_CHARS): string {
  const clean = title.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

const threadName = (thread: { threadId: string; title: string | null }) => thread.title ?? thread.threadId;

export const metricText = (metric: FooterMetric) => `${metric.label} ${metric.value}`;
/** A stacked metric joins its label with a narrow no-break space: a phone's footer has no pixels to spare. */
export const STACK_SPACE = "\u202f";
export const stackText = (metric: FooterMetric) => `${metric.label}${STACK_SPACE}${metric.value}`;

const IDLE_TOOLTIP = "Hotspot: waiting for the first sample";

export function footerView(input: FooterInput): FooterView {
  const { latest } = input;
  if (latest === null) {
    return {
      tone: "idle",
      heat: null,
      cpu: { label: "CPU", value: "—", alert: null },
      mem: null,
      title: null,
      tooltip: IDLE_TOOLTIP,
    };
  }
  const overCpu = latest.cpu >= input.cpuThreshold;
  const thermal = latest.thermal;
  const tone: FooterTone =
    thermal === null ? (overCpu ? "hot" : "calm") : thermal >= 2 ? "hot" : thermal === 1 ? "warm" : "calm";
  const heat: FooterHeat | null =
    input.hot || tone === "hot" ? "Hot" : tone === "warm" ? "Warm" : overCpu ? "Busy" : null;

  const memory = latest.memory ?? null;
  const cpu: FooterMetric = { label: "CPU", value: pct(latest.cpu), alert: overCpu ? "hot" : null };
  const mem: FooterMetric | null =
    memory === null
      ? null
      : {
          label: "MEM",
          value: pct(memory.percent),
          alert: memory.pressure === "critical" ? "hot" : memory.pressure === "warn" ? "warn" : null,
        };
  const top = latest.threads[0];
  const title = heat !== null && top !== undefined ? shortTitle(threadName(top)) : null;

  const memoryText =
    memory === null
      ? "Memory not read"
      : `Memory ${pct(memory.percent)} (swap ${bytesText(memory.swapUsedBytes)}, pressure ${memory.pressure ?? "unknown"})`;
  const summary = [
    `Thermal ${thermalLabel(thermal)}`,
    `CPU ${pct(latest.cpu)}`,
    memoryText,
    `load ${latest.load.toFixed(2)}/core`,
  ].join(" · ");
  const threads = latest.threads.slice(0, 3).map((thread) => {
    const memBytes = thread.memBytes ?? null;
    return `${threadName(thread)} ${pct(thread.cpu)} CPU${memBytes === null ? "" : ` · ${bytesText(memBytes)}`}`;
  });
  const tooltip = [
    `Hotspot${input.hot ? " (hot episode)" : ""}: ${summary}`,
    threads.length === 0 ? "No BB thread is using CPU" : `Top threads: ${threads.join(", ")}`,
  ].join("\n");

  return { tone, heat, cpu, mem, title, tooltip };
}

function line(
  layout: FooterLine["layout"],
  heat: FooterHeat | null,
  metrics: FooterMetric[],
  title: string | null,
): FooterLine {
  const text = [heat, ...metrics.map(metricText), title].filter((part) => part !== null).join(" · ");
  return { layout, heat, metrics, title, text };
}

/**
 * Every readout the footer may show, most complete first: the full row;
 * the row without the title; the metrics stacked with the heat word; the
 * stack alone; one metric in the stack's smaller size. Without memory the
 * ladder has no stacks and ends at the CPU row. The one metric is memory
 * only when memory is flagged and CPU is not.
 */
export function footerLines(view: FooterView): FooterLine[] {
  const both = view.mem === null ? [view.cpu] : [view.cpu, view.mem];
  const primary = view.mem !== null && view.mem.alert !== null && view.cpu.alert === null ? view.mem : view.cpu;
  const lines = [
    line("row", view.heat, both, view.title),
    line("row", view.heat, both, null),
    ...(both.length > 1
      ? [line("stack", view.heat, both, null), line("stack", null, both, null), line("stack", null, [primary], null)]
      : [line("row", null, [primary], null)]),
  ];
  const key = (candidate: FooterLine) => `${candidate.layout}:${candidate.text}`;
  return lines.filter((candidate, index) => lines.findIndex((other) => key(other) === key(candidate)) === index);
}

/** How wide a readout draws. */
export function footerWidth(candidate: FooterLine, measure: FooterMeasure): number {
  if (candidate.layout === "row") return measure(candidate.text, "line");
  const stack = Math.max(...candidate.metrics.map((metric) => measure(stackText(metric), "stack")));
  return candidate.heat === null ? stack : stack + STACK_GAP + measure(candidate.heat, "line");
}

/**
 * The most complete readout that fits in `width` pixels; the last one when
 * none fits.
 */
export function fitFooter(view: FooterView, width: number, measure: FooterMeasure): FooterLine {
  const lines = footerLines(view);
  return lines.find((candidate) => footerWidth(candidate, measure) <= width) ?? lines[lines.length - 1];
}
