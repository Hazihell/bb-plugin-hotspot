/**
 * Hot-episode detection: a pure state machine fed one sample at a time.
 *
 * A sample is hot when the OS reports any thermal pressure or the CPU is at
 * or above the threshold. `openAfter` consecutive hot samples open an
 * episode that starts at the first of them; `closeAfter` consecutive normal
 * samples close it at the last hot one. Culprits are ranked by CPU summed
 * over the episode's hot samples, so a thread that burned hard for the whole
 * episode outranks one that spiked once.
 */
import type { Sample } from "./sample";

export interface Culprit {
  threadId: string;
  title: string | null;
  /** Sum of the thread's CPU % over the hot samples it appeared in. */
  cpuSum: number;
  /** Hot samples in which the thread was in the top five. */
  samples: number;
  peakCpu: number;
}

export interface OtherCulprit {
  name: string;
  cpuSum: number;
  samples: number;
}

export interface Episode {
  /** Row id once stored; null while it only exists in memory. */
  id: number | null;
  startAt: number;
  /** Null while the episode is open. */
  endAt: number | null;
  lastHotAt: number;
  peakThermal: number | null;
  peakCpu: number;
  /** Hot samples counted into the episode. */
  samples: number;
  culprits: Culprit[];
  others: OtherCulprit[];
}

export interface DetectorConfig {
  cpuThreshold: number;
  openAfter: number;
  closeAfter: number;
  /**
   * A gap between samples longer than this (the server slept or the plugin
   * was off) closes an open episode at its last hot sample and resets the
   * streak, so hours of silence never merge into one episode.
   */
  maxGapMs: number;
}

export interface DetectorState {
  /** Hot samples seen so far that have not yet opened an episode. */
  streak: Episode | null;
  open: Episode | null;
  normalStreak: number;
  lastAt: number | null;
}

export interface StepResult {
  state: DetectorState;
  opened: Episode | null;
  /** The open episode after this sample changed it (including on open). */
  updated: Episode | null;
  closed: Episode | null;
}

export const MAX_CULPRITS = 50;

export function initialState(): DetectorState {
  return { streak: null, open: null, normalStreak: 0, lastAt: null };
}

export function isHot(sample: Pick<Sample, "thermal" | "cpu">, cpuThreshold: number): boolean {
  return (sample.thermal ?? 0) >= 1 || sample.cpu >= cpuThreshold;
}

function emptyEpisode(at: number): Episode {
  return {
    id: null,
    startAt: at,
    endAt: null,
    lastHotAt: at,
    peakThermal: null,
    peakCpu: 0,
    samples: 0,
    culprits: [],
    others: [],
  };
}

const round = (value: number) => Math.round(value * 10) / 10;

/** Fold one hot sample into an episode. Returns a new object. */
export function absorb(episode: Episode, sample: Sample): Episode {
  const culprits = new Map(episode.culprits.map((entry) => [entry.threadId, { ...entry }]));
  for (const thread of sample.threads) {
    const entry = culprits.get(thread.threadId) ?? {
      threadId: thread.threadId,
      title: null,
      cpuSum: 0,
      samples: 0,
      peakCpu: 0,
    };
    entry.cpuSum = round(entry.cpuSum + thread.cpu);
    entry.samples += 1;
    entry.peakCpu = Math.max(entry.peakCpu, thread.cpu);
    entry.title = thread.title ?? entry.title;
    culprits.set(thread.threadId, entry);
  }
  const others = new Map(episode.others.map((entry) => [entry.name, { ...entry }]));
  for (const proc of sample.procs) {
    const entry = others.get(proc.name) ?? { name: proc.name, cpuSum: 0, samples: 0 };
    entry.cpuSum = round(entry.cpuSum + proc.cpu);
    entry.samples += 1;
    others.set(proc.name, entry);
  }
  const peakThermal =
    sample.thermal === null
      ? episode.peakThermal
      : Math.max(episode.peakThermal ?? 0, sample.thermal);
  return {
    ...episode,
    lastHotAt: sample.at,
    peakThermal,
    peakCpu: Math.max(episode.peakCpu, sample.cpu),
    samples: episode.samples + 1,
    culprits: [...culprits.values()]
      .sort((a, b) => b.cpuSum - a.cpuSum)
      .slice(0, MAX_CULPRITS),
    others: [...others.values()].sort((a, b) => b.cpuSum - a.cpuSum).slice(0, MAX_CULPRITS),
  };
}

export function step(state: DetectorState, sample: Sample, config: DetectorConfig): StepResult {
  let { streak, open, normalStreak } = state;
  let opened: Episode | null = null;
  let updated: Episode | null = null;
  let closed: Episode | null = null;

  if (state.lastAt !== null && sample.at - state.lastAt > config.maxGapMs) {
    if (open !== null) closed = { ...open, endAt: open.lastHotAt };
    open = null;
    streak = null;
    normalStreak = 0;
  }

  const hot = isHot(sample, config.cpuThreshold);
  if (open !== null) {
    if (hot) {
      open = absorb(open, sample);
      normalStreak = 0;
      updated = open;
    } else {
      normalStreak += 1;
      if (normalStreak >= config.closeAfter) {
        closed = { ...open, endAt: open.lastHotAt };
        open = null;
        normalStreak = 0;
      }
    }
  } else if (hot) {
    streak = absorb(streak ?? emptyEpisode(sample.at), sample);
    if (streak.samples >= config.openAfter) {
      open = streak;
      streak = null;
      opened = open;
      updated = open;
    }
  } else {
    streak = null;
  }

  return {
    state: { streak, open, normalStreak, lastAt: sample.at },
    opened,
    updated,
    closed,
  };
}
