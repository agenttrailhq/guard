// cspell:words fsmonitor tasklist SYSTEMROOT automount Statting textconv pathspec PATHSPEC
/**
 * `VerifyIO` — the read-only seam `scan --verify` checks this machine through.
 *
 * ── What it can do, and nothing else ─────────────────────────────────────────
 *  - run `git` with an argument list from `GIT_ALLOW_LIST`, exactly, or with a slot filled by
 *    a value of the slot's one shape (a hex commit id, a `:(literal)` relative path);
 *  - say which agent apps are running, by id, from a process list reduced to those ids here;
 *  - tell whether a path is a folder;
 *  - read one file of at most `MAX_FILE_BYTES`, inside a repo a `git rev-parse` call returned,
 *    or a Markdown instruction or memory file inside an agent's own folder (`AGENT_FOLDERS`).
 *
 * It writes nothing, and it reaches no network: the allow-listed `git` calls read the local
 * repository only.
 *
 * ── How `git` is run ─────────────────────────────────────────────────────────
 * Through `execFile`, never a shell, so no argument is ever shell syntax, and by ABSOLUTE path:
 * `git`, `ps` and `tasklist` are each found once, in the absolute folders on `PATH` only. A
 * bare name would let the operating system look in the call's working directory first (Windows
 * does), and a relative `PATH` entry would do the same anywhere, so a repository that commits
 * its own `git` could have it run. A program found inside the folder a call runs in is refused,
 * and a program not found reads as missing. Every call carries `GIT_SAFETY_ARGS`, which stop a
 * repository's own config from starting a program: no file-system monitor, no pager, no
 * external diff tool, no signature program for a signed commit that `log` or `stash list`
 * reads. The environment is built fresh rather
 * than inherited, so a `GIT_DIR`, `GIT_CONFIG_*` or `GIT_SSH_COMMAND` in the caller's shell
 * never reaches it, and it sets `GIT_OPTIONAL_LOCKS=0` (no index refresh is written) and
 * `GIT_TERMINAL_PROMPT=0` (nothing waits for a password).
 *
 * ── Network paths are not touched ────────────────────────────────────────────
 * A working directory named in a transcript can be a network share (`\\host\share`,
 * `//host/share`) or an automount (`/net/…`, `/Network/…`). Statting it or running `git` in
 * it would reach the network, so such a path reads as not there, and nothing runs in it.
 *
 * ── How a file is read ───────────────────────────────────────────────────────
 * Opened once, without following a final link and without blocking, then checked through
 * the open descriptor: anything that is not a regular file is refused, and at most
 * `MAX_FILE_BYTES` + 1 bytes are read, so a pipe swapped in or a file that grew after the
 * check can neither hang the scan nor slip past the size cap.
 *
 * ── Limits, and what a failure means ─────────────────────────────────────────
 * Each call has `CALL_TIMEOUT_MS` and an output cap of `MAX_OUTPUT_BYTES`, and all calls share
 * `TOTAL_BUDGET_MS`, together with the reads and the in-process search a caller charges to it. A call that times out, overflows, is refused or fails comes back as a
 * `CheckFailure`, which every check turns into could-not-check. Nothing here throws.
 *
 * Kept out of `ScanIO` so the browser opener stays the only process that seam starts, and out
 * of the hook's import graph: `bundle-graph.test.ts` checks both.
 */

import { execFile } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, posix, relative, win32 } from "node:path";
import { TUNNEL_PROCESS_NAMES } from "./core/verify/command-facts.js";
import { isNetworkPath } from "./core/verify/paths.js";
import {
  type CheckFailure,
  type FileOutcome,
  type GitOutcome,
  type ProcessOutcome,
  type VerifyIO,
  WATCHED_PROCESSES,
  type WatchedProcess,
} from "./core/verify/types.js";

/**
 * A place in an allow-listed argument list that takes a value from a check, and the one shape
 * that value may have.
 *
 * - `sha`: a commit id read from a command's output: 7 to 64 lower-case hex digits.
 * - `literal-path`: a path inside the folder `git` runs in, as a `:(literal)` pathspec, so no
 *   character in it is a wildcard or a pathspec option. Relative, with no `..` part, no line
 *   break and no NUL, and never starting with `-`.
 */
export interface GitArgSlot {
  readonly slot: "sha" | "literal-path";
}

/** One argument of an allow-listed call: a fixed word, or a slot. */
export type GitAllowedArg = string | GitArgSlot;

/** A commit id slot. */
const SHA: GitArgSlot = { slot: "sha" };

/** A literal path slot. */
const LITERAL_PATH: GitArgSlot = { slot: "literal-path" };

/**
 * The `git` argument lists verification may run. A fixed word must match exactly, and a slot
 * only a value of its shape (`slotAccepts`). Every one reads, and none writes.
 */
export const GIT_ALLOW_LIST: readonly (readonly GitAllowedArg[])[] = [
  ["rev-parse", "--show-toplevel"],
  ["ls-files", "-z"],
  // The git-backed checks: skipped hooks, lost work, deleted files.
  // The hooks folder in effect, after `core.hooksPath`, and the folder git keeps for the
  // repository, whose `hooks` folder is the default one.
  ["rev-parse", "--git-path", "hooks"],
  ["rev-parse", "--git-common-dir"],
  // Whether a commit is still in the object store, and its full id. Exit 0 either way: a
  // missing id prints nothing.
  ["log", "--no-walk", "--ignore-missing", "--format=%H", SHA],
  // Which of origin/main and origin/master exist.
  ["for-each-ref", "--format=%(refname)", "refs/remotes/origin/main", "refs/remotes/origin/master"],
  // Whether a commit is on origin/main or origin/master.
  [
    "for-each-ref",
    "--contains",
    SHA,
    "--format=%(refname)",
    "refs/remotes/origin/main",
    "refs/remotes/origin/master",
  ],
  // Whether a commit is on any branch or tag.
  [
    "for-each-ref",
    "--contains",
    SHA,
    "--format=%(refname)",
    "refs/heads",
    "refs/remotes",
    "refs/tags",
  ],
  // The commits in the stash list now.
  ["stash", "list", "--format=%H"],
  // The tracked files under a path, and those of them missing from the working tree.
  ["ls-files", "-z", "--", LITERAL_PATH],
  ["ls-files", "--deleted", "-z", "--", LITERAL_PATH],
  // Unreviewed code: the commits a push carried, those reachable from the new id and not from
  // the old one.
  ["log", "--format=%H", "--max-count=1000", SHA, "--not", SHA],
];

/** The `:(literal)` pathspec magic a `literal-path` slot starts with. */
export const LITERAL_PATHSPEC = ":(literal)";

/** Does `value` have the one shape `slot` allows? */
export function slotAccepts(slot: GitArgSlot, value: string): boolean {
  if (slot.slot === "sha") return /^[0-9a-f]{7,64}$/.test(value);
  if (!value.startsWith(LITERAL_PATHSPEC)) return false;
  const path = value.slice(LITERAL_PATHSPEC.length);
  return (
    path !== "" &&
    !path.startsWith("-") &&
    !path.startsWith("/") &&
    !/^[A-Za-z]:/.test(path) &&
    !/[\0\r\n\\]/.test(path) &&
    !path.split("/").includes("..")
  );
}

/**
 * Put before every allow-listed call, so a repository's config, or the user's own, cannot
 * start a program through a read-only command:
 *  - `core.fsmonitor=false`: no file-system monitor, which even `ls-files` starts;
 *  - `core.pager=cat` and `--no-pager`: no pager;
 *  - `diff.external=`: no external diff program;
 *  - `log.showSignature=false`: no `gpg.program` (or `gpg.ssh.program`) run to check a signed
 *    commit, which `log` and `stash list` would otherwise do for any commit carrying a
 *    signature header.
 * Reviewed and not needed for a read-only form: `core.sshCommand`, `core.askPass` and
 * `credential.helper` run only to reach a remote; `diff.<driver>.textconv` and
 * `filter.<driver>.*` run only when file content is diffed, checked out or added; hooks run
 * only for commands that change the repository. None of the allow-listed forms does those.
 */
export const GIT_SAFETY_ARGS: readonly string[] = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.pager=cat",
  "-c",
  "diff.external=",
  "-c",
  "log.showSignature=false",
  "--no-pager",
];

/** Longest one call may run. */
export const CALL_TIMEOUT_MS = 5_000;

/** Longest all calls together may run. */
export const TOTAL_BUDGET_MS = 60_000;

/** Most output one call may produce. */
export const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Largest file `readFile` reads. */
export const MAX_FILE_BYTES = 1024 * 1024;

/**
 * Most process-list entries read. A longer list is not cut short and read as complete: it is
 * `too-large`, so a process not seen in it is unknown, never "not running".
 */
export const MAX_PROCESS_ENTRIES = 65_536;

/**
 * Is `args` one of the allow-listed argument lists: the same length, every fixed word equal,
 * and every slot filled by a value of its shape?
 */
export function isAllowedGitCall(args: readonly string[]): boolean {
  return GIT_ALLOW_LIST.some(
    (allowed) =>
      allowed.length === args.length &&
      allowed.every((arg, i) => {
        const value = args[i] as string;
        return typeof arg === "string" ? arg === value : slotAccepts(arg, value);
      }),
  );
}

/** Variables carried over from the caller's environment. Everything else is left behind. */
const KEPT_VARIABLES = [
  "PATH",
  "Path",
  "HOME",
  "USERPROFILE",
  "SystemRoot",
  "SYSTEMROOT",
  "TMPDIR",
  "TEMP",
  "TMP",
];

/** The environment a `git` call runs in. See "How `git` is run". */
export function gitEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    LANG: "C",
  };
  for (const key of KEPT_VARIABLES) {
    const value = env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** The options every process is started with. */
export interface ExecOptions {
  readonly cwd?: string;
  readonly env: Record<string, string>;
  readonly timeout: number;
  readonly maxBuffer: number;
  readonly shell: false;
  readonly windowsHide: true;
  readonly encoding: "utf8";
}

/** How a started process ended. */
export type ExecResult =
  | { readonly kind: "ok"; readonly stdout: string }
  | { readonly kind: "exit"; readonly code: number; readonly stderr: string }
  | { readonly kind: "timeout" }
  | { readonly kind: "too-large" }
  | { readonly kind: "missing" }
  | { readonly kind: "failed" };

/** Starts a process. The real one wraps `execFile`; tests pass their own. */
export type Exec = (
  file: string,
  args: readonly string[],
  options: ExecOptions,
) => Promise<ExecResult>;

/** `execFile`, with every way it can end turned into an `ExecResult`. */
export const realExec: Exec = (file, args, options) =>
  new Promise((resolve) => {
    try {
      execFile(file, [...args], options, (error, stdout, stderr) => {
        if (error === null) {
          resolve({ kind: "ok", stdout: String(stdout) });
          return;
        }
        const failure = error as NodeJS.ErrnoException & { killed?: boolean };
        if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") resolve({ kind: "too-large" });
        else if (failure.code === "ENOENT") resolve({ kind: "missing" });
        else if (failure.killed === true) resolve({ kind: "timeout" });
        else if (typeof failure.code === "number") {
          resolve({ kind: "exit", code: failure.code, stderr: String(stderr) });
        } else resolve({ kind: "failed" });
      });
    } catch {
      resolve({ kind: "failed" });
    }
  });

/**
 * The watched process one entry of a process list is, or `undefined`.
 *
 * `comm` is not always an image name: a program can rewrite its title (`postgres: <role> <db>
 * …`, `Cursor Helper (Plugin): <id> (agent-exec)`). So the entry is cut at the first `": "`,
 * then to its last path part, lower-cased and stripped of `.exe`, and only an exact match to an
 * agent app's process name is kept. Nothing else from the entry survives this function.
 */
export function watchedProcessOf(entry: string): WatchedProcess | undefined {
  const title = entry.trim().split(": ")[0] ?? "";
  const name = (title.split(/[\\/]/).pop() ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.exe$/, "");
  if (name === "claude") return "claude";
  if (name === "codex") return "codex";
  // The Cursor app and its helpers, and the Cursor CLI, `cursor-agent`.
  if (/^cursor(?: helper(?: \([a-z ]+\))?)?$/.test(name) || name === "cursor-agent") {
    return "cursor";
  }
  if ((TUNNEL_PROCESS_NAMES as readonly string[]).includes(name)) return name as WatchedProcess;
  return undefined;
}

/**
 * The watched processes in a list of lines, each once, in `WATCHED_PROCESSES` order, or
 * `too-large` when the list has more entries than `MAX_PROCESS_ENTRIES`: a list read only in
 * part never reads as complete.
 */
function watchedIn(lines: readonly string[], entryOf: (line: string) => string): ProcessOutcome {
  const entries = lines.filter((line) => line.trim() !== "");
  if (entries.length > MAX_PROCESS_ENTRIES) return { ok: false, reason: "too-large" };
  const seen = new Set<WatchedProcess>();
  for (const entry of entries) {
    const id = watchedProcessOf(entryOf(entry));
    if (id !== undefined) seen.add(id);
  }
  return { ok: true, running: WATCHED_PROCESSES.filter((id) => seen.has(id)) };
}

/** The watched processes in `ps -axo comm=` output: one entry per line. */
export function watchedInPs(stdout: string): ProcessOutcome {
  return watchedIn(stdout.split(/\r?\n/), (line) => line);
}

/** The watched processes in `tasklist /fo csv /nh` output: the first quoted field per line. */
export function watchedInTasklist(stdout: string): ProcessOutcome {
  return watchedIn(stdout.split(/\r?\n/), (line) => /^"([^"]*)"/.exec(line.trim())?.[1] ?? "");
}

/** Is `path` inside `root` (and not `root` itself)? Both are real paths. */
function isInside(
  root: string,
  path: string,
  paths: { relative: typeof relative; isAbsolute: typeof isAbsolute } = { relative, isAbsolute },
): boolean {
  const rel = paths.relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !paths.isAbsolute(rel);
}

export { isNetworkPath };

/** Is `path` a regular file this process may execute? */
function defaultIsExecutable(platform: string): (path: string) => boolean {
  return (path) => {
    try {
      if (!statSync(path).isFile()) return false;
      if (platform !== "win32") accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * The absolute path of `name` on `PATH`, or `undefined`.
 *
 * Only absolute entries are searched: an empty or relative entry names the working directory
 * of whatever runs next, which is a folder a transcript chose. On Windows the program is
 * `<name>.exe` and entries are split on `;`; a `.cmd` or `.bat` would need a shell to run.
 */
export function resolveProgram(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
  isExecutable: (path: string) => boolean,
): string | undefined {
  const paths = platform === "win32" ? win32 : posix;
  const file = platform === "win32" ? `${name}.exe` : name;
  for (const entry of (env.PATH ?? env.Path ?? "").split(paths.delimiter)) {
    if (entry === "" || !paths.isAbsolute(entry) || isNetworkPath(entry)) continue;
    const candidate = paths.join(entry, file);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The agents' own folders under the home folder. `readFile` may read an instruction or memory
 * file in one of these (`AGENT_FILE`), and nothing else in them.
 */
export const AGENT_FOLDERS: readonly string[] = [".claude", ".codex", ".cursor"];

/** The files `readFile` may read in an agent's own folder: Markdown instructions and memory. */
export const AGENT_FILE = /\.mdc?$/i;

/** The real paths of the agents' own folders that exist under `home`. */
function agentRoots(home: string | undefined): string[] {
  if (home === undefined || home === "" || isNetworkPath(home)) return [];
  const roots: string[] = [];
  for (const folder of AGENT_FOLDERS) {
    try {
      roots.push(realpathSync(join(home, folder)));
    } catch {
      // Not there: nothing to read in it.
    }
  }
  return roots;
}

/** What `createRealVerifyIO` may be given. Production passes nothing. */
export interface VerifyIOOptions {
  readonly exec?: Exec;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: string;
  /** A clock in milliseconds, for the budget. */
  readonly now?: () => number;
  readonly callTimeoutMs?: number;
  readonly totalBudgetMs?: number;
  /** Whether a path is a program that may be run. For tests that place their own `PATH`. */
  readonly isExecutable?: (path: string) => boolean;
}

/** The real `VerifyIO`. Created only when `scan --verify` runs. */
export function createRealVerifyIO(options: VerifyIOOptions = {}): VerifyIO {
  const exec = options.exec ?? realExec;
  const callerEnv = options.env ?? process.env;
  const env = gitEnvironment(callerEnv);
  // Found on the first read that needs them.
  let agents: string[] | undefined;
  const platform = options.platform ?? process.platform;
  const isExecutable = options.isExecutable ?? defaultIsExecutable(platform);
  // Each program's absolute path, found once. `null` when it is not on `PATH`.
  const programs = new Map<string, string | null>();
  const programPath = (name: string): string | undefined => {
    if (!programs.has(name)) {
      programs.set(name, resolveProgram(name, callerEnv, platform, isExecutable) ?? null);
    }
    return programs.get(name) ?? undefined;
  };
  // One buffer for every file read: reads are synchronous, so it is never shared.
  let scratch: Buffer | undefined;
  const now = options.now ?? (() => Date.now());
  const callTimeout = options.callTimeoutMs ?? CALL_TIMEOUT_MS;
  const budget = options.totalBudgetMs ?? TOTAL_BUDGET_MS;
  // Real paths of the repos `rev-parse --show-toplevel` has returned. `readFile` reads under
  // these and nowhere else.
  const roots = new Set<string>();
  let spent = 0;

  /** Run one process within the budget. */
  const run = async (
    file: string,
    args: readonly string[],
    cwd: string | undefined,
  ): Promise<ExecResult | CheckFailure> => {
    const left = budget - spent;
    if (left <= 0) return "budget";
    const started = now();
    const result = await exec(file, args, {
      ...(cwd === undefined ? {} : { cwd }),
      env,
      timeout: Math.min(callTimeout, left),
      maxBuffer: MAX_OUTPUT_BYTES,
      shell: false,
      windowsHide: true,
      encoding: "utf8",
    });
    spent += Math.max(0, now() - started);
    return result;
  };

  /** An `ExecResult` that is not `ok`, as a `CheckFailure`. */
  const failureOf = (result: Exclude<ExecResult, { kind: "ok" }>): CheckFailure => {
    switch (result.kind) {
      case "timeout":
        return "timeout";
      case "too-large":
        return "too-large";
      case "missing":
        return "missing";
      case "exit":
        return result.code === 128 && /not a git repository/i.test(result.stderr)
          ? "not-a-repo"
          : "failed";
      default:
        return "failed";
    }
  };

  return {
    async git(cwd: string, args: readonly string[]): Promise<GitOutcome> {
      if (!isAllowedGitCall(args) || isNetworkPath(cwd)) return { ok: false, reason: "refused" };
      const git = programPath("git");
      if (git === undefined) return { ok: false, reason: "missing" };
      // A `git` that sits inside the folder it would run in could be the repository's own.
      const paths = platform === "win32" ? win32 : posix;
      const from = paths.resolve(cwd);
      if (paths.resolve(git) === from || isInside(from, paths.resolve(git), paths)) {
        return { ok: false, reason: "refused" };
      }
      const result = await run(git, [...GIT_SAFETY_ARGS, ...args], cwd);
      if (typeof result === "string") return { ok: false, reason: result };
      if (result.kind !== "ok") return { ok: false, reason: failureOf(result) };
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        try {
          roots.add(realpathSync(result.stdout.trim()));
        } catch {
          return { ok: false, reason: "failed" };
        }
      }
      return { ok: true, stdout: result.stdout };
    },

    isDirectory(path: string): boolean | undefined {
      if (isNetworkPath(path)) return undefined;
      try {
        return statSync(path).isDirectory();
      } catch {
        return undefined;
      }
    },

    pathExists(path: string): boolean | undefined {
      if (isNetworkPath(path)) return undefined;
      try {
        statSync(path);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return code === "ENOENT" || code === "ENOTDIR" ? false : undefined;
      }
    },

    readFile(path: string): Promise<FileOutcome> {
      if (spent >= budget) return Promise.resolve({ ok: false, reason: "budget" });
      if (isNetworkPath(path)) return Promise.resolve({ ok: false, reason: "refused" });
      const started = now();
      let fd: number | undefined;
      try {
        // The REAL path is what is checked, so a link inside a repo that points out of it is
        // refused rather than followed.
        const real = realpathSync(path);
        const inRepo = [...roots].some((root) => isInside(root, real));
        if (!inRepo) {
          agents ??= agentRoots(callerEnv.HOME ?? callerEnv.USERPROFILE);
          const inAgentFolder =
            AGENT_FILE.test(real) && agents.some((root) => isInside(root, real));
          if (!inAgentFolder) return Promise.resolve({ ok: false, reason: "refused" });
        }
        // Opened once, then checked through the descriptor: what was swapped in after the
        // path was resolved is what gets checked, a final link is not followed, and a pipe
        // does not block the open.
        fd = openSync(
          real,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
        );
        const stat = fstatSync(fd);
        if (!stat.isFile()) return Promise.resolve({ ok: false, reason: "failed" });
        if (stat.size > MAX_FILE_BYTES) return Promise.resolve({ ok: false, reason: "too-large" });
        scratch ??= Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
        let total = 0;
        for (;;) {
          const read = readSync(fd, scratch, total, scratch.length - total, null);
          if (read === 0) break;
          total += read;
          if (total === scratch.length) break;
        }
        if (total > MAX_FILE_BYTES) return Promise.resolve({ ok: false, reason: "too-large" });
        return Promise.resolve({ ok: true, text: scratch.toString("utf8", 0, total) });
      } catch {
        return Promise.resolve({ ok: false, reason: "missing" });
      } finally {
        if (fd !== undefined) closeSync(fd);
        spent += Math.max(0, now() - started);
      }
    },

    charge(ms: number): boolean {
      spent += Math.max(0, ms);
      return spent < budget;
    },

    async processNames(): Promise<ProcessOutcome> {
      const windows = platform === "win32";
      const program = programPath(windows ? "tasklist" : "ps");
      if (program === undefined) return { ok: false, reason: "missing" };
      const result = windows
        ? await run(program, ["/fo", "csv", "/nh"], undefined)
        : await run(program, ["-axo", "comm="], undefined);
      if (typeof result === "string") return { ok: false, reason: result };
      if (result.kind !== "ok") return { ok: false, reason: failureOf(result) };
      return windows ? watchedInTasklist(result.stdout) : watchedInPs(result.stdout);
    },
  };
}
