/**
 * Realtime channels between the server and the app bundle. Kept free of zod
 * so the frontend can import the names as values.
 */
export const SAMPLED = "sampled";
export const EPISODE_OPENED = "episode-opened";

export interface EpisodeOpenedSignal {
  id: number;
  startAt: number;
  peakThermal: number | null;
  peakCpu: number;
  top: { threadId: string; title: string | null } | null;
}
