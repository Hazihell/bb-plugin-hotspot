// bb-plugin-hotspot — records when the Mac runs hot and which BB thread
// caused it.
//
// A background service samples heat, CPU and the busiest threads on a timer
// and stores every sample in the plugin's SQLite database. Each sample also
// feeds the episode detector (lib/episodes.ts), which opens, extends and
// closes stored hot episodes and ranks their culprit threads. The sampler reads
// the server's own machine: `ps`, `notifyutil` and `os`, never a remote host.
// Monitoring is read-only; nothing here signals, renices or kills a process.
import { PluginCliError, cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { type Range, rpcContract } from "./lib/contract";
import { type DetectorState, type Episode, restoreState, step } from "./lib/episodes";
import {
  bucketSamples,
  clampText,
  describeEpisode,
  describeSample,
  describeWindow,
  formatWhen,
  parseWhen,
  summarizeWindow,
} from "./lib/report";
import { EPISODE_OPENED, type EpisodeOpenedSignal, SAMPLED } from "./lib/signals";
import { createSampler } from "./lib/sample";
import { DAY_MS, MIGRATIONS, createStore } from "./lib/store";

const TITLE_TTL_MS = 10 * 60_000;
/** Consecutive hot samples that open an episode, and normal ones that close it. */
const OPEN_AFTER = 3;
const CLOSE_AFTER = 3;
const DETECTOR_KEY = "detector";
/** Window and bucket count per timeline range: 5-minute and 30-minute buckets. */
const RANGE_SPECS: Record<Range, { spanMs: number; buckets: number }> = {
  "24h": { spanMs: DAY_MS, buckets: 288 },
  "7d": { spanMs: 7 * DAY_MS, buckets: 336 },
};
const TIMELINE_EPISODE_LIMIT = 200;
/** Output ceilings for the agent tool and the CLI (characters). */
const TOOL_MAX_CHARS = 8_000;
const CLI_MAX_CHARS = 32_000;
const WHEN_HELP =
  "`90m`, `3h`, `2d`, `1w` back from now; `15:00` for the most recent 15:00 (server-local); or an ISO date/time";

/** True only for BB's definite "no such thread" answer (HTTP 404, thread_not_found). */
function isNotFound(error: unknown): boolean {
  const fields = (error ?? {}) as { status?: unknown; code?: unknown };
  if (fields.status === 404 || fields.code === "thread_not_found") return true;
  return /\b404\b|thread_not_found|thread not found/i.test(String(error));
}

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
    toast: {
      type: "boolean",
      label: "Show a toast when an episode starts",
      default: true,
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = createStore(db);

  // Thread titles change rarely and the same few threads recur every
  // sample, so each id is looked up at most once per TTL. Only answers are
  // cached (found, or definitely not found); a failed request is retried
  // on the next sample and meanwhile keeps the id without a title.
  const threadCache = new Map<string, { exists: boolean; title: string | null; at: number }>();
  async function resolveThreads(threadIds: string[]): Promise<Map<string, string | null>> {
    const now = Date.now();
    if (threadCache.size > 1_000) threadCache.clear();
    const failed = new Set<string>();
    await Promise.all(
      threadIds.map(async (threadId) => {
        const cached = threadCache.get(threadId);
        if (cached !== undefined && now - cached.at < TITLE_TTL_MS) return;
        try {
          const thread = await bb.sdk.threads.get({ threadId });
          const title = thread.title ?? thread.titleFallback ?? null;
          threadCache.set(threadId, { exists: true, title, at: now });
        } catch (error) {
          if (isNotFound(error)) threadCache.set(threadId, { exists: false, title: null, at: now });
          else failed.add(threadId);
        }
      }),
    );
    const resolved = new Map<string, string | null>();
    for (const threadId of threadIds) {
      const entry = failed.has(threadId) ? undefined : threadCache.get(threadId);
      if (entry?.exists !== false) resolved.set(threadId, entry?.title ?? null);
    }
    return resolved;
  }

  let processErrorLogged = false;
  const takeSample = createSampler(resolveThreads, {
    // Logged once per load: a missing `ps` fails every sample the same way.
    onProcessError(error) {
      if (processErrorLogged) return;
      processErrorLogged = true;
      bb.log.warn(`ps failed; recording CPU without threads: ${error instanceof Error ? error.message : String(error)}`);
    },
  });

  // The detector's streak survives reloads in KV; the episodes themselves
  // live in SQLite, and the open one is rewritten there after every sample.
  let detector: DetectorState = restoreState(await bb.storage.kv.get<unknown>(DETECTOR_KEY));

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
      if (result.opened !== null) await announce(open);
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

  // The server has no toast API, so it publishes the opening and every open
  // app window raises the toast itself (app.tsx, HotspotToaster).
  async function announce(episode: Episode): Promise<void> {
    const top = episode.culprits[0] ?? null;
    bb.log.info(
      `episode ${episode.id} opened; top thread ${top === null ? "none" : top.threadId}`,
    );
    if (episode.id === null || !(await settings.get()).toast) return;
    const signal: EpisodeOpenedSignal = {
      id: episode.id,
      startAt: episode.startAt,
      peakThermal: episode.peakThermal,
      peakCpu: episode.peakCpu,
      top: top === null ? null : { threadId: top.threadId, title: top.title },
    };
    bb.realtime.publish(EPISODE_OPENED, signal);
  }

  bb.rpc.register(rpcContract, {
    async status() {
      const { cpuThreshold, sampleIntervalSeconds } = await settings.get();
      return {
        latest: store.latest(),
        open: detector.open,
        cpuThreshold,
        sampleIntervalSeconds,
      };
    },
    timeline({ range }) {
      const { spanMs, buckets } = RANGE_SPECS[range];
      const to = Date.now();
      const from = to - spanMs;
      const { bucketMs, points } = bucketSamples(store.samples(from, to), from, to, buckets);
      return {
        from,
        to,
        bucketMs,
        points,
        episodes: store.episodes(from, to, TIMELINE_EPISODE_LIMIT),
      };
    },
  });

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

  /** Episodes overlapping [from, to] plus, optionally, what the window looked like. */
  function historyText(options: {
    from: number;
    to: number;
    limit: number;
    culprits: number;
    summary: boolean;
  }): string {
    const { from, to, limit, culprits, summary } = options;
    const lines = [`Hotspot history ${formatWhen(from)} → ${formatWhen(to)} (server-local time)`];
    if (summary) {
      lines.push("", "Window:", ...describeWindow(summarizeWindow(store.samples(from, to), 5)));
    }
    const episodes = store.episodes(from, to, limit);
    lines.push("", episodes.length === 0 ? "No hot episodes in this window." : `Hot episodes, newest first (max ${limit}):`);
    for (const episode of episodes) lines.push(...describeEpisode(episode, culprits));
    return lines.join("\n");
  }

  function resolveWindow(since: string, until: string | undefined, now: number) {
    const from = parseWhen(since, now);
    const to = until === undefined ? now : parseWhen(until, now);
    if (from === null) return { error: `Cannot read time "${since}". Use ${WHEN_HELP}.` };
    if (to === null) return { error: `Cannot read time "${until}". Use ${WHEN_HELP}.` };
    if (from >= to) return { error: `"since" (${formatWhen(from)}) must be before "until" (${formatWhen(to)}).` };
    return { from, to };
  }

  bb.agents.registerTool({
    name: "hotspot_history",
    description:
      "Why was the Mac hot, and which BB thread caused it? Returns recorded hot episodes " +
      "(thermal pressure above nominal or sustained high CPU) overlapping a time window, each " +
      "with its culprit threads ranked by CPU, plus a summary of CPU, thermal level and the " +
      "busiest threads across the whole window. Read-only; output is bounded.",
    instructions:
      "When the user asks why their Mac was hot, loud or slow at some time, call hotspot_history " +
      "with a window around that time (e.g. since \"15:00\", until \"16:00\") before guessing.",
    presentation: {
      label: { pending: "Reading Hotspot history", completed: "Read Hotspot history" },
    },
    parameters: z.object({
      since: z.string().max(40).default("24h").describe(`Window start: ${WHEN_HELP}. Default 24h.`),
      until: z.string().max(40).optional().describe(`Window end, same forms as since. Default now.`),
      limit: z.number().int().min(1).max(20).default(5).describe("Most episodes to list (1–20)."),
    }),
    async execute({ since, until, limit }) {
      const window = resolveWindow(since, until, Date.now());
      if ("error" in window) {
        return { content: [{ type: "text", text: window.error ?? "" }], isError: true };
      }
      const text = historyText({ ...window, limit, culprits: 5, summary: true });
      return clampText(text, TOOL_MAX_CHARS);
    },
  });

  bb.cli.register(
    defineCli({
      name: "hotspot",
      summary: "When the Mac ran hot and which BB thread caused it",
      commands: {
        status: cliCommand({
          summary: "Latest sample: thermal level, CPU, load, busiest threads and processes",
          options: { json: { type: "boolean", description: "Emit JSON" } },
          async run(input) {
            const latest = store.latest();
            const open = detector.open;
            if (input.options.json) {
              const trimmed =
                open === null
                  ? null
                  : { ...open, culprits: open.culprits.slice(0, 5), others: open.others.slice(0, 5) };
              return { exitCode: 0, stdout: JSON.stringify({ latest, open: trimmed }) };
            }
            if (latest === null) {
              return { exitCode: 0, stdout: "No samples yet. The first arrives within one interval of loading." };
            }
            const lines = describeSample(latest);
            lines.push("", open === null ? "Not in a hot episode." : "Hot episode in progress:");
            if (open !== null) lines.push(...describeEpisode(open, 5));
            return { exitCode: 0, stdout: clampText(lines.join("\n"), CLI_MAX_CHARS) };
          },
        }),
        episodes: cliCommand({
          summary: "Hot episodes with their culprit threads, newest first",
          options: {
            since: {
              type: "string",
              default: "24h",
              description: `Window start: ${WHEN_HELP}`,
              aliases: ["from"],
            },
            until: { type: "string", description: "Window end, same forms as --since (default now)", aliases: ["to"] },
            limit: { type: "integer", min: 1, max: 50, default: 10, description: "Most episodes to list (1–50)" },
            json: { type: "boolean", description: "Emit JSON (top 5 culprits per episode)" },
          },
          async run(input) {
            const { since, until, limit, json } = input.options;
            const window = resolveWindow(since, until, Date.now());
            if ("error" in window) {
              throw new PluginCliError(window.error ?? "invalid window", {
                code: "invalid_time",
                hint: "Try `bb hotspot episodes --since 24h` or `--since 15:00 --until 16:00`.",
              });
            }
            if (json) {
              const episodes = store.episodes(window.from, window.to, limit).map((episode) => ({
                ...episode,
                culprits: episode.culprits.slice(0, 5),
                others: episode.others.slice(0, 5),
              }));
              return { exitCode: 0, stdout: JSON.stringify({ ...window, episodes }) };
            }
            const text = historyText({ ...window, limit, culprits: 3, summary: false });
            return { exitCode: 0, stdout: clampText(text, CLI_MAX_CHARS) };
          },
        }),
      },
    }),
  );

  async function prune(): Promise<void> {
    const { retentionDays } = await settings.get();
    const removed = store.prune(Date.now(), retentionDays);
    if (removed.samples + removed.episodes > 0) {
      bb.log.info(`pruned ${removed.samples} samples and ${removed.episodes} episodes`);
    }
  }
  bb.background.schedule("prune", "17 * * * *", prune);
}
