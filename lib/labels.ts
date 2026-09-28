/**
 * Names for the macOS thermal pressure levels. Free of Node and zod so the
 * app bundle, the CLI and the agent tool share one table.
 */
export const THERMAL_LABELS = ["nominal", "moderate", "heavy", "trapping", "sleeping"] as const;

export function thermalLabel(level: number | null): string {
  if (level === null) return "unknown";
  return THERMAL_LABELS[level] ?? `level ${level}`;
}

/** `640 MB`, `1.2 GB`, `16 GB`: binary units, one decimal under 10 GB. */
export function bytesText(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 9.95) return `${Math.round(gb)} GB`;
  if (gb >= 0.995) return `${gb.toFixed(1)} GB`;
  return `${Math.max(0, Math.round(bytes / 1024 ** 2))} MB`;
}

/** Processes a hot spell keeps and shows per culprit thread. */
export const CULPRIT_PROCS = 3;
