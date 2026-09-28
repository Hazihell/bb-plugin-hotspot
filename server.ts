// bb-plugin-hotspot — records when the Mac runs hot and which BB thread
// caused it.
//
// A background service samples heat, CPU, memory and the busiest threads on a timer
// and stores every sample in the plugin's SQLite database. Each sample also
// feeds the episode detector (lib/episodes.ts), which opens, extends and
// closes stored hot episodes and ranks their culprit threads. While a BB
// window is visible and holds the watch lease, the same service also takes a
// live reading every couple of seconds and pushes it to the footer and page;
// live readings are never stored and never reach the detector. The sampler reads
// the server's own machine: `ps`, `notifyutil`, `vm_stat`, `sysctl` and `os`,
// never a remote host.
// Sampling only reads. The one thing that signals a process is the user's own
// "kill this thread's processes" (lib/kill.ts), from the footer popover or
// `bb hotspot kill`; it is never offered to agents, and neither is stopping a
// thread's turn.
import { randomUUID } from "node:crypto";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { PluginCliError, cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  type KillPlanView,
  type KillResultView,
  type Range,
  RECENT_BUCKETS,
  RECENT_MS,
  rpcContract,
  threadIdSchema,
} from "./lib/contract";
import { type KillPlan, type KillRow, type PlanContext, type Signal, applyKill, checkInteractiveCaller, planKill, readKillRows } from "./lib/kill";
import { systemProcessSource } from "./lib/procs";
import { type DetectorState, type Episode, restoreState, step } from "./lib/episodes";
import {
  bucketSamples,
  clampText,
  describeEpisode,
  describeKillPlan,
  describeKillResult,
  describeSample,
  describeWindow,
  formatWhen,
  parseWhen,
  summarizeWindow,
} from "./lib/report";
import { EPISODE_OPENED, type EpisodeOpenedSignal, LIVE, type LiveSignal, SAMPLED } from "./lib/signals";
import { TOP_THREADS, type TakeReading, createSampler, startupDelay } from "./lib/sample";
import type { EpisodeView, Sample, SampleView } from "./lib/schemas";
import {
  createThreadDirectory,
  idsToResolve,
  isNotFound,
  named,
  viewEpisode,
  viewSample,
} from "./lib/threads";
import { DAY_MS, MIGRATIONS, createStore } from "./lib/store";

const TITLE_TTL_MS = 10 * 60_000;
/** Consecutive hot samples that open an episode, and normal ones that close it. */
const OPEN_AFTER = 3;
const CLOSE_AFTER = 3;
/** Missed intervals after which the next sample starts over. */
const GAP_INTERVALS = 3;
/** Where earlier builds kept the detector state, before it moved into SQLite. */
const LEGACY_DETECTOR_KEY = "detector";
/** Window and bucket count per timeline range: 5-minute and 30-minute buckets. */
const RANGE_SPECS: Record<Range, { spanMs: number; buckets: number }> = {
  "24h": { spanMs: DAY_MS, buckets: 288 },
  "7d": { spanMs: 7 * DAY_MS, buckets: 336 },
};
const TIMELINE_EPISODE_LIMIT = 200;
/** Culprits the page lists per episode. */
const CULPRITS_SHOWN = 10;
/** Output ceilings for the agent tool and the CLI (characters). */
const TOOL_MAX_CHARS = 8_000;
const CLI_MAX_CHARS = 32_000;
const WHEN_HELP =
  "`90m`, `3h`, `2d`, `1w` back from now; `15:00` for the most recent 15:00 (server-local); or an ISO date/time";

/** How often a live reading is taken while someone is looking. */
const LIVE_INTERVAL_MS = 2_000;
/**
 * How long one heartbeat from a visible window keeps live readings going.
 * Windows renew at a quarter of this (hooks/use-status.ts), so three lost
 * heartbeats in a row still keep the readings going.
 */
const WATCH_LEASE_MS = 20_000;
/** A reading younger than this answers "now" without running `ps` again. */
const FRESH_MS = 5_000;

/**
 * Resolves when `ms` elapses or `signal` aborts, whichever comes first.
 * `onWake`, if given, receives a function that ends the sleep early.
 */
function sleep(ms: number, signal: AbortSignal, onWake?: (wake: () => void) => void): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
    onWake?.(done);
  });
}

/** How long a kill plan can be applied after it is shown. */
const PLAN_TTL_MS = 2 * 60_000;
const MAX_PLANS = 20;
/** Thread statuses in which a turn is running and can be stopped. */
const RUNNING = new Set(["active", "starting"]);

/** Resolves after `ms`. */
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Milliseconds on a clock that never jumps. Everything the service schedules
 * (samples, live ticks, the lease) runs on it; the wall clock only stamps
 * samples.
 */
const monotonic = () => performance.now();

/** What tests may inject into createHotspot. */
export interface HotspotDeps {
  takeReading?: TakeReading;
  liveIntervalMs?: number;
  watchLeaseMs?: number;
  /** The process table and signals the kill action uses. */
  kill?: {
    readRows: () => Promise<KillRow[]>;
    signal: (pid: number, signal: Signal) => void;
    sleep?: (ms: number) => Promise<void>;
    /** The plugin server's pid; its ancestors are BB. */
    selfPid?: number;
  };
}

/** A process and its ancestors in `rows`: the chain that is running Hotspot. */
function ancestry(rows: readonly KillRow[], pid: number): Set<number> {
  const byPid = new Map(rows.map((row) => [row.pid, row] as const));
  const chain = new Set<number>([pid]);
  for (let row = byPid.get(pid); row !== undefined && row.ppid > 0 && !chain.has(row.ppid); row = byPid.get(row.ppid)) {
    chain.add(row.ppid);
  }
  return chain;
}

/** BB's entry point: the plugin with its real sampler. */
export default function plugin(bb: BbPluginApi): Promise<void> {
  return createHotspot(bb);
}

/** The plugin, with the sampler injectable so tests can control its timing. */
export async function createHotspot(bb: BbPluginApi, deps: HotspotDeps = {}): Promise<void> {
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
    allowKill: {
      type: "boolean",
      label: "Offer \"Kill processes\" for a thread (footer popover and bb hotspot kill)",
      default: true,
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = createStore(db);

  // Titles and existence are looked up when shown, never stored, so every
  // surface names threads the same way (lib/threads.ts).
  const directory = createThreadDirectory(
    async (threadId) => {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        return { title: thread.title ?? thread.titleFallback ?? null };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    { ttlMs: TITLE_TTL_MS },
  );

  async function viewEpisodes(episodes: Episode[], limit: number): Promise<EpisodeView[]> {
    const known = await directory.resolve(episodes.flatMap((episode) => idsToResolve(episode.culprits, limit)));
    return episodes.map((episode) => viewEpisode(episode, known, limit));
  }

  async function view(sample: Sample): Promise<SampleView> {
    const known = await directory.resolve(idsToResolve(sample.threads, TOP_THREADS));
    return viewSample(sample, known, TOP_THREADS);
  }

  /** The last live reading, kept in memory only, and when it and the last stored sample were taken (monotonic). */
  let lastLive: Sample | null = null;
  let lastLiveTick = Number.NEGATIVE_INFINITY;
  let lastStoredTick = Number.NEGATIVE_INFINITY;

  /**
   * The newest reading: the last live one unless a sample was stored after
   * it. Ordered by when they were taken, not by their wall-clock stamps.
   */
  function latestSample(): Sample | null {
    return lastLive !== null && lastLiveTick >= lastStoredTick ? lastLive : store.latest();
  }

  async function viewLatest(): Promise<SampleView | null> {
    const latest = latestSample();
    return latest === null ? null : view(latest);
  }

  let processErrorLogged = false;
  let memoryErrorLogged = false;
  const sampler = deps.takeReading ?? createSampler({
    // Logged once per load: a missing `ps` fails every sample the same way.
    onProcessError(error) {
      if (processErrorLogged) return;
      processErrorLogged = true;
      bb.log.warn(`ps failed; recording CPU without threads: ${error instanceof Error ? error.message : String(error)}`);
    },
    onMemoryError(error) {
      if (memoryErrorLogged) return;
      memoryErrorLogged = true;
      bb.log.warn(`memory read failed; recording without memory: ${error instanceof Error ? error.message : String(error)}`);
    },
  });

  // The detector's state lives in SQLite beside the episodes and is written
  // in the same transaction. Builds before that kept it in KV: read it from
  // there once, then drop the key.
  const legacy = await bb.storage.kv.get<unknown>(LEGACY_DETECTOR_KEY);
  let detector: DetectorState = restoreState(store.detectorState() ?? legacy);
  if (legacy !== null && legacy !== undefined) {
    store.saveDetectorState(detector);
    await bb.storage.kv.delete(LEGACY_DETECTOR_KEY);
  }
  const strays = store.closeStrayEpisodes(detector.open?.id ?? null);
  if (strays > 0) bb.log.info(`closed ${strays} episode(s) the detector no longer tracks`);

  // The loop and an on-demand "now" share the sampler's windows, so one
  // reading runs at a time.
  let reading: Promise<unknown> = Promise.resolve();
  function takeReading(...args: Parameters<TakeReading>): ReturnType<TakeReading> {
    const next = reading.then(() => sampler(...args));
    reading = next.catch(() => undefined);
    return next;
  }

  const liveIntervalMs = deps.liveIntervalMs ?? LIVE_INTERVAL_MS;
  const watchLeaseMs = deps.watchLeaseMs ?? WATCH_LEASE_MS;
  /** Live readings run until this time (monotonic); each `watch` call pushes it out. */
  let watchedUntil = Number.NEGATIVE_INFINITY;
  let lastHeartbeat = Number.NEGATIVE_INFINITY;
  const watched = () => monotonic() < watchedUntil;
  /** Ends the sampler's current sleep; a no-op while it is reading. */
  let wakeSampler: () => void = () => undefined;

  /**
   * A fresh-enough reading for "now": the last one, or a new one that peeks
   * at the live window, so the footer's next reading still covers its full
   * interval.
   */
  async function readNow(): Promise<Sample | null> {
    if (lastLive !== null && monotonic() - lastLiveTick < FRESH_MS) return lastLive;
    try {
      lastLive = (await takeReading(Date.now(), { store: false, peek: true })).live;
      lastLiveTick = monotonic();
    } catch (error) {
      bb.log.warn(`reading failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return latestSample();
  }

  async function record(sample: Sample): Promise<void> {
    const { sampleIntervalSeconds, cpuThreshold } = await settings.get();
    const result = step(detector, sample, {
      cpuThreshold,
      openAfter: OPEN_AFTER,
      closeAfter: CLOSE_AFTER,
      intervalMs: sampleIntervalSeconds * 1_000,
      gapIntervals: GAP_INTERVALS,
    });
    const { closed, open, state } = store.commitStep({
      sample,
      closed: result.closed,
      updated: result.updated,
      state: result.state,
    });
    detector = state;
    if (closed !== null) {
      bb.log.info(`episode ${closed.id} closed after ${closed.samples} hot samples`);
    }
    if (result.opened !== null && open !== null) await announce(open);
    bb.realtime.publish(SAMPLED, {
      at: sample.at,
      thermal: sample.thermal,
      cpu: sample.cpu,
      mem: sample.memory?.percent ?? null,
      hot: open !== null,
    });
  }

  // The server has no toast API, so it publishes the opening and every open
  // app window raises the toast itself (app.tsx, HotspotToaster).
  async function announce(episode: Episode): Promise<void> {
    const [view] = await viewEpisodes([episode], 1);
    const top = view.culprits[0] ?? null;
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

  // Killing a thread's processes: plan, show, then apply by plan id only.
  const killDeps = deps.kill ?? {
    readRows: () => readKillRows(systemProcessSource),
    signal: (pid: number, signal: Signal) => process.kill(pid, signal),
  };
  const selfPid = deps.kill?.selfPid ?? process.pid;
  const cores = Math.max(1, os.cpus().length);
  const machineShare = (cpuPercent: number) => Math.round((cpuPercent / cores) * 10) / 10;
  const plans = new Map<string, { plan: KillPlan; context: PlanContext; expiresAt: number }>();

  async function requireKillAllowed(): Promise<void> {
    if (!(await settings.get()).allowKill) {
      throw new PluginCliError("Killing thread processes is turned off (setting allowKill).", {
        code: "kill_disabled",
        hint: "bb plugin config hotspot set allowKill true",
      });
    }
  }

  async function threadTitle(threadId: string): Promise<string | null> {
    const known = await directory.resolve([threadId]);
    if (!known.has(threadId)) {
      throw new PluginCliError(`No BB thread ${threadId}.`, { code: "thread_not_found" });
    }
    return known.get(threadId) ?? null;
  }

  async function makePlan(threadId: string): Promise<KillPlanView> {
    await requireKillAllowed();
    const title = await threadTitle(threadId);
    const rows = await killDeps.readRows();
    const context: PlanContext = {
      uid: process.getuid?.() ?? -1,
      selfPids: ancestry(rows, selfPid),
    };
    const plan = planKill(rows, threadId, context);
    const now = Date.now();
    for (const [id, entry] of plans) if (entry.expiresAt <= now) plans.delete(id);
    while (plans.size >= MAX_PLANS) plans.delete(plans.keys().next().value as string);
    const planId = randomUUID();
    const expiresAt = now + PLAN_TTL_MS;
    plans.set(planId, { plan, context, expiresAt });
    return {
      planId,
      expiresAt,
      threadId,
      title,
      targets: plan.targets.map((target) => ({
        pid: target.pid,
        name: target.name,
        cpu: machineShare(target.cpuPercent),
        command: target.argv.slice(0, 300),
      })),
      excluded: plan.excluded.map((entry) => ({
        pid: entry.pid,
        name: entry.name,
        cpu: machineShare(entry.cpuPercent),
        reason: entry.reason,
      })),
    };
  }

  async function applyPlan(planId: string): Promise<KillResultView> {
    await requireKillAllowed();
    const entry = plans.get(planId);
    // One use per plan: a second click cannot replay it.
    plans.delete(planId);
    if (entry === undefined || entry.expiresAt <= Date.now()) {
      throw new PluginCliError("That kill plan expired or was already used. Review a fresh plan.", {
        code: "plan_expired",
      });
    }
    const result = await applyKill(entry.plan, {
      readRows: killDeps.readRows,
      context: entry.context,
      signal: killDeps.signal,
      sleep: killDeps.sleep ?? wait,
      log: (message) => bb.log.info(message),
    });
    return {
      ...result,
      outcomes: result.outcomes.map((outcome) => ({ ...outcome, cpu: machineShare(outcome.cpuPercent) })),
    };
  }

  async function isRunning(threadId: string): Promise<boolean> {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      return RUNNING.has(thread.status);
    } catch {
      return false;
    }
  }

  bb.rpc.register(rpcContract, {
    async overview() {
      const latest = latestSample();
      const threadIds = (latest?.threads ?? []).slice(0, TOP_THREADS).map((entry) => entry.threadId);
      const states = await Promise.all(threadIds.map(async (threadId) => [threadId, await isRunning(threadId)] as const));
      return {
        episodes: await viewEpisodes(store.episodes(0, Date.now(), 3), 3),
        running: Object.fromEntries(states),
        allowKill: (await settings.get()).allowKill,
      };
    },
    killPlan: ({ threadId }) => makePlan(threadId),
    killApply: ({ planId }) => applyPlan(planId),
    async stopTurn({ threadId }) {
      await threadTitle(threadId);
      if (!(await isRunning(threadId))) {
        throw new PluginCliError(`Thread ${threadId} is not running a turn.`, { code: "not_running" });
      }
      await bb.sdk.threads.stop({ threadId });
      bb.log.info(`stopped the running turn of ${threadId} from the footer popover`);
      return { ok: true as const };
    },
    watch() {
      const wasWatched = watched();
      lastHeartbeat = monotonic();
      watchedUntil = Math.max(watchedUntil, lastHeartbeat + watchLeaseMs);
      if (!wasWatched) wakeSampler();
      return { leaseMs: watchLeaseMs, liveIntervalMs };
    },
    async status() {
      const { cpuThreshold, sampleIntervalSeconds } = await settings.get();
      const [open] = detector.open === null ? [null] : await viewEpisodes([detector.open], CULPRITS_SHOWN);
      const now = Date.now();
      return {
        latest: await viewLatest(),
        open,
        recent: bucketSamples(store.readings(now - RECENT_MS, now), now - RECENT_MS, now, RECENT_BUCKETS).points,
        cpuThreshold,
        sampleIntervalSeconds,
      };
    },
    async timeline({ range }) {
      const { spanMs, buckets } = RANGE_SPECS[range];
      const to = Date.now();
      const from = to - spanMs;
      const { bucketMs, points } = bucketSamples(store.readings(from, to), from, to, buckets);
      return {
        from,
        to,
        bucketMs,
        points,
        episodes: await viewEpisodes(store.episodes(from, to, TIMELINE_EPISODE_LIMIT), CULPRITS_SHOWN),
      };
    },
  });

  // One ticker serves both cadences. Each tick is one reading: stored when
  // a sample is due, pushed live while a window holds the watch lease, and
  // skipped entirely when neither applies.
  bb.background.service("sampler", {
    async start(signal) {
      // A reload restarts the service; sampling again at once would count
      // one extra sample into the streak. Wait out the rest of the interval.
      const { sampleIntervalSeconds: seconds } = await settings.get();
      let storeAt = monotonic() + startupDelay(store.latestAt(), Date.now(), seconds * 1_000);
      let wasLive = false;
      while (!signal.aborted) {
        const tick = monotonic();
        const started = Date.now();
        const { sampleIntervalSeconds } = await settings.get();
        const due = tick >= storeAt;
        const live = watched();
        if (live && !wasLive) bb.log.info("live readings started");
        if (!live && wasLive) {
          const ago = ((tick - lastHeartbeat) / 1_000).toFixed(1);
          bb.log.info(`live readings stopped: the last heartbeat arrived ${ago} s ago`);
        }
        wasLive = live;
        if (due || live) {
          try {
            const { live: now, stored } = await takeReading(started, { store: due });
            // Unloaded while `ps` ran: this generation must not write any more.
            if (signal.aborted) return;
            lastLive = now;
            lastLiveTick = tick;
            if (stored !== null) {
              lastStoredTick = tick;
              await record(stored);
            }
            if (live) {
              const payload: LiveSignal = await view(now);
              bb.realtime.publish(LIVE, payload);
            }
          } catch (error) {
            bb.log.warn(`sample failed: ${error instanceof Error ? error.message : String(error)}`);
          }
          if (due) storeAt = tick + sampleIntervalSeconds * 1_000;
        }
        // Asked again after the reading: a heartbeat that arrived during it
        // found no sleep to end.
        const next = watched() ? Math.min(storeAt, tick + liveIntervalMs) : storeAt;
        await sleep(Math.max(0, next - monotonic()), signal, (wake) => (wakeSampler = wake));
        wakeSampler = () => undefined;
      }
    },
  });

  /** Episodes overlapping [from, to] plus, optionally, what the window looked like. */
  async function historyText(options: {
    from: number;
    to: number;
    limit: number;
    culprits: number;
    summary: boolean;
  }): Promise<string> {
    const { from, to, limit, culprits, summary } = options;
    const lines = [`Hotspot history ${formatWhen(from)} → ${formatWhen(to)} (server-local time)`];
    if (summary) {
      const window = summarizeWindow(store.samples(from, to));
      const known = await directory.resolve(idsToResolve(window.threads, 5));
      lines.push("", "Window:", ...describeWindow(window, named(window.threads, known, 5)));
    }
    const episodes = await viewEpisodes(store.episodes(from, to, limit), culprits);
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
      "Why was the Mac hot or slow, and which BB thread caused it? Returns recorded hot episodes " +
      "(thermal pressure above nominal or sustained high CPU) overlapping a time window, each " +
      "with its culprit threads ranked by CPU, plus a summary of CPU, memory used, swap, memory " +
      "pressure, thermal level and the busiest threads (CPU and peak memory) across the whole " +
      "window. Read-only; output is bounded.",
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
      const text = await historyText({ ...window, limit, culprits: 5, summary: true });
      return clampText(text, TOOL_MAX_CHARS);
    },
  });

  bb.cli.register(
    defineCli({
      name: "hotspot",
      summary: "When the Mac ran hot and which BB thread caused it",
      commands: {
        kill: cliCommand({
          summary: "Plan (and with --yes, apply) killing a thread's work processes: dev servers, builds, test runners",
          positionals: [{ name: "threadId", description: "The thread whose processes to stop (thr_…)", required: true }],
          options: {
            yes: { type: "boolean", description: "Apply the plan: SIGTERM, then SIGKILL after 5 s for survivors" },
            json: { type: "boolean", description: "Emit JSON" },
          },
          async run(input) {
            const threadId = threadIdSchema.safeParse(input.positionals.threadId);
            if (!threadId.success) {
              throw new PluginCliError(`"${input.positionals.threadId}" is not a thread id.`, {
                code: "invalid_thread",
                hint: "Pass an id like thr_abc12345; `bb hotspot status` lists the busiest threads.",
              });
            }
            const plan = await makePlan(threadId.data);
            if (!input.options.yes || plan.targets.length === 0) {
              if (input.options.json) return { exitCode: 0, stdout: JSON.stringify({ plan, applied: null }) };
              const lines = describeKillPlan(plan);
              if (plan.targets.length > 0) lines.push("", "Nothing was signalled. Run again with --yes to apply.");
              return { exitCode: 0, stdout: clampText(lines.join("\n"), CLI_MAX_CHARS) };
            }
            // Kills from the CLI need a person at a terminal; agents' shells
            // are refused here, and the popover is the one-click path.
            const caller = checkInteractiveCaller(await killDeps.readRows(), threadId.data);
            if (!caller.ok) {
              throw new PluginCliError(`Refusing --yes: ${caller.reason}.`, {
                code: "not_interactive",
                hint: "Kill from the Hotspot popover in the BB sidebar footer, or run this command yourself in a terminal. Without --yes it only prints the plan.",
              });
            }
            const applied = await applyPlan(plan.planId);
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify({ plan, applied }) };
            const lines = [...describeKillPlan(plan), "", ...describeKillResult(applied)];
            return { exitCode: 0, stdout: clampText(lines.join("\n"), CLI_MAX_CHARS) };
          },
        }),
        status: cliCommand({
          summary: "Now: thermal level, CPU, memory, load, busiest threads and processes",
          options: { json: { type: "boolean", description: "Emit JSON" } },
          async run(input) {
            const now = await readNow();
            const latest = now === null ? null : await view(now);
            const [open] = detector.open === null ? [null] : await viewEpisodes([detector.open], 5);
            if (input.options.json) {
              const trimmed = open === null ? null : { ...open, others: open.others.slice(0, 5) };
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
              const episodes = (await viewEpisodes(store.episodes(window.from, window.to, limit), 5)).map(
                (episode) => ({ ...episode, others: episode.others.slice(0, 5) }),
              );
              return { exitCode: 0, stdout: JSON.stringify({ ...window, episodes }) };
            }
            const text = await historyText({ ...window, limit, culprits: 3, summary: false });
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
