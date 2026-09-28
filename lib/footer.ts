/**
 * What the sidebar footer indicator says. Pure and free of Node and zod, so
 * the app bundle imports it and tests pin the wording.
 */
import { thermalLabel } from "./labels";

export interface FooterInput {
  latest: {
    thermal: number | null;
    cpu: number;
    load: number;
    threads: ReadonlyArray<{ threadId: string; title: string | null; cpu: number }>;
  } | null;
  /** True while a hot episode is open. */
  hot: boolean;
  cpuThreshold: number;
}

/** Dot colour: nominal, moderate, heavy or worse; unknown thermal falls back to the CPU rule. */
export type FooterTone = "calm" | "warm" | "hot" | "idle";

export interface FooterView {
  tone: FooterTone;
  /** The inline text, e.g. `13%` or `Heavy · 83% · Home page C…`. */
  text: string;
  /** The same text in parts, so a narrow footer can cut the title and keep the numbers. */
  level: string | null;
  cpu: string;
  title: string | null;
  /** The full line for the native hover tooltip. */
  tooltip: string;
}

export const TITLE_CHARS = 20;

const pct = (value: number) => `${Math.round(value)}%`;
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function shortTitle(title: string, max = TITLE_CHARS): string {
  const clean = title.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

const threadName = (thread: { threadId: string; title: string | null }) => thread.title ?? thread.threadId;

export function footerView(input: FooterInput): FooterView {
  const { latest } = input;
  if (latest === null) {
    return { tone: "idle", text: "—", level: null, cpu: "—", title: null, tooltip: "Hotspot: waiting for the first sample" };
  }
  const overCpu = latest.cpu >= input.cpuThreshold;
  const thermal = latest.thermal;
  const tone: FooterTone =
    thermal === null ? (overCpu ? "hot" : "calm") : thermal >= 2 ? "hot" : thermal === 1 ? "warm" : "calm";

  const level = thermal !== null && thermal >= 1 ? capitalize(thermalLabel(thermal)) : null;
  const cpu = pct(latest.cpu);
  const top = latest.threads[0];
  const title = (input.hot || overCpu || (thermal ?? 0) >= 1) && top !== undefined ? shortTitle(threadName(top)) : null;

  const summary = [
    `Thermal ${thermalLabel(thermal)}`,
    `CPU ${pct(latest.cpu)}`,
    `load ${latest.load.toFixed(2)}/core`,
  ].join(" · ");
  const threads = latest.threads.slice(0, 3).map((thread) => `${threadName(thread)} ${pct(thread.cpu)}`);
  const tooltip = [
    `Hotspot${input.hot ? " (hot episode)" : ""}: ${summary}`,
    threads.length === 0 ? "No BB thread is using CPU" : `Top threads: ${threads.join(", ")}`,
  ].join("\n");

  const text = [level, cpu, title].filter((part) => part !== null).join(" · ");
  return { tone, text, level, cpu, title, tooltip };
}
