/**
 * The process table, attributed to BB threads.
 *
 * Adapted from Ballast's `lib/procs.ts`
 * (https://github.com/braedonsaunders/bb-plugin-ballast).
 * Copyright (c) Braedon Saunders. Licensed under the MIT License; see NOTICE.
 *
 * Changes from the original: memory classification, kill-candidate rules and
 * byte formatting are gone (Hotspot never touches a process). `ps` also
 * prints each process's environment (`-E`), because BB exports
 * `BB_THREAD_ID` to every agent it launches and almost nothing else carries
 * the id. A bare `thr_…` anywhere in argv no longer counts, only a worktree
 * path. A process with no id of its own inherits its nearest ancestor's, so
 * a compiler forked by an agent is billed to that agent's thread. Rows are
 * ranked by CPU, not memory. Off macOS, `ps` has no `-E`, so the
 * environment comes from `/proc/<pid>/environ` instead.
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
};

export const DARWIN_PS = "ps -axE -o pid=,ppid=,pcpu=,command=";
export const PORTABLE_PS = "ps -eo pid=,ppid=,pcpu=,args=";

export interface ProcessRow {
  pid: number;
  ppid: number;
  /**
   * `ps` pcpu. On macOS this is a decaying average over roughly the last
   * minute, not an instantaneous reading, and one busy core is 100.
   */
  cpuPercent: number;
  name: string;
  /** The thread named by this process itself (environment or argv). */
  threadId: string | null;
}

export interface ThreadCpu {
  threadId: string;
  cpuPercent: number;
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

/** One line of `ps -axE -o pid=,ppid=,pcpu=,command=`. */
export function parsePsLine(line: string): ProcessRow | null {
  const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(line);
  if (match === null) return null;
  const command = match[4];
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    cpuPercent: Number(match[3]),
    name: processName(command),
    threadId: parseThreadId(command),
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
    .map((line) => /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null);
  return Promise.all(
    lines.map(async (match) => {
      const pid = Number(match[1]);
      const argv = match[4];
      const env = (await source.readEnviron(pid)) ?? "";
      return {
        pid,
        ppid: Number(match[2]),
        cpuPercent: Number(match[3]),
        name: processName(argv),
        threadId: threadIdFrom(argv, env),
      };
    }),
  );
}

/**
 * The thread each process belongs to: its own, else its nearest ancestor's.
 *
 * Walking up is what bills `node vitest` to the agent that ran it even when
 * the test runner was started with a relative path and an environment that
 * dropped `BB_THREAD_ID`.
 */
export function attributeThreads(rows: ProcessRow[]): Map<number, string | null> {
  const byPid = new Map<number, ProcessRow>();
  for (const row of rows) byPid.set(row.pid, row);
  const resolved = new Map<number, string | null>();
  const resolve = (row: ProcessRow): string | null => {
    const known = resolved.get(row.pid);
    if (known !== undefined) return known;
    const chain: ProcessRow[] = [];
    let current: ProcessRow | undefined = row;
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
    const entry = byThread.get(threadId) ?? { threadId, cpuPercent: 0, processCount: 0 };
    entry.cpuPercent += row.cpuPercent;
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
