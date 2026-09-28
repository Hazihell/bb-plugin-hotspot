/**
 * macOS thermal pressure, read from the notify key the kernel publishes.
 *
 * `pmset -g therm` prints nothing on Apple Silicon and degree readings need
 * root, so the pressure level is the only heat signal an unprivileged process
 * gets. It is the same level the OS itself throttles on.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const THERMAL_KEY = "com.apple.system.thermalpressurelevel";

/** `com.apple.system.thermalpressurelevel 2` → 2. Anything else → null. */
export function parseThermal(stdout: string): number | null {
  const match = /^\s*com\.apple\.system\.thermalpressurelevel\s+(\d+)\s*$/m.exec(stdout);
  if (match === null) return null;
  const level = Number(match[1]);
  return Number.isInteger(level) && level >= 0 && level <= 4 ? level : null;
}

/** Null when `notifyutil` is missing (Linux) or fails; never throws. */
export async function readThermal(): Promise<number | null> {
  try {
    const { stdout } = await run("notifyutil", ["-g", THERMAL_KEY], { timeout: 5_000 });
    return parseThermal(stdout);
  } catch {
    return null;
  }
}
