// bb-plugin-hotspot — records when the Mac runs hot and which BB thread
// caused it.
//
// A background service samples heat, CPU and the busiest threads on a timer
// and stores every sample in the plugin's SQLite database. Each sample also
// feeds the episode detector (lib/episodes.ts), which opens, extends and
// closes stored hot episodes and ranks their culprit threads. The sampler reads
// the server's own machine: `ps`, `notifyutil` and `os`, never a remote host.
// Monitoring is read-only; nothing here signals, renices or kills a process.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { type DetectorState, type Episode, initialState, step } from "./lib/episodes";
import { createSampler } from "./lib/sample";
import { MIGRATIONS, createStore } from "./lib/store";

const TITLE_TTL_MS = 10 * 60_000;
/** Consecutive hot samples that open an episode, and normal ones that close it. */
const OPEN_AFTER = 3;
const CLOSE_AFTER = 3;
const DETECTOR_KEY = "detector";

/** Realtime channels the app bundle listens on. */
export const SAMPLED = "sampled";
export const EPISODE_OPENED = "episode-opened";

/** Resolves when `ms` elapses or `signal` aborts, whichever comes first. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    sampleIntervalSeconds: {
      type: "number",
      label: "Sample interval (seconds)",
      experimental_schema: z.number().int().min(15).max(3600),
      default: 60,
    },
    retentionDays: {
      type: "number",
      label: "Keep history for (days)",
      experimental_schema: z.number().int().min(1).max(30),
      default: 7,
    },
    cpuThreshold: {
      type: "number",
      label: "CPU threshold (% of all cores)",
      experimental_schema: z.number().min(10).max(100),
      default: 80,
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = createStore(db);

  // Thread titles change rarely and the same few threads recur every
  // sample, so each id is looked up at most once per TTL.
  const titles = new Map<string, { title: string | null; at: number }>();
  async function resolveTitles(threadIds: string[]): Promise<Map<string, string>> {
    const now = Date.now();
    await Promise.all(
      threadIds.map(async (threadId) => {
        const cached = titles.get(threadId);
        if (cached !== undefined && now - cached.at < TITLE_TTL_MS) return;
        const thread = await bb.sdk.threads.get({ threadId }).catch(() => null);
        titles.set(threadId, { title: thread?.title ?? null, at: now });
      }),
    );
    const resolved = new Map<string, string>();
    for (const threadId of threadIds) {
      const title = titles.get(threadId)?.title;
      if (title) resolved.set(threadId, title);
    }
    return resolved;
  }

  const takeSample = createSampler(resolveTitles);

  // The detector's streak survives reloads in KV; the episodes themselves
  // live in SQLite, and the open one is rewritten there after every sample.
  let detector: DetectorState =
    (await bb.storage.kv.get<DetectorState>(DETECTOR_KEY)) ?? initialState();

  async function record(at: number): Promise<void> {
    const { sampleIntervalSeconds, cpuThreshold } = await settings.get();
    const sample = await takeSample(at);
    store.addSample(sample);
    const result = step(detector, sample, {
      cpuThreshold,
      openAfter: OPEN_AFTER,
      closeAfter: CLOSE_AFTER,
      maxGapMs: sampleIntervalSeconds * 1_000 * 3,
    });
    let open = result.state.open;
    if (result.closed !== null) {
      const closed = store.saveEpisode(result.closed);
      bb.log.info(`episode ${closed.id} closed after ${closed.samples} hot samples`);
    }
    if (result.updated !== null) {
      open = store.saveEpisode(result.updated);
      if (result.opened !== null) announce(open);
    }
    detector = { ...result.state, open };
    await bb.storage.kv.set(DETECTOR_KEY, detector);
    bb.realtime.publish(SAMPLED, {
      at: sample.at,
      thermal: sample.thermal,
      cpu: sample.cpu,
      hot: open !== null,
    });
  }

  function announce(episode: Episode): void {
    const top = episode.culprits[0] ?? null;
    bb.log.info(
      `episode ${episode.id} opened; top thread ${top === null ? "none" : top.threadId}`,
    );
  }

  bb.background.service("sampler", {
    async start(signal) {
      while (!signal.aborted) {
        const started = Date.now();
        const { sampleIntervalSeconds } = await settings.get();
        try {
          await record(started);
        } catch (error) {
          bb.log.warn(`sample failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        await sleep(Math.max(1_000, sampleIntervalSeconds * 1_000 - (Date.now() - started)), signal);
      }
    },
  });

  async function prune(): Promise<void> {
    const { retentionDays } = await settings.get();
    const removed = store.prune(Date.now(), retentionDays);
    if (removed.samples + removed.episodes > 0) {
      bb.log.info(`pruned ${removed.samples} samples and ${removed.episodes} episodes`);
    }
  }
  bb.background.schedule("prune", "17 * * * *", prune);
}
