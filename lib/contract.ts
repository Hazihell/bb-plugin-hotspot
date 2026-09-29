/**
 * The wire contract between the server and the app bundle.
 *
 * `app.tsx` imports only the inferred types (`import type`), so zod never
 * reaches the frontend bundle.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { episodeViewSchema, sampleViewSchema, timelinePointSchema } from "./schemas";
import { WATCH_REASONS } from "./signals";

export const RANGES = ["24h", "7d"] as const;
/** The sparklines' window: one hour in 30 two-minute buckets. */
export const RECENT_MS = 60 * 60_000;
export const RECENT_BUCKETS = 30;
export type Range = (typeof RANGES)[number];

/** A BB thread id; anything else from the frontend is refused before it reaches the SDK. */
export const threadIdSchema = z.string().regex(/^thr_[a-z0-9]{8,64}$/);
/** A process's pid and `ps` start time (lib/kill.ts, processKey), as the drill-down's rows carry it. */
export const processKeySchema = z.string().regex(/^\d{1,10}@[A-Za-z0-9: ]{1,40}$/);

const killProcessSchema = z.object({
  pid: z.number(),
  name: z.string(),
  /** Share of the whole machine, 0–100. */
  cpu: z.number(),
});

/** Every process the plan found in the thread: what it will signal, and what it spares and why. */
export const killPlanSchema = z.object({
  /** Opaque and short-lived; the only thing `killApply` accepts. */
  planId: z.string(),
  expiresAt: z.number(),
  threadId: z.string(),
  title: z.string().nullable(),
  targets: z.array(killProcessSchema.extend({ command: z.string(), key: z.string() })),
  excluded: z.array(killProcessSchema.extend({ reason: z.string() })),
  /**
   * Null for the whole thread. For one process: which, and why nothing is
   * targeted when it no longer can be (`reason`); `name` is null when no
   * process has that identity now.
   */
  selected: z.object({ pid: z.number(), name: z.string().nullable(), reason: z.string().nullable() }).nullable(),
});

export const killResultSchema = z.object({
  threadId: z.string(),
  terminated: z.number(),
  killed: z.number(),
  refused: z.number(),
  outcomes: z.array(
    killProcessSchema.extend({
      result: z.enum(["terminated", "killed", "gone", "refused", "failed"]),
      detail: z.string().nullable(),
    }),
  ),
});

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z.object({
      /** The newest reading: live when one is fresher than the last stored sample. */
      latest: sampleViewSchema.nullable(),
      open: episodeViewSchema.nullable(),
      /** The last hour in RECENT_BUCKETS equal buckets, oldest first, for the metric sparklines. */
      recent: z.array(timelinePointSchema),
      cpuThreshold: z.number(),
      sampleIntervalSeconds: z.number(),
      /** The OS process monitor the server's machine can open, and that machine's name; null when there is none. */
      monitor: z.object({ app: z.string(), host: z.string() }).nullable(),
    }),
  },
  /** What the footer popover adds to `status`: recent episodes, which top threads run a turn, and whether kill is allowed. */
  overview: {
    input: z.null(),
    output: z.object({
      episodes: z.array(episodeViewSchema),
      running: z.record(z.string(), z.boolean()),
      allowKill: z.boolean(),
    }),
  },
  /**
   * A visible window's heartbeat. Live readings run while any window has
   * called this within the lease, and stop when every lease lapses.
   */
  watch: {
    // Null from a window still running a bundle from before reasons existed.
    input: z.object({ reason: z.enum(WATCH_REASONS) }).strict().nullable(),
    output: z.object({ leaseMs: z.number(), liveIntervalMs: z.number() }),
  },
  /**
   * With `process`, the thread's plan narrowed to that process and the
   * targets it started (lib/kill.ts, narrowPlan).
   */
  killPlan: {
    input: z.object({ threadId: threadIdSchema, process: processKeySchema.optional() }).strict(),
    output: killPlanSchema,
  },
  /** Which processes a thread's kill would target now, by key, so the drill-down offers Kill only on those. Signals nothing and mints no plan. */
  killTargets: {
    input: z.object({ threadId: threadIdSchema }).strict(),
    output: z.object({ keys: z.array(z.string()) }),
  },
  killApply: {
    input: z.object({ planId: z.string().uuid() }).strict(),
    output: killResultSchema,
  },
  stopTurn: {
    input: z.object({ threadId: threadIdSchema }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  /** Opens the OS process monitor on the server's machine (lib/monitor.ts). Never throws: a failure is `ok: false`. */
  openMonitor: {
    input: z.null(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), app: z.string() }),
      z.object({ ok: z.literal(false), app: z.string().nullable(), error: z.string() }),
    ]),
  },
  timeline: {
    input: z.object({ range: z.enum(RANGES) }).strict(),
    output: z.object({
      from: z.number(),
      to: z.number(),
      bucketMs: z.number(),
      points: z.array(timelinePointSchema),
      episodes: z.array(episodeViewSchema),
    }),
  },
});

export type { EpisodeView as Episode, SampleView as Sample, TimelinePoint } from "./schemas";
export type Status = z.infer<(typeof rpcContract)["status"]["output"]>;
export type Timeline = z.infer<(typeof rpcContract)["timeline"]["output"]>;
export type Overview = z.infer<(typeof rpcContract)["overview"]["output"]>;
export type KillPlanView = z.infer<typeof killPlanSchema>;
export type KillResultView = z.infer<typeof killResultSchema>;
