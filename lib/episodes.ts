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
import {
  type CulpritProcess,
  type DetectorState,
  type Episode,
  type Sample,
  type ThreadProcess,
  detectorStateSchema,
} from "./schemas";

export type { Culprit, DetectorState, Episode, OtherCulprit } from "./schemas";

export interface DetectorConfig {
  cpuThreshold: number;
  openAfter: number;
  closeAfter: number;
  /** The sample interval in force for this sample. */
  intervalMs: number;
  /**
   * A gap between samples longer than this many intervals (the server slept
   * or the plugin was off) closes an open episode at its last hot sample
   * and resets the streak, so hours of silence never merge into one episode.
   */
  gapIntervals: number;
}

/**
 * The longest silence that still counts as consecutive. It uses the larger
 * of the interval stored with the last sample and the current one, so
 * changing the interval setting in either direction never ends an episode.
 */
export function maxGapMs(state: DetectorState, config: DetectorConfig): number {
  return config.gapIntervals * Math.max(state.lastIntervalMs ?? config.intervalMs, config.intervalMs);
}

export interface StepResult {
  state: DetectorState;
  opened: Episode | null;
  /** The open episode after this sample changed it (including on open). */
  updated: Episode | null;
  closed: Episode | null;
}

export const MAX_CULPRITS = 50;
/** Process names kept per culprit while an episode is open, and once it closes. */
export const OPEN_CULPRIT_PROCS = 20;
export const CULPRIT_PROCS = 3;

export function initialState(): DetectorState {
  return { streak: null, open: null, normalStreak: 0, lastAt: null, lastIntervalMs: null };
}

/**
 * Detector state read back from storage. Anything that does not parse, such
 * as state written by an older build, starts the detector over.
 */
export function restoreState(stored: unknown): DetectorState {
  const parsed = detectorStateSchema.safeParse(stored);
  return parsed.success ? parsed.data : initialState();
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

/**
 * A culprit's processes after one more sample, by name: two `node · vite`
 * pids in one sample add up. Capped while open; finish() trims further.
 */
function absorbProcs(procs: CulpritProcess[], top: readonly ThreadProcess[]): CulpritProcess[] {
  const byName = new Map(procs.map((entry) => [entry.name, { ...entry }]));
  const inSample = new Map<string, number>();
  for (const proc of top) inSample.set(proc.name, (inSample.get(proc.name) ?? 0) + proc.cpu);
  for (const [name, cpu] of inSample) {
    const entry = byName.get(name) ?? { name, cpuSum: 0, samples: 0, peakCpu: 0 };
    entry.cpuSum = round(entry.cpuSum + cpu);
    entry.samples += 1;
    entry.peakCpu = Math.max(entry.peakCpu, round(cpu));
    byName.set(name, entry);
  }
  return [...byName.values()].sort((a, b) => b.cpuSum - a.cpuSum).slice(0, OPEN_CULPRIT_PROCS);
}

/** Fold one hot sample into an episode. Returns a new object. */
export function absorb(episode: Episode, sample: Sample): Episode {
  const culprits = new Map(episode.culprits.map((entry) => [entry.threadId, { ...entry }]));
  for (const thread of sample.threads) {
    const entry = culprits.get(thread.threadId) ?? {
      threadId: thread.threadId,
      cpuSum: 0,
      samples: 0,
      peakCpu: 0,
      procs: null,
    };
    entry.cpuSum = round(entry.cpuSum + thread.cpu);
    entry.samples += 1;
    entry.peakCpu = Math.max(entry.peakCpu, thread.cpu);
    if (thread.top !== null && thread.top !== undefined) entry.procs = absorbProcs(entry.procs ?? [], thread.top);
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
    // Kept whole while open: trimming here would throw away a late-rising
    // thread's CPU each time it fell below the cut. finish() trims once.
    culprits: [...culprits.values()].sort((a, b) => b.cpuSum - a.cpuSum),
    others: [...others.values()].sort((a, b) => b.cpuSum - a.cpuSum),
  };
}

/** Close an episode at its last hot sample and keep its top culprits. */
export function finish(episode: Episode): Episode {
  return {
    ...episode,
    endAt: episode.lastHotAt,
    culprits: episode.culprits
      .slice(0, MAX_CULPRITS)
      .map((culprit) => ({ ...culprit, procs: culprit.procs?.slice(0, CULPRIT_PROCS) ?? null })),
    others: episode.others.slice(0, MAX_CULPRITS),
  };
}

export function step(state: DetectorState, sample: Sample, config: DetectorConfig): StepResult {
  let { streak, open, normalStreak } = state;
  let opened: Episode | null = null;
  let updated: Episode | null = null;
  let closed: Episode | null = null;

  if (state.lastAt !== null && sample.at - state.lastAt > maxGapMs(state, config)) {
    if (open !== null) closed = finish(open);
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
        closed = finish(open);
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
    state: { streak, open, normalStreak, lastAt: sample.at, lastIntervalMs: config.intervalMs },
    opened,
    updated,
    closed,
  };
}
