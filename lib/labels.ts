/**
 * Names for the macOS thermal pressure levels. Free of Node and zod so the
 * app bundle, the CLI and the agent tool share one table.
 */
export const THERMAL_LABELS = ["nominal", "moderate", "heavy", "trapping", "sleeping"] as const;

export function thermalLabel(level: number | null): string {
  if (level === null) return "unknown";
  return THERMAL_LABELS[level] ?? `level ${level}`;
}
