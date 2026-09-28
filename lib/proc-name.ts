/**
 * Every process name Hotspot shows, stores or returns: `node · vite`,
 * `node · next dev`, `pnpm · test`, `tsc --watch`, `vitest · worker`,
 * `Google Chrome`, `claude`. The drill-down, "Also busy outside BB", stored
 * samples and hot spells, kill plans and their results, the CLI and the
 * agent tool all use friendlyName; a kill plan's command column uses
 * displayCommand.
 *
 * Command lines carry secrets (`--otp 123456`, `-p hunter2`,
 * `Authorization: …`, URLs with credentials), and short ones look like any
 * other word. So names are built by allowlist, never by spotting secrets:
 * - the executable: argv[0]'s basename, or an app bundle's executable when
 *   argv[0] is itself `…/X.app/Contents/MacOS/…`;
 * - for an interpreter, the script it runs, but only when every flag before
 *   it is one whose arity is known (valueless, `--name=value`, or one that
 *   takes exactly one value, which is skipped);
 * - for a package runner, the script or package named before any flag;
 * - a following subcommand only from a fixed list of verbs, or `--watch`.
 * Anything else, and anything unsure, is the bare executable. The
 * environment is never read and no flag value is ever shown.
 */

/**
 * argv[0] and the rest, the way the rules that recognise BB, terminals and
 * shells read it (lib/procs.ts, lib/kill.ts). `ps` joins argv with spaces and
 * macOS paths hold spaces, so argv[0] runs to the first space that starts a
 * flag, another path or a `VAR=value`. That can swallow arguments, so it is
 * never used for a name anyone sees.
 */
export function splitArgv0(command: string): { argv0: string; rest: string } {
  const boundary = /\s(?=[-/]|\S*=)/.exec(command);
  if (boundary === null) return { argv0: command.trim(), rest: "" };
  return { argv0: command.slice(0, boundary.index).trim(), rest: command.slice(boundary.index + 1).trim() };
}

/**
 * The rules' executable name (see splitArgv0): internal only, since it may
 * hold arguments. `/opt/homebrew/.../bin/node` reads `node`; the version in
 * `next-server (v16.3.4)` is dropped.
 */
export function processName(command: string): string {
  const { argv0 } = splitArgv0(command);
  const base = (argv0.split("/").pop() ?? argv0).trim();
  return base.replace(/\s*\([^)]*\)\s*$/, "") || argv0;
}

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
/** Interpreter flags known to take no value. */
const VALUELESS = new Set([
  "--watch", "--inspect", "--inspect-brk", "--enable-source-maps", "--no-warnings", "--no-deprecation",
  "--trace-warnings", "--trace-deprecation", "--preserve-symlinks", "--expose-gc", "--experimental-strip-types",
  "--experimental-import-meta-resolve", "--experimental-vm-modules", "--experimental-transform-types",
  "--harmony", "--no-addons", "--frozen-intrinsics",
  // python
  "-u", "-B", "-E", "-s", "-S", "-O", "-OO", "-q", "-bb",
]);
/** Interpreter flags known to take exactly one value, which is skipped, never shown. */
const ONE_VALUE = new Set(["--conditions", "-C", "--require", "-r", "--import", "--loader", "--experimental-loader"]);
/** Flags that run inline code: there is no script to name. */
const CODE_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-c"]);
/** `python -m http.server`: the module is what runs. */
const MODULE_FLAG = "-m";
/** A script path's basename that says nothing: name its package directory instead. */
const GENERIC = new Set(["index", "cli", "main", "bin", "run", "start", "entry"]);
/** Directories between a package and its entry point. */
const LAYOUT_DIRS = new Set(["bin", "dist", "lib", "src", "build", "out", "cjs", "esm", "node_modules", ".bin"]);
const SCRIPT_EXT = /\.(?:[cm]?[jt]s|py|rb|sh)$/;
/** A plain word: letters, digits and a few joiners, short. */
const PLAIN = /^[A-Za-z0-9@][A-Za-z0-9@._+:-]{0,31}$/;
const MAX_CHARS = 40;

/**
 * Key- or token-shaped. A second line of defence only: short passwords pass
 * it, so no name relies on it.
 */
export function looksSecret(word: string): boolean {
  if (/^(?:sk|pk|rk)[-_]|^gh[pousr]_|^github_pat_|^xox[abprs]-|^AKIA|^ASIA|^eyJ|^glpat-|^npm_/i.test(word)) return true;
  if (word.length >= 24) return true;
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

/**
 * A package's worker script (`…/node_modules/vitest/dist/workers/forks.js`)
 * as `vitest · worker`; null for anything else.
 */
function packageWorker(token: string): string | null {
  const match = /\/node_modules\/((?:@[^/\s]+\/)?[^/\s]+)\/(?:\S*\/)?workers?\/[^/\s]+$/.exec(token);
  if (match === null) return null;
  return match[1].split("/").every((half) => safeWord(half) !== null) ? `${match[1]} · worker` : null;
}

/**
 * Where an interpreter's script is: the index of its path, or -1 when there
 * is none, it is inline code, or a flag before it is not one whose arity is
 * known.
 */
function scriptIndex(tokens: readonly string[]): number {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("-")) return index;
    if (token === MODULE_FLAG) return index + 1 < tokens.length ? index + 1 : -1;
    if (ONE_VALUE.has(token)) index += 1;
    else if (!VALUELESS.has(token) && !/^--[a-z][a-z0-9-]*=/.test(token)) return -1;
  }
  return -1;
}

/** `--watch`, or a known verb, or nothing. */
const subcommand = (token: string | undefined): string | null =>
  token !== undefined && (VERBS.has(token) || WATCH.has(token)) ? token : null;

const cap = (name: string) => (name.length <= MAX_CHARS ? name : `${name.slice(0, MAX_CHARS - 1)}…`);

const APP_EXECUTABLE = ".app/Contents/MacOS/";

/**
 * The executable's name and the arguments after it. argv[0] ends at the
 * first space, except when argv[0] is an app bundle's executable
 * (`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`): then it
 * runs through the bundle's own name, and only the bundle's path may hold
 * spaces.
 */
function executable(argv: string): { exe: string; tokens: string[] } {
  const text = argv.trim();
  const tokensOf = (rest: string) => rest.split(/\s+/).filter((token) => token !== "");
  const at = text.indexOf(APP_EXECUTABLE);
  const bundlePath = at === -1 ? "" : text.slice(0, at);
  // argv[0] must be one absolute path up to the bundle: no space that starts a flag or another path.
  if (at !== -1 && bundlePath.startsWith("/") && !/\s[-/]/.test(bundlePath)) {
    const bundle = bundlePath.slice(bundlePath.lastIndexOf("/") + 1);
    const after = text.slice(at + APP_EXECUTABLE.length);
    // The executable is named after its bundle; otherwise it ends at the first space.
    const name = after === bundle || after.startsWith(`${bundle} `) ? bundle : (after.split(/\s/, 1)[0] ?? "");
    const exe = name.replace(/\s*\([^)]*\)\s*$/, "").trim();
    return { exe: exe === "" ? "process" : exe, tokens: tokensOf(after.slice(name.length)) };
  }
  const argv0 = text.split(/\s+/, 1)[0] ?? "";
  const exe = safeWord((argv0.split("/").pop() ?? argv0).replace(/^-/, "")) ?? "process";
  return { exe, tokens: tokensOf(text.slice(argv0.length)) };
}

/** The name for a command line without its environment (see the module note). */
export function friendlyName(argv: string): string {
  const { exe, tokens } = executable(argv);
  if (INTERPRETERS.test(exe)) {
    const at = scriptIndex(tokens);
    if (at === -1 || CODE_FLAGS.has(tokens[at - 1] ?? "")) return exe;
    const worker = packageWorker(tokens[at]);
    if (worker !== null) return cap(worker);
    const script = scriptName(tokens[at]);
    if (script === null) return exe;
    const sub = subcommand(tokens[at + 1]);
    return cap(`${exe} · ${sub === null ? script : `${script} ${sub}`}`);
  }
  if (RUNNERS.has(exe)) {
    // Only what comes before the first flag: a flag's value is never a name.
    const first = RUN_WORDS.has(tokens[0] ?? "") ? tokens[1] : tokens[0];
    if (first === undefined || first.startsWith("-")) return exe;
    // A scoped package (`@playwright/mcp`) passes when both halves do.
    const scoped = /^(@[^/\s]+)\/([^/\s]+)$/.exec(first);
    const script = scoped === null ? safeWord(first) : safeWord(scoped[1]) && safeWord(scoped[2]) && first;
    return cap(script === null ? exe : `${exe} · ${script}`);
  }
  const sub = subcommand(tokens[0]);
  return cap(sub === null ? exe : `${exe} ${sub}`);
}

/** A flag's name: `--long-name` in lower case, or a single-letter `-p`. Never `-phunter2`. */
const FLAG_NAME = /^(?:--[a-z][a-z0-9-]{0,30}|-[A-Za-z])$/;
const COMMAND_CHARS = 200;

/**
 * A kill plan's command column: the name, then the flags by name, with every
 * value and every other argument shown as `…`. `node /repo/vite.js --port
 * 5173 --token abc` reads `node · vite --port … --token …`. The kill itself
 * checks the real command line on the server.
 */
export function displayCommand(argv: string): string {
  const { tokens } = executable(argv);
  const shown = [friendlyName(argv)];
  for (const token of tokens) {
    const equals = token.indexOf("=");
    const flag = equals === -1 ? token : token.slice(0, equals);
    const part = FLAG_NAME.test(flag) ? (equals === -1 ? flag : `${flag}=…`) : "…";
    if (part === "…" && shown[shown.length - 1] === "…") continue;
    shown.push(part);
  }
  const text = shown.join(" ");
  return text.length <= COMMAND_CHARS ? text : `${text.slice(0, COMMAND_CHARS - 1)}…`;
}
