/**
 * Realtime channels between the server and the app bundle. Kept free of zod
 * so the frontend can import the names as values.
 */
import type { SampleView } from "./schemas";

/** A sample was stored: history, episodes and sparklines changed. */
export const SAMPLED = "sampled";
/**
 * A live reading, every couple of seconds while a window keeps the watch
 * lease. The payload is the reading itself (a `LiveSignal`), so the footer
 * and popover update without asking the server. Never stored.
 */
export const LIVE = "live";
export const EPISODE_OPENED = "episode-opened";
/**
 * A thread shown in the latest reading started or ended a turn; the popover
 * refetches its overview to offer or withdraw Stop turn.
 */
export const RUNNING_CHANGED = "running-changed";

export interface RunningChangedSignal {
  threadId: string;
  running: boolean;
}

export type LiveSignal = SampleView;

/** Why a window sent a heartbeat; the server names it when a lapsed lease restarts. */
export const WATCH_REASONS = ["mount", "timer", "shown", "focus", "pageshow", "reconnect", "retry"] as const;
export type WatchReason = (typeof WATCH_REASONS)[number];

export interface EpisodeOpenedSignal {
  id: number;
  startAt: number;
  peakThermal: number | null;
  peakCpu: number;
  top: { threadId: string; title: string | null } | null;
}
