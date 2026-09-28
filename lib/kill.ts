/**
 * Planning and applying "kill this thread's processes".
 *
 * The plan/apply split follows Ballast's relief code
 * (https://github.com/braedonsaunders/bb-plugin-ballast, `lib/relieve.ts`).
 * Copyright (c) Braedon Saunders. Licensed under the MIT License; see NOTICE.
 * Hotspot keeps its two rules and rewrites the rest:
 *
 * 1. Apply never takes a pid. It takes a plan id the server minted, and the
 *    plan holds each target's identity (pid, start time, command line).
 * 2. Every target is re-validated against a freshly read process table right
 *    before each signal. A recycled pid, a changed command line or a process
 *    that no longer belongs to the thread is refused, not signalled.
 *
 * What may be a target is decided here and nowhere else. A process is a
 * target only when it belongs to the thread (lib/procs.ts attribution), is
 * owned by this user, and is none of: BB itself, the thread's agent (the
 * provider CLI BB launched), the plugin's own process chain, a system binary,
 * or an app bundle. A process that is the parent of any of those is also
 * spared, so the shell running `bb hotspot kill` survives its own command, and
 * so is the rest of the command a `bb` CLI call belongs to (`bb … | head`).
 */
import { attributeThreads, type ProcessRow, type ProcessSource, processName, splitEnvironment, threadIdFrom } from "./procs";

/** A `ps` row with what identity and ownership checks need. */
export interface KillRow extends ProcessRow {
  uid: number;
  /** `ps` lstart in the C locale, e.g. `Mon Sep 28 14:04:23 2026`. */
  startedAt: string;
  /** The command line without the environment. */
  argv: string;
}

export const DARWIN_KILL_PS = "LC_ALL=C ps -axwwE -o pid=,ppid=,uid=,pcpu=,lstart=,command=";
export const PORTABLE_KILL_PS = "LC_ALL=C ps -eww -o pid=,ppid=,uid=,pcpu=,lstart=,args=";

const KILL_LINE =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;

/** One line of the kill `ps`; the environment, if any, is split off `command`. */
export function parseKillLine(line: string, environ?: string | null): KillRow | null {
  const match = KILL_LINE.exec(line);
  if (match === null) return null;
  const { argv, env } = environ === undefined ? splitEnvironment(match[6]) : { argv: match[6], env: environ ?? "" };
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    uid: Number(match[3]),
    cpuPercent: Number(match[4]),
    startedAt: match[5].replace(/\s+/g, " "),
    argv: argv.trim(),
    name: processName(argv),
    threadId: threadIdFrom(argv, env),
  };
}

/** Read the table the planner needs. Throws when `ps` fails. */
export async function readKillRows(source: ProcessSource): Promise<KillRow[]> {
  if (source.platform === "darwin") {
    const stdout = await source.exec(DARWIN_KILL_PS);
    return stdout.split("\n").map((line) => parseKillLine(line)).filter((row): row is KillRow => row !== null);
  }
  const stdout = await source.exec(PORTABLE_KILL_PS);
  const rows = await Promise.all(
    stdout.split("\n").map(async (line) => {
      const pid = /^\s*(\d+)\s/.exec(line)?.[1];
      if (pid === undefined) return null;
      return parseKillLine(line, await source.readEnviron(Number(pid)));
    }),
  );
  return rows.filter((row): row is KillRow => row !== null);
}

/** BB's own processes: the app, its helpers, daemons, bridges and the `bb` CLI. */
export function isBbProcess(row: Pick<KillRow, "argv" | "name">): boolean {
  return /\/bb\.app\/Contents\//i.test(row.argv) || /^bb(?: Helper\b.*)?$/i.test(row.name);
}

/** Binaries the OS owns. `/bin` and `/usr/bin` are left out: `sleep`, `yes`, `sh` are ordinary work. */
const SYSTEM_PATH = /^(?:\/System\/|\/usr\/libexec\/|\/usr\/sbin\/|\/sbin\/|\/Library\/Apple\/)/;
/** A macOS app bundle; spared unless it runs headless (a test browser). */
const APP_BUNDLE = /^(?:\/Applications\/|\/Users\/[^/]+\/Applications\/)[^/]+\.app\//;
const HEADLESS = /\s--headless\b|\s--remote-debugging-(?:port|pipe)\b/;

export interface PlanContext {
  /** The uid the server runs as; other users' processes are never targets. */
  uid: number;
  /** The plugin's own process and its ancestors (the BB host running it). */
  selfPids: ReadonlySet<number>;
}

export interface KillTarget {
  pid: number;
  ppid: number;
  name: string;
  argv: string;
  startedAt: string;
  cpuPercent: number;
}

export interface KillExclusion {
  pid: number;
  name: string;
  cpuPercent: number;
  reason: string;
}

export interface KillPlan {
  threadId: string;
  /** Children before parents, so a supervisor cannot respawn what was just stopped. */
  targets: KillTarget[];
  excluded: KillExclusion[];
}

/** Why a thread process must never be signalled, or null when it may be. */
function protection(row: KillRow, byPid: Map<number, KillRow>, owner: (pid: number) => string | null, threadId: string, context: PlanContext): string | null {
  if (context.selfPids.has(row.pid)) return "Hotspot's own process or the BB host running it";
  if (isBbProcess(row)) return "BB itself";
  if (row.uid !== context.uid) return "owned by another user";
  const parent = byPid.get(row.ppid);
  if (parent !== undefined && isBbProcess(parent)) return "the thread's agent (launched by BB)";
  if (row.ppid > 1 && owner(row.ppid) !== threadId) return "the thread's agent (started outside the thread's work)";
  const executable = row.argv.split(/\s/, 1)[0] ?? "";
  if (SYSTEM_PATH.test(executable)) return "a system process";
  if (APP_BUNDLE.test(row.argv) && !HEADLESS.test(row.argv)) return "an app, not work the thread started";
  return null;
}

/**
 * Which of the thread's processes to signal, and which are spared and why.
 * Pure: the same table always yields the same plan.
 */
export function planKill(rows: readonly KillRow[], threadId: string, context: PlanContext): KillPlan {
  const byPid = new Map(rows.map((row) => [row.pid, row] as const));
  const attribution = attributeThreads([...rows]);
  const owner = (pid: number) => attribution.get(pid) ?? null;
  const members = rows.filter((row) => owner(row.pid) === threadId);

  const reasons = new Map<number, string>();
  for (const row of members) {
    const reason = protection(row, byPid, owner, threadId, context);
    if (reason !== null) reasons.set(row.pid, reason);
  }
  // A `bb` CLI call inside the thread: the other processes its shell runs
  // are the same command (a pipeline), not work to stop.
  for (const row of members) {
    if (!isBbProcess(row) || context.selfPids.has(row.pid)) continue;
    for (const sibling of members) {
      if (sibling.ppid === row.ppid && sibling.pid !== row.pid && !reasons.has(sibling.pid)) {
        reasons.set(sibling.pid, "part of the same command as a bb CLI call");
      }
    }
  }
  // Killing a parent can take its child with it: spare every thread process
  // above a protected one.
  for (const pid of [...reasons.keys()]) {
    let parent = byPid.get(byPid.get(pid)?.ppid ?? -1);
    const seen = new Set<number>([pid]);
    while (parent !== undefined && owner(parent.pid) === threadId && !seen.has(parent.pid)) {
      seen.add(parent.pid);
      if (!reasons.has(parent.pid)) reasons.set(parent.pid, "the parent of a protected process (such as the shell running this command)");
      parent = byPid.get(parent.ppid);
    }
  }

  const depth = (row: KillRow) => {
    let count = 0;
    const seen = new Set<number>();
    for (let current = byPid.get(row.ppid); current !== undefined && !seen.has(current.pid); current = byPid.get(current.ppid)) {
      seen.add(current.pid);
      count += 1;
    }
    return count;
  };
  const targets = members
    .filter((row) => !reasons.has(row.pid))
    .map((row) => ({ row, depth: depth(row) }))
    .sort((a, b) => b.depth - a.depth || b.row.cpuPercent - a.row.cpuPercent)
    .map(({ row }) => ({
      pid: row.pid,
      ppid: row.ppid,
      name: row.name,
      argv: row.argv,
      startedAt: row.startedAt,
      cpuPercent: row.cpuPercent,
    }));
  const excluded = members
    .filter((row) => reasons.has(row.pid))
    .map((row) => ({ pid: row.pid, name: row.name, cpuPercent: row.cpuPercent, reason: reasons.get(row.pid) ?? "" }));
  return { threadId, targets, excluded };
}

/** Same pid, same start time, same command line: the process the plan named. */
export function sameProcess(target: KillTarget, row: KillRow | undefined): row is KillRow {
  return row !== undefined && row.startedAt === target.startedAt && row.argv === target.argv;
}

export type Signal = "SIGTERM" | "SIGKILL";

export interface ApplyDeps {
  readRows: () => Promise<KillRow[]>;
  context: PlanContext;
  /** Throws when the process is gone (ESRCH) or not ours (EPERM). */
  signal: (pid: number, signal: Signal) => void;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
  /** Wait between SIGTERM and SIGKILL. */
  graceMs?: number;
}

export interface KillOutcome {
  pid: number;
  name: string;
  cpuPercent: number;
  /**
   * `terminated`: exited after SIGTERM. `killed`: needed SIGKILL.
   * `gone`: had exited before it was signalled. `refused`: failed
   * re-validation and was not signalled. `failed`: the signal itself failed.
   */
  result: "terminated" | "killed" | "gone" | "refused" | "failed";
  detail: string | null;
}

export interface KillResult {
  threadId: string;
  outcomes: KillOutcome[];
  terminated: number;
  killed: number;
  refused: number;
}

/**
 * Signal a plan's targets. Each is re-checked against a fresh table first; a
 * survivor of SIGTERM gets SIGKILL only if it is still the same process and
 * still passes every rule. A survivor whose parent was among the targets may
 * have been reparented to launchd and so lost its thread; for that one case
 * the identity match alone carries it, since it was verified moments ago.
 */
export async function applyKill(plan: KillPlan, deps: ApplyDeps): Promise<KillResult> {
  const graceMs = deps.graceMs ?? 5_000;
  const outcomes = new Map<number, KillOutcome>();
  const outcome = (target: KillTarget, result: KillOutcome["result"], detail: string | null = null) =>
    outcomes.set(target.pid, { pid: target.pid, name: target.name, cpuPercent: target.cpuPercent, result, detail });

  const before = await deps.readRows();
  const beforeByPid = new Map(before.map((row) => [row.pid, row] as const));
  const allowed = new Set(planKill(before, plan.threadId, deps.context).targets.map((target) => target.pid));
  const signalled: KillTarget[] = [];
  for (const target of plan.targets) {
    const row = beforeByPid.get(target.pid);
    if (row === undefined) {
      outcome(target, "gone");
      continue;
    }
    if (!sameProcess(target, row)) {
      outcome(target, "refused", "pid now belongs to a different process");
      continue;
    }
    if (!allowed.has(target.pid)) {
      outcome(target, "refused", "no longer eligible (not the thread's, or now protected)");
      continue;
    }
    try {
      deps.signal(target.pid, "SIGTERM");
      signalled.push(target);
    } catch (error) {
      outcome(target, isGone(error) ? "gone" : "failed", isGone(error) ? null : errorText(error));
    }
  }

  if (signalled.length > 0) {
    await deps.sleep(graceMs);
    const after = await deps.readRows();
    const afterByPid = new Map(after.map((row) => [row.pid, row] as const));
    const stillAllowed = new Set(planKill(after, plan.threadId, deps.context).targets.map((target) => target.pid));
    const signalledPids = new Set(signalled.map((target) => target.pid));
    for (const target of signalled) {
      const row = afterByPid.get(target.pid);
      if (!sameProcess(target, row)) {
        outcome(target, "terminated");
        continue;
      }
      const orphanedByUs = row.ppid <= 1 || signalledPids.has(row.ppid);
      const protectedNow = row.uid !== deps.context.uid || isBbProcess(row) || deps.context.selfPids.has(row.pid);
      if (protectedNow || !(stillAllowed.has(row.pid) || orphanedByUs)) {
        outcome(target, "refused", "survived SIGTERM but is no longer eligible for SIGKILL");
        continue;
      }
      try {
        deps.signal(target.pid, "SIGKILL");
        outcome(target, "killed");
      } catch (error) {
        outcome(target, isGone(error) ? "terminated" : "failed", isGone(error) ? null : errorText(error));
      }
    }
  }

  const list = plan.targets.map((target) => outcomes.get(target.pid)).filter((entry): entry is KillOutcome => entry !== undefined);
  const count = (result: KillOutcome["result"]) => list.filter((entry) => entry.result === result).length;
  const result: KillResult = {
    threadId: plan.threadId,
    outcomes: list,
    terminated: count("terminated"),
    killed: count("killed"),
    refused: count("refused"),
  };
  deps.log(
    `kill ${plan.threadId}: ${plan.targets.length} planned, ${result.terminated} exited on SIGTERM, ` +
      `${result.killed} needed SIGKILL, ${count("gone")} already gone, ${result.refused} refused, ${count("failed")} failed; ` +
      list.map((entry) => `${entry.name}(${entry.pid}) ${entry.cpuPercent}% ${entry.result}`).join(", "),
  );
  return result;
}

function isGone(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ESRCH";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
