/**
 * A short, safe name for a process in a thread's drill-down: `node · vite`,
 * `node · next dev`, `pnpm · test`, `tsc --watch`, `claude`.
 *
 * Command lines carry secrets (`--token …`, `Authorization: …`, URLs with
 * credentials), and this name is shown in the UI, printed by the CLI and
 * given to agents. So it is built only from pieces that pass strict tests,
 * never copied from the command line:
 * - the executable's basename (processName);
 * - for an interpreter or package runner, the script or package it runs: a
 *   basename of the first argument that is not a flag, kept only if it is a
 *   short plain word that does not look like a key;
 * - a subcommand only from a fixed list of common verbs (`dev`, `test`,
 *   `build`, …), and `--watch`/`-w`.
 * The environment is never read, flag values are never shown, and anything
 * that fails a test is dropped rather than shortened.
 */
import { processName, splitArgv0 } from "./procs";

/** Runs a script file: the name is `<exe> · <script>`. */
const INTERPRETERS = /^(?:node|nodejs|bun|deno|python[0-9.]*|ruby|perl|php|tsx|ts-node)$/;
/** Runs a package or script by name: the name is `<exe> · <script>`. */
const RUNNERS = new Set(["npm", "pnpm", "yarn", "npx", "pnpx", "bunx", "uv", "uvx", "cargo", "go", "make", "turbo", "nx"]);
/** Words a runner puts before the script it runs. */
const RUN_WORDS = new Set(["run", "run-script", "exec", "x", "dlx"]);
/** Subcommands worth naming after a tool. Only these are ever shown. */
const VERBS = new Set([
  "dev", "start", "serve", "server", "preview", "build", "watch", "test", "lint", "check", "typecheck",
  "format", "compile", "bundle", "generate", "install", "i", "ci", "add", "run", "exec", "worker", "daemon",
  "app-server", "mcp", "proto", "status", "diff", "log", "fetch", "pull", "push", "clone", "commit",
]);
const WATCH = new Set(["--watch", "-w"]);
/** Interpreter flags whose value is the next argument: skipped with it. */
const VALUE_FLAGS = new Set([
  "--conditions", "-C", "--require", "-r", "--import", "--loader", "--experimental-loader", "--env-file",
  "--title", "--input-type", "--inspect-port", "--max-old-space-size", "--stack-size", "-W", "-X",
]);
/** Flags that run inline code: nothing after them is a script name. */
const CODE_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-c"]);
/** Flags whose value is itself the thing run (`python -m http.server`). */
const MODULE_FLAGS = new Set(["-m"]);

/** The index of the script an interpreter runs, or -1 (none, or inline code). */
function scriptIndex(tokens: readonly string[]): number {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (CODE_FLAGS.has(token)) return -1;
    if (MODULE_FLAGS.has(token)) return index + 1 < tokens.length ? index + 1 : -1;
    if (VALUE_FLAGS.has(token)) index += 1;
    else if (!token.startsWith("-")) return index;
  }
  return -1;
}
/** A script path's basename that says nothing: name its package directory instead. */
const GENERIC = new Set(["index", "cli", "main", "bin", "run", "start", "entry"]);
/** Directories between a package and its entry point. */
const LAYOUT_DIRS = new Set(["bin", "dist", "lib", "src", "build", "out", "cjs", "esm", "node_modules", ".bin"]);
const SCRIPT_EXT = /\.(?:[cm]?[jt]s|py|rb|sh)$/;
/** A plain word: letters, digits and a few joiners, short. */
const PLAIN = /^[A-Za-z0-9@][A-Za-z0-9@._+:-]{0,31}$/;
const MAX_CHARS = 40;

/** Key- or token-shaped: a known key prefix, a long letters-and-digits run, or anything very long. */
export function looksSecret(word: string): boolean {
  if (/^(?:sk|pk|rk)[-_]|^gh[pousr]_|^github_pat_|^xox[abprs]-|^AKIA|^ASIA|^eyJ|^glpat-|^npm_/i.test(word)) return true;
  if (word.length >= 24) return true;
  // 16+ characters mixing letters and digits with no separator reads as a hash or key.
  return word.length >= 16 && /\d/.test(word) && /[A-Za-z]/.test(word) && !/[-_.]/.test(word);
}

const safeWord = (word: string | null | undefined): string | null =>
  word != null && PLAIN.test(word) && !looksSecret(word) ? word : null;

/** A script argument's name: its basename without extension, or its package's directory for `index.js` and the like. */
function scriptName(token: string): string | null {
  if (/[=]|:\/\//.test(token)) return null;
  const parts = token.replace(/\/+$/, "").split("/");
  let index = parts.length - 1;
  let name = parts[index].replace(SCRIPT_EXT, "");
  if (GENERIC.has(name)) {
    for (index -= 1; index >= 0 && LAYOUT_DIRS.has(parts[index]); index -= 1);
    if (index >= 0 && parts[index] !== "") name = parts[index];
  }
  return safeWord(name);
}

/** `--watch`, or a known verb, or nothing. */
const subcommand = (token: string | undefined): string | null =>
  token !== undefined && (VERBS.has(token) || WATCH.has(token)) ? token : null;

const cap = (name: string) => (name.length <= MAX_CHARS ? name : `${name.slice(0, MAX_CHARS - 1)}…`);

/**
 * The executable's name and the arguments after it. Only a macOS app
 * bundle's executable may hold spaces (`Google Chrome`), and each of its
 * words must pass the secret test; anywhere else argv[0] ends at the first
 * space, so `tool <secret>` names `tool`.
 */
function executable(argv: string): { exe: string; tokens: string[] } {
  const split = /\.app\/Contents\//.test(argv) ? splitArgv0(argv) : null;
  const argv0 = split?.argv0 ?? argv.trim().split(/\s+/)[0] ?? "";
  const rest = split?.rest ?? argv.trim().slice(argv0.length);
  const words = processName(argv0).split(" ");
  const bad = words.findIndex((word) => looksSecret(word));
  const exe = (bad === -1 ? words : words.slice(0, bad)).join(" ") || "process";
  return { exe, tokens: rest.split(/\s+/).filter((token) => token !== "") };
}

/** The drill-down name for a command line without its environment (see the module note). */
export function friendlyName(argv: string): string {
  const { exe, tokens } = executable(argv);
  const join = (...parts: Array<string | null>) => parts.filter((part) => part !== null).join(" ");

  if (INTERPRETERS.test(exe)) {
    const at = scriptIndex(tokens);
    const script = at === -1 ? null : scriptName(tokens[at]);
    if (script === null) return cap(exe);
    return cap(`${exe} · ${join(script, subcommand(tokens[at + 1]))}`);
  }
  if (RUNNERS.has(exe)) {
    const words = tokens.filter((token) => !token.startsWith("-"));
    const first = RUN_WORDS.has(words[0] ?? "") ? words[1] : words[0];
    // A scoped package (`@playwright/mcp`) passes when both halves do.
    const scoped = /^(@[^/\s]+)\/([^/\s]+)$/.exec(first ?? "");
    const script = scoped === null ? safeWord(first) : safeWord(scoped[1]) && safeWord(scoped[2]) && first;
    return cap(script === null ? exe : `${exe} · ${script}`);
  }
  return cap(join(exe, subcommand(tokens[0])));
}
