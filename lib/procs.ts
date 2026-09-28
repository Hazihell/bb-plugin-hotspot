/**
 * The process table, attributed to BB threads.
 *
 * Adapted from Ballast's `lib/procs.ts`
 * (https://github.com/braedonsaunders/bb-plugin-ballast).
 * Copyright (c) Braedon Saunders. Licensed under the MIT License; see NOTICE.
 *
 * Changes from the original: memory classification, kill-candidate rules and
 * byte formatting are gone (the sampler never touches a process; the kill
 * rules live in lib/kill.ts; resident memory is only summed per thread). `ps` also
 * prints each process's environment (`-E`), because BB exports
 * `BB_THREAD_ID` to every agent it launches and almost nothing else carries
 * the id. A bare `thr_…` anywhere in argv no longer counts, only a worktree
 * path. A process with no id of its own inherits its nearest ancestor's, so
 * a compiler forked by an agent is billed to that agent's thread. Rows are
 * ranked by CPU, not memory. Off macOS, `ps` has no `-E`, so the
 * environment comes from `/proc/<pid>/environ` instead. Each row also
 * carries the process's cumulative CPU time and a key that survives pid
 * reuse, so the sampler can measure CPU between two readings instead of
 * trusting `ps`'s decaying average.
 */
import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(exec);

/** Where the process table comes from; injected so tests can fake any OS. */
export interface ProcessSource {
  platform: NodeJS.Platform;
  exec(command: string): Promise<string>;
  /** The NUL-separated environment of `pid`, or null when unreadable. */
  readEnviron(pid: number): Promise<string | null>;
  /**
   * `/proc/<pid>/stat`, or null when unreadable. Off macOS it gives CPU time
   * and start time; a source without it leaves both unknown.
   */
  readStat?(pid: number): Promise<string | null>;
}

export const systemProcessSource: ProcessSource = {
  platform: process.platform,
  async exec(command) {
    const { stdout } = await run(command, { timeout: 15_000, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  },
  async readEnviron(pid) {
    // Only readable for processes this user owns, which covers BB's own.
    return readFile(`/proc/${pid}/environ`, "utf8").catch(() => null);
  },
  async readStat(pid) {
    return readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
  },
};

/** The C locale keeps `lstart` in one shape: `Mon Sep 28 14:04:23 2026`. */
export const DARWIN_PS = "LC_ALL=C ps -axE -o pid=,ppid=,pcpu=,rss=,time=,lstart=,command=";
export const PORTABLE_PS = "ps -eo pid=,ppid=,pcpu=,rss=,args=";
/** pid, ppid, pcpu, rss (KiB), cumulative CPU time, start time, then the command line. */
const DARWIN_LINE =
  /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+([\d:.-]+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;
/** pid, ppid, pcpu, rss (KiB), then the command line. */
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/;
/** Linux reports `/proc/<pid>/stat` times in clock ticks; USER_HZ is 100 on every mainstream kernel. */
const CLOCK_TICKS_PER_SECOND = 100;

export interface ProcessRow {
  pid: number;
  ppid: number;
  /**
   * Percent of one core; one busy core is 100. As read, `ps` pcpu, which on
   * macOS is a decaying average over roughly the last minute; the sampler
   * replaces it with CPU time over its own interval where it can
   * (lib/sample.ts, cpuSince).
   */
  cpuPercent: number;
  /** Resident set size in bytes. Shared pages count in every process that maps them. */
  rssBytes: number;
  /** CPU time (user and system) used since the process started, in ms; null when unknown. */
  cpuMs: number | null;
  /**
   * The pid and the process's start time, so a reused pid reads as a new
   * process; null when the start time is unknown.
   */
  key: string | null;
  name: string;
  /** The thread named by this process itself (environment or argv). */
  threadId: string | null;
  /** One of BB's own processes (isBbCommand). */
  bb: boolean;
}

export interface ThreadCpu {
  threadId: string;
  cpuPercent: number;
  /** Resident memory summed over the thread's processes, in bytes. */
  rssBytes: number;
  processCount: number;
}

/**
 * Basename of argv[0], with the macOS app-bundle tail preferred.
 *
 * `/Applications/bb.app/Contents/MacOS/bb Helper (Renderer)` should read as
 * "bb Helper (Renderer)", not as the path, and `/opt/homebrew/.../bin/node`
 * should read as "node".
 */
export function processName(command: string): string {
  // `ps` joins argv (and, with -E, the environment) with spaces, and
  // executables on macOS have spaces in their paths, so there is no lossless
  // split. End argv[0] at the first space that starts something recognisably
  // *not* part of a path: a flag, another absolute path, or a `VAR=value`.
  const boundary = /\s(?=[-/]|\S*=)/.exec(command);
  const argv0 = (boundary === null ? command : command.slice(0, boundary.index)).trim();
  const base = (argv0.split("/").pop() ?? argv0).trim();
  // `next-server (v16.3.4)` — the version is noise in a label.
  return base.replace(/\s*\([^)]*\)\s*$/, "") || argv0;
}

/**
 * BB's own processes: the app, its helpers, its server and daemons (all
 * `bb.app/Contents/…` on macOS), bridges and the `bb` CLI. The kill rules
 * treat these as walls (lib/kill.ts); the BB total counts them as the app.
 */
export function isBbCommand(argv: string, name: string): boolean {
  return /\/bb\.app\/Contents\//i.test(argv) || /^bb(?: Helper\b.*)?$/i.test(name);
}

/**
 * Split a `ps -E` command line into argv and the environment appended to it.
 *
 * The environment starts at the first space followed by `NAME=`. An argv
 * token shaped like `key=value` is taken for the start of the environment,
 * which only costs a worktree path that comes after it.
 */
export function splitEnvironment(command: string): { argv: string; env: string } {
  const boundary = /\s(?=[A-Za-z_][A-Za-z0-9_]*=)/.exec(command);
  if (boundary === null) return { argv: command, env: "" };
  return { argv: command.slice(0, boundary.index), env: command.slice(boundary.index + 1) };
}

const ENV_THREAD = /(?:^|[\s\0])BB_THREAD_ID=(thr_[a-z0-9]{8,})(?![a-z0-9])/;
/** A thread id as a path segment directly under a BB worktree or workspace directory. */
const WORKTREE_THREAD = /\/(?:worktrees|workspaces)\/(thr_[a-z0-9]{8,})(?:-\d+)?(?=\/|\s|$)/;

/**
 * The BB thread a process names itself, if any.
 *
 * `BB_THREAD_ID` in the process's own environment wins: BB exports it to
 * every agent it launches, and children inherit it. Otherwise only a
 * worktree path in argv counts (BB names each worktree after its thread). A
 * bare `thr_…` in argv (`grep thr_x`) or a path in some other variable
 * (`PWD`, `OLDPWD`) names nothing.
 */
export function threadIdFrom(argv: string, env: string): string | null {
  return ENV_THREAD.exec(env)?.[1] ?? WORKTREE_THREAD.exec(argv)?.[1] ?? null;
}

/** The thread a `ps -E` command line names (argv and environment together). */
export function parseThreadId(command: string): string | null {
  const { argv, env } = splitEnvironment(command);
  return threadIdFrom(argv, env);
}

/**
 * `ps` cumulative CPU time in ms: `[[dd-]hh:]mm:ss[.cc]`. macOS prints
 * minutes and centiseconds (`870:19.60`); procps prints whole seconds.
 */
export function parseCpuTime(text: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text);
  if (match === null) return null;
  const [, days = "0", hours = "0", minutes, seconds] = match;
  return Math.round(((Number(days) * 24 + Number(hours)) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000);
}

/** CPU time and start time from `/proc/<pid>/stat`, or null when it cannot be read. */
export function parseProcStat(text: string | null): { cpuMs: number; started: string } | null {
  if (text === null) return null;
  // The command name (field 2) is in parentheses and may hold spaces; count from after it.
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  const started = fields[19];
  if (!Number.isFinite(utime) || !Number.isFinite(stime) || started === undefined || started === "") return null;
  return { cpuMs: ((utime + stime) * 1000) / CLOCK_TICKS_PER_SECOND, started };
}

/** One line of `ps -axE -o pid=,ppid=,pcpu=,rss=,time=,lstart=,command=`. */
export function parsePsLine(line: string): ProcessRow | null {
  const match = DARWIN_LINE.exec(line);
  if (match === null) return null;
  const command = match[7];
  const name = processName(command);
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    cpuPercent: Number(match[3]),
    rssBytes: Number(match[4]) * 1024,
    cpuMs: parseCpuTime(match[5]),
    key: `${match[1]}@${match[6].replace(/\s+/g, " ")}`,
    name,
    threadId: parseThreadId(command),
    bb: isBbCommand(splitEnvironment(command).argv, name),
  };
}

export function parsePs(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    const row = parsePsLine(line);
    if (row !== null) rows.push(row);
  }
  return rows;
}

/**
 * Read every process once. ~80 ms on macOS for a full table with
 * environments. Throws when `ps` itself fails.
 *
 * Environments are only visible for processes owned by the same user, which
 * is every process BB launches. Root daemons simply carry no thread id.
 */
export async function readProcesses(
  source: ProcessSource = systemProcessSource,
): Promise<ProcessRow[]> {
  if (source.platform === "darwin") return parsePs(await source.exec(DARWIN_PS));
  const stdout = await source.exec(PORTABLE_PS);
  const lines = stdout
    .split("\n")
    .map((line) => PS_LINE.exec(line))
    .filter((match): match is RegExpExecArray => match !== null);
  return Promise.all(
    lines.map(async (match) => {
      const pid = Number(match[1]);
      const argv = match[5];
      const [environ, stat] = await Promise.all([source.readEnviron(pid), source.readStat?.(pid) ?? null]);
      const env = environ ?? "";
      const times = parseProcStat(stat);
      return {
        pid,
        ppid: Number(match[2]),
        cpuPercent: Number(match[3]),
        rssBytes: Number(match[4]) * 1024,
        cpuMs: times?.cpuMs ?? null,
        key: times === null ? null : `${pid}@${times.started}`,
        name: processName(argv),
        threadId: threadIdFrom(argv, env),
        bb: isBbCommand(argv, processName(argv)),
      };
    }),
  );
}

/** What thread attribution reads from a row. */
type AttributableRow = Pick<ProcessRow, "pid" | "ppid" | "threadId">;

/**
 * The thread each process belongs to: its own, else its nearest ancestor's.
 *
 * Walking up is what bills `node vitest` to the agent that ran it even when
 * the test runner was started with a relative path and an environment that
 * dropped `BB_THREAD_ID`.
 */
export function attributeThreads(rows: AttributableRow[]): Map<number, string | null> {
  const byPid = new Map<number, AttributableRow>();
  for (const row of rows) byPid.set(row.pid, row);
  const resolved = new Map<number, string | null>();
  const resolve = (row: AttributableRow): string | null => {
    const known = resolved.get(row.pid);
    if (known !== undefined) return known;
    const chain: AttributableRow[] = [];
    let current: AttributableRow | undefined = row;
    let threadId: string | null = null;
    const seen = new Set<number>();
    while (current !== undefined && current.pid > 1 && !seen.has(current.pid)) {
      const cached = resolved.get(current.pid);
      if (cached !== undefined) {
        threadId = cached;
        break;
      }
      if (current.threadId !== null) {
        threadId = current.threadId;
        break;
      }
      seen.add(current.pid);
      chain.push(current);
      current = byPid.get(current.ppid);
    }
    for (const member of chain) resolved.set(member.pid, threadId);
    if (current !== undefined && current.threadId !== null) {
      resolved.set(current.pid, current.threadId);
    }
    return threadId;
  };
  for (const row of rows) resolve(row);
  return resolved;
}

/** Regroup the process table by BB thread, busiest first. */
export function groupByThread(
  rows: ProcessRow[],
  attribution: Map<number, string | null> = attributeThreads(rows),
): ThreadCpu[] {
  const byThread = new Map<string, ThreadCpu>();
  for (const row of rows) {
    const threadId = attribution.get(row.pid) ?? null;
    if (threadId === null) continue;
    const entry = byThread.get(threadId) ?? { threadId, cpuPercent: 0, rssBytes: 0, processCount: 0 };
    entry.cpuPercent += row.cpuPercent;
    entry.rssBytes += row.rssBytes;
    entry.processCount += 1;
    byThread.set(threadId, entry);
  }
  return [...byThread.values()].sort((a, b) => b.cpuPercent - a.cpuPercent);
}

/** The busiest processes that belong to no thread, busiest first. */
export function topUnattributed(
  rows: ProcessRow[],
  attribution: Map<number, string | null>,
  limit: number,
): Array<{ pid: number; name: string; cpuPercent: number }> {
  return rows
    .filter((row) => (attribution.get(row.pid) ?? null) === null && row.cpuPercent > 0)
    .sort((a, b) => b.cpuPercent - a.cpuPercent)
    .slice(0, limit)
    .map((row) => ({ pid: row.pid, name: row.name, cpuPercent: row.cpuPercent }));
}

/** CPU (percent of one core), resident memory and process count over a set of processes. */
export interface ProcessTotal {
  cpuPercent: number;
  rssBytes: number;
  processes: number;
}

/**
 * Everything BB is running, in two parts that never overlap: `threads` is
 * every process attributed to a BB thread (attributeThreads), and `app` is
 * every other process of BB's own (isBbCommand). A BB process that carries
 * a thread's id, such as the `bb` CLI an agent runs, counts in its thread.
 * Processes that are neither, including children of BB that no thread
 * claims, are left out.
 */
export function bbTotals(
  rows: readonly Pick<ProcessRow, "pid" | "cpuPercent" | "rssBytes" | "bb">[],
  attribution: Map<number, string | null>,
): { app: ProcessTotal; threads: ProcessTotal } {
  const app: ProcessTotal = { cpuPercent: 0, rssBytes: 0, processes: 0 };
  const threads: ProcessTotal = { cpuPercent: 0, rssBytes: 0, processes: 0 };
  for (const row of rows) {
    const part = (attribution.get(row.pid) ?? null) !== null ? threads : row.bb ? app : null;
    if (part === null) continue;
    part.cpuPercent += row.cpuPercent;
    part.rssBytes += row.rssBytes;
    part.processes += 1;
  }
  return { app, threads };
}
