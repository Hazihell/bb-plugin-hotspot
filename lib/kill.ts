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
 * What may be a target is decided here and nowhere else. Ownership is found
 * by walking up from a process, not by inheriting a thread id: a *wall* (BB,
 * an app bundle, another user's process, a system binary, an interactive
 * shell, Hotspot's own chain) ends the thread's claim, so nothing below an
 * app a thread happened to launch belongs to the thread. Only a process BB
 * launched (the agent) or a detached one carrying its own BB_THREAD_ID can
 * pass the thread down. Walls and the agent are never targets, and the
 * agent is the whole chain from BB down to its first work shell (wrappers,
 * relaunches) plus the helpers it runs directly (MCP servers). A process
 * that is the parent of any of those is also spared, so the shell running
 * `bb hotspot kill` survives its own command, and so is the rest of the
 * command a `bb` CLI call belongs to (`bb … | head`).
 */
import { friendlyName } from "./proc-name";
import { attributeThreads, isBbCommand, type ProcessRow, type ProcessSource, processName, splitEnvironment, threadIdFrom } from "./procs";

/** A `ps` row with what identity and ownership checks need; the kill `ps` reads no memory or CPU time. */
export interface KillRow extends Omit<ProcessRow, "rssBytes" | "cpuMs" | "key" | "bb" | "argv"> {
  uid: number;
  /** `ps` lstart in the C locale, e.g. `Mon Sep 28 14:04:23 2026`. */
  startedAt: string;
  /** The command line without the environment. */
  argv: string;
  /** The controlling terminal (`ttys003`, `pts/2`), or null for none. */
  tty: string | null;
}

export const DARWIN_KILL_PS = "LC_ALL=C ps -axwwE -o pid=,ppid=,uid=,tty=,pcpu=,lstart=,command=";
export const PORTABLE_KILL_PS = "LC_ALL=C ps -eww -o pid=,ppid=,uid=,tty=,pcpu=,lstart=,args=";

const KILL_LINE =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;

/** One line of the kill `ps`; the environment, if any, is split off `command`. */
export function parseKillLine(line: string, environ?: string | null): KillRow | null {
  const match = KILL_LINE.exec(line);
  if (match === null) return null;
  const { argv, env } = environ === undefined ? splitEnvironment(match[7]) : { argv: match[7], env: environ ?? "" };
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    uid: Number(match[3]),
    tty: /^[?-]+$/.test(match[4]) ? null : match[4],
    cpuPercent: Number(match[5]),
    startedAt: match[6].replace(/\s+/g, " "),
    argv: argv.trim(),
    name: processName(argv),
    label: friendlyName(argv),
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
  return isBbCommand(row.argv, row.name);
}

/** Binaries the OS owns. `/bin` and `/usr/bin` are left out: `sleep`, `yes`, `sh` are ordinary work. */
const SYSTEM_PATH = /^(?:\/System\/|\/usr\/libexec\/|\/usr\/sbin\/|\/sbin\/|\/Library\/Apple\/)/;
/**
 * An executable inside a macOS app bundle, wherever the bundle lives
 * (/Applications, ~/Applications, a Homebrew cask, a Playwright cache). Path
 * segments may hold spaces but never a space before the next `/`, so an
 * argument naming a bundle is not mistaken for the executable. Spared
 * unless it runs headless (a test browser).
 */
const APP_BUNDLE = /^\/(?:(?:(?!\s\/)[^/])+\/)*?(?:(?!\s\/)[^/])+\.app\/Contents\//;
/** Python.framework runs every script through its own Python.app; that is an interpreter, not an app. */
const INTERPRETER_BUNDLE = /^\S*\/Python\.framework\/Versions\/[^/\s]+\/Resources\/Python\.app\/Contents\/MacOS\/Python(?:\s|$)/;
/** Terminal emulators and multiplexers: what runs inside them is the user's, wherever they are installed. */
const TERMINALS = new Set(["alacritty", "kitty", "wezterm", "wezterm-gui", "wezterm-mux-server", "ghostty", "iterm2", "terminal", "tmux", "screen", "zellij"]);
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
  /** The safe display name (KillRow.label). */
  name: string;
  /** Identity for re-validation only; never shown (see displayCommand). */
  argv: string;
  startedAt: string;
  cpuPercent: number;
}

export interface KillExclusion {
  pid: number;
  /** The safe display name (KillRow.label). */
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

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh"]);

/** argv[0]'s basename without a login shell's leading dash. */
function executable(row: Pick<KillRow, "argv">): string {
  const argv0 = row.argv.split(/\s/, 1)[0] ?? "";
  return (argv0.split("/").pop() ?? argv0).replace(/^-/, "");
}

export function isShell(row: Pick<KillRow, "argv">): boolean {
  return SHELLS.has(executable(row));
}

/** A shell reading a terminal: a login shell (`-zsh`), or one with neither `-c` nor a script. */
export function isInteractiveShell(row: Pick<KillRow, "argv">): boolean {
  if (!isShell(row)) return false;
  const [argv0 = "", ...args] = row.argv.split(/\s+/);
  if (argv0.startsWith("-")) return true;
  if (args.some((arg) => /^-[a-z]*c[a-z]*$/i.test(arg))) return false;
  return !args.some((arg) => !arg.startsWith("-"));
}

/**
 * Why a process ends a thread's claim, or null. A wall is never a target, and
 * nothing below it belongs to the thread either: an app launched from a
 * thread (Orca, VS Code, Docker) passes BB_THREAD_ID to its own terminals and
 * helpers, which are the user's, not the thread's.
 */
export function wallReason(row: KillRow, context: PlanContext): string | null {
  if (context.selfPids.has(row.pid)) return "Hotspot's own process or the BB host running it";
  if (isBbProcess(row)) return "BB itself";
  if (row.uid !== context.uid) return "owned by another user";
  if (SYSTEM_PATH.test(row.argv.split(/\s/, 1)[0] ?? "")) return "a system process";
  if (TERMINALS.has(executable(row).toLowerCase()) || TERMINALS.has(row.name.toLowerCase())) return "a terminal, not work the thread started";
  if (APP_BUNDLE.test(row.argv) && !HEADLESS.test(row.argv) && !INTERPRETER_BUNDLE.test(row.argv)) {
    return "an app, not work the thread started";
  }
  if (isInteractiveShell(row)) return "an interactive terminal shell";
  return null;
}

/** npx, `npm exec`, pnpm/yarn/bun dlx, bunx, uvx, `pipx run`, env: they start the thing they name. */
export function isPackageRunner(row: Pick<KillRow, "argv">): boolean {
  if (["npx", "pnpx", "bunx", "uvx", "env"].includes(executable(row))) return true;
  return /(?:^|[\s/])(?:npx-cli\.js|npm(?:-cli\.js)?\s+exec|pnpm(?:\.c?js)?\s+(?:dlx|exec)|yarn(?:\.c?js)?\s+dlx|bun\s+x|pipx\s+run)(?=\s|$)/.test(row.argv);
}

/**
 * One step down from a process in the agent chain: the child is still the
 * agent (`chain`), the start of the thread's work (`work`), or a helper the
 * agent runs for itself (`helper`: an MCP server, ripgrep). A shell or a
 * package runner in the chain is a wrapper, so what it starts is the next
 * link (npx → sh -c gemini → node gemini). A process that starts its own
 * executable again is relaunching itself (Gemini CLI's node → node).
 */
function hop(parent: KillRow, child: KillRow): "chain" | "work" | "helper" {
  if (isShell(parent) || isPackageRunner(parent)) return "chain";
  if (isShell(child)) return "work";
  if (executable(child) === executable(parent)) return "chain";
  return "helper";
}

/**
 * `sandbox-exec` (Codex runs every command under it) is transparent: it is
 * judged as the command it wraps, and what it starts is judged against the
 * agent above it, so a sandboxed work shell is work and the agent is not.
 */
export function isTransparentWrapper(row: Pick<KillRow, "argv">): boolean {
  return executable(row) === "sandbox-exec";
}

/** The command a transparent wrapper runs: from its first shell, or after `--`. */
function wrappedCommand(row: KillRow): KillRow {
  const shell = /\s(\/\S*\/(?:zsh|bash|sh|dash|fish)\s.*)$/.exec(row.argv)?.[1];
  const dashed = /\s--\s+(\S.*)$/.exec(row.argv)?.[1];
  const argv = shell ?? dashed;
  return argv === undefined ? row : { ...row, argv };
}

/** Who may claim a process for a kill, found by walking up to the nearest wall, BB or launchd. */
interface Ownership {
  /** The nearest thread id on the path, or null (none, or a wall was in the way). */
  threadId: string | null;
  /** The wall that ended the claim; the process itself when it is one. */
  wall: KillRow | null;
  /** The top of the path: launched by BB (`byBb`) or detached to launchd. */
  root: KillRow | null;
  byBb: boolean;
}

function ownershipOf(row: KillRow, byPid: Map<number, KillRow>, context: PlanContext): Ownership {
  const path: KillRow[] = [];
  const seen = new Set<number>();
  let byBb = false;
  for (let node: KillRow | undefined = row; node !== undefined && !seen.has(node.pid); ) {
    seen.add(node.pid);
    if (wallReason(node, context) !== null) return { threadId: null, wall: node, root: null, byBb: false };
    path.push(node);
    const parent: KillRow | undefined = node.ppid > 1 ? byPid.get(node.ppid) : undefined;
    if (parent !== undefined && (isBbProcess(parent) || context.selfPids.has(parent.pid))) {
      byBb = true;
      break;
    }
    node = parent;
  }
  const threadId = path.find((node) => node.threadId !== null)?.threadId ?? null;
  return { threadId, wall: null, root: path[path.length - 1] ?? null, byBb };
}

/**
 * Which of the thread's processes to signal, and which are spared and why.
 * Pure: the same table always yields the same plan.
 */
export function planKill(rows: readonly KillRow[], threadId: string, context: PlanContext): KillPlan {
  const byPid = new Map(rows.map((row) => [row.pid, row] as const));
  const owners = new Map(rows.map((row) => [row.pid, ownershipOf(row, byPid, context)] as const));
  const owner = (pid: number) => owners.get(pid)?.threadId ?? null;
  const members = rows.filter((row) => owner(row.pid) === threadId);
  const memberPids = new Set(members.map((row) => row.pid));

  // Under a process BB launched, walk down from it: everything up to the
  // first work shell is the agent, and its helpers are spared with them.
  const reasons = new Map<number, string>();
  for (const row of members) {
    const ownership = owners.get(row.pid);
    if (!ownership?.byBb || ownership.root === null) continue;
    if (ownership.root === row) {
      reasons.set(row.pid, "the thread's agent (launched by BB)");
      continue;
    }
    const path: KillRow[] = [];
    for (let node: KillRow | undefined = row; node !== undefined && node !== ownership.root && path.length < 64; node = byPid.get(node.ppid)) {
      path.push(node);
    }
    path.reverse();
    let parent = ownership.root;
    let role: "chain" | "work" | "helper" = "chain";
    for (const node of path) {
      if (isTransparentWrapper(node)) {
        // `-D NAME=value` can hide the wrapped command from argv; its child
        // shows what it runs.
        if (node === row) {
          const child = rows.find((candidate) => candidate.ppid === node.pid);
          role = hop(parent, child !== undefined && isShell(child) ? child : wrappedCommand(node));
        }
        continue;
      }
      role = hop(parent, node);
      if (role !== "chain") break;
      parent = node;
    }
    if (role === "chain") reasons.set(row.pid, "the thread's agent, or a launcher it runs through");
    if (role === "helper") reasons.set(row.pid, "a helper the agent runs for itself (MCP server or tool)");
  }
  // Processes the thread id reaches only through a wall are listed, not
  // targeted, so the plan says why a terminal or an app's helper is safe.
  const shadowed: KillExclusion[] = [];
  const attribution = attributeThreads([...rows]);
  for (const row of rows) {
    const wall = owners.get(row.pid)?.wall ?? null;
    if (wall === null || attribution.get(row.pid) !== threadId) continue;
    const reason = wall === row ? (wallReason(row, context) ?? "") : `under ${wall.label} (pid ${wall.pid}), which the thread does not own`;
    shadowed.push({ pid: row.pid, name: row.label, cpuPercent: row.cpuPercent, reason });
  }
  // A `bb` CLI call inside the thread: the other processes its shell runs
  // are the same command (a pipeline), not work to stop.
  for (const row of rows) {
    if (!isBbProcess(row) || context.selfPids.has(row.pid) || !memberPids.has(row.ppid)) continue;
    for (const sibling of members) {
      if (sibling.ppid === row.ppid && !reasons.has(sibling.pid)) {
        reasons.set(sibling.pid, "part of the same command as a bb CLI call");
      }
    }
  }
  // Killing a parent can take its child with it: spare every thread process
  // above a protected one, walls included.
  const guarded = [...reasons.keys(), ...rows.filter((row) => owners.get(row.pid)?.wall === row).map((row) => row.pid)];
  for (const pid of guarded) {
    let parent = byPid.get(byPid.get(pid)?.ppid ?? -1);
    const seen = new Set<number>([pid]);
    while (parent !== undefined && memberPids.has(parent.pid) && !seen.has(parent.pid)) {
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
      name: row.label,
      argv: row.argv,
      startedAt: row.startedAt,
      cpuPercent: row.cpuPercent,
    }));
  const excluded = [
    ...members
      .filter((row) => reasons.has(row.pid))
      .map((row) => ({ pid: row.pid, name: row.label, cpuPercent: row.cpuPercent, reason: reasons.get(row.pid) ?? "" })),
    ...shadowed,
  ];
  return { threadId, targets, excluded };
}

/** Same pid, same start time, same command line: the process the plan named. */
export function sameProcess(target: KillTarget, row: KillRow | undefined): row is KillRow {
  return row !== undefined && row.startedAt === target.startedAt && row.argv === target.argv;
}

/**
 * Whether `bb hotspot kill <threadId> --yes` was typed by a person. The CLI
 * handler runs in the server and cannot see the caller's stdin, so it finds
 * the calling `bb` process in the table: it must have a controlling terminal
 * and no provider bridge above it. An agent's shell has neither a terminal
 * nor, if a provider gives it one, a way out from under its bridge.
 */
export function checkInteractiveCaller(rows: readonly KillRow[], threadId: string): { ok: true } | { ok: false; reason: string } {
  const byPid = new Map(rows.map((row) => [row.pid, row] as const));
  const callers = rows.filter(
    (row) => isBbProcess(row) && /\bhotspot\s+kill\b/.test(row.argv) && row.argv.includes(threadId) && /\s--yes\b/.test(row.argv),
  );
  if (callers.length === 0) return { ok: false, reason: "could not find the calling bb process to check its terminal" };
  for (const caller of callers) {
    if (caller.tty === null) return { ok: false, reason: "it was not run from an interactive terminal" };
    const seen = new Set<number>();
    for (let node = byPid.get(caller.ppid); node !== undefined && !seen.has(node.pid); node = byPid.get(node.ppid)) {
      seen.add(node.pid);
      if (/bb-provider-bridge/.test(node.argv)) return { ok: false, reason: "it was run by an agent" };
    }
  }
  return { ok: true };
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
      const protectedNow = wallReason(row, deps.context) !== null;
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
