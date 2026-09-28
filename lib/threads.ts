/**
 * Thread names, looked up when something is shown rather than when it is
 * recorded.
 *
 * Samples and episodes store only thread ids and CPU. Every surface that
 * shows a thread (the page, the toast, the CLI and the agent tool) goes
 * through one directory, so a title that changed, or an id that turned out
 * to name no thread, reads the same everywhere and needs no stored rewrite.
 */
import type { Episode, EpisodeView, Sample, SampleView } from "./schemas";

/** What a lookup learned: the thread's title, or null when BB has no such thread. Throws on failure. */
export type ThreadLookup = (threadId: string) => Promise<{ title: string | null } | null>;

/**
 * Titles for the ids BB knows. An id absent from the map is not a thread
 * and must not be shown; a null value means the lookup failed and the id is
 * shown bare.
 */
export type KnownThreads = Map<string, string | null>;

/** True only for BB's definite "no such thread" answer (HTTP 404, thread_not_found). */
export function isNotFound(error: unknown): boolean {
  const fields = (error ?? {}) as { status?: unknown; code?: unknown };
  if (fields.status === 404 || fields.code === "thread_not_found") return true;
  return /\b404\b|thread_not_found|thread not found/i.test(String(error));
}

export function createThreadDirectory(
  lookup: ThreadLookup,
  options: { ttlMs: number; maxEntries?: number; now?: () => number },
) {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 1_000;
  // Only answers are cached (found, or definitely not found). A failed
  // request is retried on the next read and meanwhile keeps the id untitled.
  const cache = new Map<string, { exists: boolean; title: string | null; at: number }>();

  return {
    async resolve(threadIds: Iterable<string>): Promise<KnownThreads> {
      const ids = [...new Set(threadIds)];
      const at = now();
      if (cache.size > maxEntries) cache.clear();
      const failed = new Set<string>();
      await Promise.all(
        ids.map(async (threadId) => {
          const cached = cache.get(threadId);
          if (cached !== undefined && at - cached.at < options.ttlMs) return;
          try {
            const found = await lookup(threadId);
            cache.set(threadId, { exists: found !== null, title: found?.title ?? null, at });
          } catch {
            failed.add(threadId);
          }
        }),
      );
      const known: KnownThreads = new Map();
      for (const threadId of ids) {
        const entry = failed.has(threadId) ? undefined : cache.get(threadId);
        if (entry?.exists !== false) known.set(threadId, entry?.title ?? null);
      }
      return known;
    },
  };
}

export type ThreadDirectory = ReturnType<typeof createThreadDirectory>;

/** Keep the entries that name real threads, attach their titles, and cut to `limit`. */
export function named<T extends { threadId: string }>(
  entries: readonly T[],
  known: KnownThreads,
  limit: number,
): Array<T & { title: string | null }> {
  return entries
    .filter((entry) => known.has(entry.threadId))
    .slice(0, limit)
    .map((entry) => ({ ...entry, title: known.get(entry.threadId) ?? null }));
}

/** Ids worth looking up for display: a few past `limit`, so drops do not shorten a list. */
export function idsToResolve(entries: readonly { threadId: string }[], limit: number): string[] {
  return entries.slice(0, limit + 5).map((entry) => entry.threadId);
}

export function viewSample(sample: Sample, known: KnownThreads, limit: number): SampleView {
  return { ...sample, threads: named(sample.threads, known, limit) };
}

export function viewEpisode(episode: Episode, known: KnownThreads, limit: number): EpisodeView {
  return { ...episode, culprits: named(episode.culprits, known, limit) };
}
