/**
 * Opening the OS's own process monitor (Activity Monitor on macOS) on the
 * machine running BB's server, for the popover's and page's "Activity
 * Monitor" button.
 *
 * Only fixed argv is ever run, with no shell, so nothing from the frontend
 * reaches a command line. Which monitor exists is found once and reported to
 * the app, which shows the button only when there is one. Opening never
 * throws: a failure comes back as a message the button shows beside itself.
 */
import { execFile, spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";

/** `open` returns as soon as Launch Services has the app; this is only a guard against a hang. */
const OPEN_TIMEOUT_MS = 5_000;

export interface Monitor {
  /** What the button calls it: "Activity Monitor", "System Monitor". */
  app: string;
  file: string;
  args: readonly string[];
  /** True when the command returns at once (`open`); false when it is the app itself and keeps running. */
  returns: boolean;
}

export type OpenResult = { ok: true; app: string } | { ok: false; app: string | null; error: string };

/** What the launcher touches; injected so tests can fake any OS. */
export interface MonitorRunner {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** Whether `file` is an executable on PATH. */
  onPath(file: string): Promise<boolean>;
  /** Run to completion; rejects on a non-zero exit or after `timeoutMs`. */
  run(file: string, args: readonly string[], timeoutMs: number): Promise<void>;
  /** Start detached and resolve once it has started; rejects if it cannot start. */
  start(file: string, args: readonly string[]): Promise<void>;
}

const MAC: Monitor = { app: "Activity Monitor", file: "open", args: ["-a", "Activity Monitor"], returns: true };
/** Linux monitors in order of preference: GNOME's, then KDE's current and older one. */
const LINUX: Monitor[] = [
  { app: "System Monitor", file: "gnome-system-monitor", args: [], returns: false },
  { app: "System Monitor", file: "plasma-systemmonitor", args: [], returns: false },
  { app: "KSysGuard", file: "ksysguard", args: [], returns: false },
];

/** The monitor this machine can open, or null when there is none (another OS, or Linux with no desktop). */
export async function findMonitor(runner: MonitorRunner): Promise<Monitor | null> {
  if (runner.platform === "darwin") return MAC;
  if (runner.platform !== "linux") return null;
  // A headless server has no screen to open a window on.
  if (!runner.env.DISPLAY && !runner.env.WAYLAND_DISPLAY) return null;
  for (const monitor of LINUX) {
    if (await runner.onPath(monitor.file)) return monitor;
  }
  return null;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Open `monitor`, or say why it could not be opened. */
export async function openMonitor(monitor: Monitor | null, runner: MonitorRunner): Promise<OpenResult> {
  if (monitor === null) {
    return { ok: false, app: null, error: "No system monitor to open on this machine." };
  }
  try {
    if (monitor.returns) await runner.run(monitor.file, monitor.args, OPEN_TIMEOUT_MS);
    else await runner.start(monitor.file, monitor.args);
    return { ok: true, app: monitor.app };
  } catch (error) {
    return { ok: false, app: monitor.app, error: `Could not open ${monitor.app}: ${message(error)}` };
  }
}

export const systemMonitorRunner: MonitorRunner = {
  platform: process.platform,
  env: process.env,
  async onPath(file) {
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      if (dir === "") continue;
      try {
        await access(path.join(dir, file), constants.X_OK);
        return true;
      } catch {
        // Not in this directory.
      }
    }
    return false;
  },
  run(file, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      execFile(file, [...args], { timeout: timeoutMs }, (error, _stdout, stderr) => {
        if (error === null) return resolve();
        const detail = String(stderr).trim();
        reject(new Error(detail === "" ? error.message : detail));
      });
    });
  },
  start(file, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(file, [...args], { detached: true, stdio: "ignore" });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  },
};
