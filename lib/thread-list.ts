/**
 * The popover's thread list, held steady while live readings arrive every
 * couple of seconds. Pure and free of React, so tests pin every rule.
 *
 * The server ranks each reading by CPU and drops threads it did not see
 * busy; drawn as-is, rows swap, fold and vanish tick to tick. This keeps its
 * own shown order and folded set across readings and changes them only
 * when a change is worth a row moving:
 * - rows swap only when their CPU differs by more than `SWAP_MARGIN`, and
 *   at most once every `RERANK_MS`;
 * - a shown thread folds only after reading idle for `FOLD_AFTER_MS`; a
 *   folded one comes back at once over `SHOW_NOW_CPU`, or after reading busy
 *   for `SHOW_AFTER_MS`;
 * - a thread missing from a reading keeps its row for `LINGER_MS`, marked
 *   as missing;
 * - while `frozen` (the pointer or focus is in the list, or a row is
 *   unfolded) nothing is added, removed, folded or reordered: numbers update
 *   in place and every change waits for the list to be let go.
 */
import { IDLE_MEM_BYTES } from "./present";

export interface ListThread {
  threadId: string;
  cpu: number;
  memBytes?: number | null;
}

/** Adjacent rows swap only when the lower one leads by more than this many CPU points. */
export const SWAP_MARGIN = 5;
/** At most one reordering per this long. */
export const RERANK_MS = 6_000;
/** A shown thread folds once it has read idle for this long. */
export const FOLD_AFTER_MS = 15_000;
/** A folded thread comes back once it has read busy for this long… */
export const SHOW_AFTER_MS = 6_000;
/** …or at once when it reads at least this much CPU. */
export const SHOW_NOW_CPU = 5;
/** A thread missing from the readings keeps its row this long. */
export const LINGER_MS = 10_000;

interface Tracked<T> {
  /** The last reading of it. */
  entry: T;
  /** When it was last in a reading. */
  seenAt: number;
  /** Since when it has read idle (or been missing); null while busy. */
  idleSince: number | null;
  /** Since when it has read busy; null while idle or missing. */
  busySince: number | null;
}

export interface ListState<T extends ListThread> {
  /** Shown threads, top first. */
  shown: string[];
  /** Folded threads, in the order they folded. */
  folded: string[];
  tracked: Record<string, Tracked<T>>;
  /** When the shown order last changed by reranking. */
  rankedAt: number;
  /** When the latest reading arrived. */
  readAt: number;
}

export interface ListRow<T extends ListThread> {
  thread: T;
  /** False when the latest reading did not include this thread: its numbers are the last ones seen. */
  present: boolean;
}

/** The popover's idle line: under 1% CPU as shown (`<1%`) and under `IDLE_MEM_BYTES`; unknown memory counts as small. */
export function readsIdle(thread: ListThread): boolean {
  return thread.cpu < 0.5 && (thread.memBytes ?? 0) < IDLE_MEM_BYTES;
}

export function emptyList<T extends ListThread>(): ListState<T> {
  return { shown: [], folded: [], tracked: {}, rankedAt: Number.NEGATIVE_INFINITY, readAt: Number.NEGATIVE_INFINITY };
}

/** Where a newcomer goes: below every shown row with at least its CPU. */
function insertByCpu(order: string[], id: string, cpu: (id: string) => number): string[] {
  const at = order.findIndex((other) => cpu(other) < cpu(id));
  return at === -1 ? [...order, id] : [...order.slice(0, at), id, ...order.slice(at)];
}

/**
 * Swaps neighbours whose CPU differs by more than the margin until none
 * does. "Leads by more than the margin" is transitive, so every swap undoes
 * one such inversion and the passes end.
 */
function rerank(order: string[], cpu: (id: string) => number): string[] {
  const next = [...order];
  for (let swapped = true; swapped; ) {
    swapped = false;
    for (let index = 0; index + 1 < next.length; index++) {
      if (cpu(next[index + 1]) > cpu(next[index]) + SWAP_MARGIN) {
        [next[index], next[index + 1]] = [next[index + 1], next[index]];
        swapped = true;
      }
    }
  }
  return next;
}

/**
 * The list after one reading. `now` is a monotonic clock in ms. The first
 * reading into an empty state places every thread as the plain rules say:
 * idle ones folded, the rest by CPU.
 */
export function nextList<T extends ListThread>(
  state: ListState<T>,
  threads: readonly T[],
  now: number,
  frozen: boolean,
): ListState<T> {
  const tracked: Record<string, Tracked<T>> = {};
  const inReading = new Set<string>();
  for (const entry of threads) {
    inReading.add(entry.threadId);
    const before = state.tracked[entry.threadId];
    const idle = readsIdle(entry);
    tracked[entry.threadId] = {
      entry,
      seenAt: now,
      idleSince: idle ? (before?.idleSince ?? now) : null,
      busySince: idle ? null : (before?.busySince ?? now),
    };
  }
  // Missing threads count as idle from the moment they went missing.
  for (const [threadId, before] of Object.entries(state.tracked)) {
    if (inReading.has(threadId)) continue;
    tracked[threadId] = { ...before, idleSince: before.idleSince ?? now, busySince: null };
  }
  // CPU as ranked: a missing thread's is unknown, so it ranks as none.
  const cpu = (threadId: string) => (inReading.has(threadId) ? tracked[threadId].entry.cpu : 0);

  if (frozen) {
    // Only threads already on screen are kept; newcomers wait to be read again.
    const kept: Record<string, Tracked<T>> = {};
    for (const threadId of [...state.shown, ...state.folded]) kept[threadId] = tracked[threadId];
    return { ...state, tracked: kept, readAt: now };
  }

  const gone = (threadId: string) => now - tracked[threadId].seenAt >= LINGER_MS;
  const shouldFold = (threadId: string) => {
    const idleSince = tracked[threadId].idleSince;
    return idleSince !== null && now - idleSince >= FOLD_AFTER_MS;
  };
  const shouldShow = (threadId: string) => {
    if (!inReading.has(threadId)) return false;
    const { entry, busySince } = tracked[threadId];
    return entry.cpu >= SHOW_NOW_CPU || (busySince !== null && now - busySince >= SHOW_AFTER_MS);
  };

  let shown = state.shown.filter((threadId) => !gone(threadId));
  let folded = state.folded.filter((threadId) => !gone(threadId));
  for (const threadId of Object.keys(tracked)) if (gone(threadId)) delete tracked[threadId];

  const folding = shown.filter(shouldFold);
  const showing = folded.filter(shouldShow);
  shown = shown.filter((threadId) => !folding.includes(threadId));
  folded = [...folded.filter((threadId) => !showing.includes(threadId)), ...folding];

  const known = new Set([...state.shown, ...state.folded]);
  const newcomers = threads.map((entry) => entry.threadId).filter((threadId) => !known.has(threadId));
  // Newcomers and threads coming back take their place by CPU; idle newcomers fold at once.
  for (const threadId of [...showing, ...newcomers]) {
    if (newcomers.includes(threadId) && readsIdle(tracked[threadId].entry)) folded.push(threadId);
    else shown = insertByCpu(shown, threadId, cpu);
  }

  let rankedAt = state.rankedAt;
  if (now - rankedAt >= RERANK_MS) {
    const reranked = rerank(shown, cpu);
    if (reranked.some((threadId, index) => threadId !== shown[index])) {
      shown = reranked;
      rankedAt = now;
    }
  }
  return { shown, folded, tracked, rankedAt, readAt: now };
}

/** The rows to draw: shown threads in order, and the folded ones. */
export function listRows<T extends ListThread>(state: ListState<T>): { shown: ListRow<T>[]; folded: ListRow<T>[] } {
  const row = (threadId: string): ListRow<T> => ({
    thread: state.tracked[threadId].entry,
    present: state.tracked[threadId].seenAt === state.readAt,
  });
  return { shown: state.shown.map(row), folded: state.folded.map(row) };
}
