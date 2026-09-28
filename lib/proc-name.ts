/**
 * Every process name Hotspot shows, stores or returns: `node · vite`,
 * `node · next dev`, `node · tsc --watch`, `pnpm · test`, `vitest · worker`,
 * `python3 · pytest`, `Google Chrome`, `claude`. The drill-down, "Also busy
 * outside BB", stored samples and hot spells, kill plans and their results,
 * the CLI and the agent tool all use friendlyName; a kill plan's command
 * column uses displayCommand.
 *
 * Command lines carry secrets (`--otp 123456`, `-p hunter2`,
 * `Authorization: …`, URLs with credentials), and short ones look like any
 * other word. So names are built by allowlist, never by spotting secrets. A
 * word from the command line is shown only when it is:
 * - the executable: argv[0]'s basename, or an app bundle's executable when
 *   argv[0] is itself `…/X.app/Contents/MacOS/…`;
 * - for an interpreter, the file it runs (a path or a name with an
 *   extension, shown by basename or package), and only when every flag
 *   before it is on that interpreter's list; for `python -m`, a module on a
 *   known list;
 * - for a package runner, a subcommand on a fixed list and, after `run`, a
 *   script from a common vocabulary; for `npx` and `dlx`, a known package;
 * - after a tool, a verb on a fixed list, or `--watch`.
 * Anything else, and anything unsure, is the bare executable. The secret
 * test (looksSecret) is a second guard only. The environment is never read
 * and no flag value is ever shown.
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

/** How an interpreter's flags read: which take no value, which take one, which run inline code. */
interface FlagRules {
  valueless: ReadonlySet<string>;
  /** Flags that take exactly one value, skipped and never shown. */
  oneValue: ReadonlySet<string>;
  /** Flags that run inline code: there is no file to name. */
  code: ReadonlySet<string>;
  /** `python -m`: the module is what runs. */
  module?: string;
}

const NODE_FLAGS: FlagRules = {
  valueless: new Set([
    "--watch", "--inspect", "--inspect-brk", "--enable-source-maps", "--no-warnings", "--no-deprecation",
    "--trace-warnings", "--trace-deprecation", "--preserve-symlinks", "--expose-gc", "--experimental-strip-types",
    "--experimental-import-meta-resolve", "--experimental-vm-modules", "--experimental-transform-types",
    "--harmony", "--no-addons", "--frozen-intrinsics",
  ]),
  oneValue: new Set(["--conditions", "-C", "--require", "-r", "--import", "--loader", "--experimental-loader"]),
  code: new Set(["-e", "--eval", "-p", "--print"]),
};
const PYTHON_FLAGS: FlagRules = {
  valueless: new Set(["-u", "-B", "-E", "-s", "-S", "-O", "-OO", "-q", "-b", "-bb", "-I", "-P"]),
  oneValue: new Set(),
  code: new Set(["-c"]),
  module: "-m",
};
const RUBY_FLAGS: FlagRules = { valueless: new Set(["-w", "-v", "-d"]), oneValue: new Set(), code: new Set(["-e"]) };
const PERL_FLAGS: FlagRules = { valueless: new Set(["-w", "-T", "-t"]), oneValue: new Set(), code: new Set(["-e", "-E"]) };
const PHP_FLAGS: FlagRules = { valueless: new Set(["-q", "-n"]), oneValue: new Set(), code: new Set(["-r", "-R", "-B", "-E", "-F"]) };

/** Each interpreter's flag rules, by executable name. */
function interpreterFlags(exe: string): FlagRules | null {
  if (/^(?:node|nodejs|bun|deno|tsx|ts-node)$/.test(exe)) return NODE_FLAGS;
  if (/^python[0-9.]*$/.test(exe)) return PYTHON_FLAGS;
  if (exe === "ruby") return RUBY_FLAGS;
  if (exe === "perl") return PERL_FLAGS;
  if (exe === "php") return PHP_FLAGS;
  return null;
}

/** `python -m <module>` names only these. */
const PYTHON_MODULES = new Set([
  "http.server", "pytest", "uvicorn", "gunicorn", "pip", "venv", "unittest", "mypy", "black", "ruff", "flake8",
  "pylint", "django", "flask", "jupyter", "ipykernel", "IPython", "celery", "streamlit", "coverage",
]);
/** Package runners, whose first word is a subcommand. */
const RUNNERS = new Set(["npm", "pnpm", "yarn", "bun", "uv", "cargo", "go", "turbo", "nx"]);
/** Subcommands a runner's name may show. */
const RUNNER_SUBS = new Set([
  "run", "run-script", "exec", "dlx", "x", "test", "start", "install", "i", "ci", "add", "build", "dev", "watch",
  "serve", "preview", "lint", "check", "typecheck", "format", "sync", "pip",
]);
/** Runners of a package by name: `npx vite`. */
const PACKAGE_RUNNERS = new Set(["npx", "pnpx", "bunx", "uvx"]);
/** Packages `npx`, `dlx` and `exec` may name. */
const KNOWN_PACKAGES = new Set([
  "vite", "next", "tsc", "typescript", "vitest", "jest", "eslint", "prettier", "biome", "@biomejs/biome", "playwright",
  "@playwright/mcp", "@playwright/test", "tsx", "turbo", "nx", "astro", "nuxt", "remix", "storybook", "wrangler",
  "prisma", "drizzle-kit", "esbuild", "rollup", "webpack", "nodemon", "concurrently", "serve", "http-server",
  "create-next-app", "create-vite", "shadcn", "pytest", "ruff", "black",
]);
/** Words a package script's name may be made of (`test`, `dev:web`, `db:migrate`). */
const SCRIPT_WORDS = new Set([
  "dev", "start", "build", "test", "lint", "typecheck", "check", "watch", "serve", "preview", "format", "e2e",
  "storybook", "generate", "db", "migrate", "seed", "push", "studio", "reset", "unit", "integration", "web", "api",
  "ui", "ci", "all", "fix", "types", "server", "client", "app", "docs",
]);
/** `make` targets a name may show. */
const MAKE_TARGETS = new Set(["all", "build", "test", "check", "clean", "install", "dev", "run", "lint", "format", "release", "docs"]);
/** Subcommands worth naming after any other tool. Only these are ever shown. */
const VERBS = new Set([
  "dev", "start", "serve", "server", "preview", "build", "watch", "test", "lint", "check", "typecheck",
  "format", "compile", "bundle", "generate", "install", "i", "ci", "add", "run", "exec", "worker", "daemon",
  "app-server", "mcp", "proto", "status", "diff", "log", "fetch", "pull", "push", "clone", "commit",
]);
const WATCH = new Set(["--watch", "-w"]);
/** A script path's basename that says nothing: name its package directory instead. */
const GENERIC = new Set(["index", "cli", "main", "bin", "run", "start", "entry"]);
/** Directories between a package and its entry point. */
const LAYOUT_DIRS = new Set(["bin", "dist", "lib", "src", "build", "out", "cjs", "esm", "node_modules", ".bin"]);
const SCRIPT_EXT = /\.(?:[cm]?[jt]sx?|py|rb|pl|php|sh)$/;
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

/**
 * The name of a file an interpreter runs: only when the argument looks like
 * a file (a path, or a name with a known extension), by its basename
 * without extension, or its package's directory for `index.js` and the like.
 */
function scriptName(token: string): string | null {
  if (/[=]|:\/\//.test(token) || !(token.includes("/") || SCRIPT_EXT.test(token))) return null;
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

/** A flag's name without an inline `=value`. */
const flagName = (token: string) => {
  const equals = token.indexOf("=");
  return equals === -1 ? token : token.slice(0, equals);
};

/**
 * What an interpreter runs: the index of its file, or of a `-m` module, or
 * -1 when there is none, it runs inline code, or a flag before it is not on
 * the interpreter's list.
 */
function runIndex(tokens: readonly string[], rules: FlagRules): { at: number; module: boolean } {
  const none = { at: -1, module: false };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("-")) return { at: index, module: false };
    const name = flagName(token);
    const inline = name !== token;
    if (rules.code.has(name)) return none;
    if (rules.module !== undefined && name === rules.module) {
      return inline ? none : index + 1 < tokens.length ? { at: index + 1, module: true } : none;
    }
    if (rules.oneValue.has(name)) {
      if (!inline) index += 1;
    } else if (!rules.valueless.has(name) && !(inline && name.startsWith("--"))) return none;
  }
  return none;
}

/** `--watch`, or a known verb, or nothing. */
const subcommand = (token: string | undefined): string | null =>
  token !== undefined && (VERBS.has(token) || WATCH.has(token)) ? token : null;

/** A package script name made only of common words: `test`, `dev:web`, `db:migrate`. */
const commonScript = (token: string | undefined): string | null =>
  token !== undefined && token.split(":").every((word) => SCRIPT_WORDS.has(word)) ? token : null;

const knownPackage = (token: string | undefined): string | null =>
  token !== undefined && KNOWN_PACKAGES.has(token) ? token : null;

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

/** A runner's name: `pnpm · test`, `npm · dev` for `npm run dev`, `pnpm · vite` for `pnpm dlx vite`, else `npm · run` or `npm`. */
function runnerName(exe: string, tokens: readonly string[]): string {
  const sub = tokens[0];
  if (sub === undefined || !RUNNER_SUBS.has(sub)) return exe;
  if (sub === "run" || sub === "run-script") {
    const script = commonScript(tokens[1]);
    return `${exe} · ${script ?? sub}`;
  }
  if (sub === "exec" || sub === "dlx" || sub === "x") return `${exe} · ${knownPackage(tokens[1]) ?? sub}`;
  return `${exe} · ${sub}`;
}

/** The name for a command line without its environment (see the module note). */
export function friendlyName(argv: string): string {
  const { exe, tokens } = executable(argv);
  // `bun run dev` and `bun test` are a runner; `bun app.ts` an interpreter.
  if (RUNNERS.has(exe) && (exe !== "bun" || RUNNER_SUBS.has(tokens[0] ?? ""))) return cap(runnerName(exe, tokens));
  const rules = interpreterFlags(exe);
  if (rules !== null) {
    const { at, module } = runIndex(tokens, rules);
    if (at === -1) return exe;
    if (module) return PYTHON_MODULES.has(tokens[at]) ? cap(`${exe} · ${tokens[at]}`) : exe;
    const worker = packageWorker(tokens[at]);
    if (worker !== null) return cap(worker);
    const script = scriptName(tokens[at]);
    if (script === null) return exe;
    const sub = subcommand(tokens[at + 1]);
    return cap(`${exe} · ${sub === null ? script : `${script} ${sub}`}`);
  }
  if (PACKAGE_RUNNERS.has(exe)) {
    const name = knownPackage(tokens[0]);
    return cap(name === null ? exe : `${exe} · ${name}`);
  }
  if (exe === "make") {
    const target = tokens[0] !== undefined && MAKE_TARGETS.has(tokens[0]) ? tokens[0] : null;
    return target === null ? exe : `${exe} ${target}`;
  }
  const sub = subcommand(tokens[0]);
  return cap(sub === null ? exe : `${exe} ${sub}`);
}

/** A flag's name: `--long-name` in lower case, or a single-letter `-p`. Never `-phunter2`. */
const FLAG_NAME = /^(?:--[a-z][a-z0-9-]{0,30}|-[A-Za-z])$/;
const COMMAND_CHARS = 200;

/**
 * A kill plan's command column: the name, then the flags that come before
 * the first other argument, by name, each value as `…`, and `…` for the
 * rest. `node --inspect /repo/vite.js --port 5173` reads
 * `node · vite --inspect …`; `npm --otp 123456 publish` reads `npm --otp …`.
 * The kill itself checks the real command line on the server.
 */
export function displayCommand(argv: string): string {
  const { tokens } = executable(argv);
  const shown = [friendlyName(argv)];
  for (const token of tokens) {
    const name = flagName(token);
    if (!FLAG_NAME.test(name)) {
      shown.push("…");
      break;
    }
    shown.push(name === token ? name : `${name}=…`);
  }
  const text = shown.join(" ");
  return text.length <= COMMAND_CHARS ? text : `${text.slice(0, COMMAND_CHARS - 1)}…`;
}
