// cspell:words fsmonitor tasklist SYSTEMROOT
/**
 * `VerifyIO` — the read-only seam `scan --verify` checks this machine through.
 *
 * ── What it can do, and nothing else ─────────────────────────────────────────
 *  - run `git` with an argument list from `GIT_ALLOW_LIST`, exactly;
 *  - list the names of the running processes, never their arguments;
 *  - tell whether a path is a folder;
 *  - read one file of at most `MAX_FILE_BYTES`, inside a repo a `git rev-parse` call returned.
 *
 * It writes nothing, and it reaches no network: the allow-listed `git` calls read the local
 * repository only.
 *
 * ── How `git` is run ─────────────────────────────────────────────────────────
 * Through `execFile`, never a shell, so no argument is ever shell syntax. Every call carries
 * `GIT_SAFETY_ARGS`, which stop a repository's own config from starting a program: no
 * file-system monitor, no pager, no external diff tool. The environment is built fresh rather
 * than inherited, so a `GIT_DIR`, `GIT_CONFIG_*` or `GIT_SSH_COMMAND` in the caller's shell
 * never reaches it, and it sets `GIT_OPTIONAL_LOCKS=0` (no index refresh is written) and
 * `GIT_TERMINAL_PROMPT=0` (nothing waits for a password).
 *
 * ── Limits, and what a failure means ─────────────────────────────────────────
 * Each call has `CALL_TIMEOUT_MS` and an output cap of `MAX_OUTPUT_BYTES`, and all calls share
 * `TOTAL_BUDGET_MS`. A call that times out, overflows, is refused or fails comes back as a
 * `CheckFailure`, which every check turns into could-not-check. Nothing here throws.
 *
 * Kept out of `ScanIO` so the browser opener stays the only process that seam starts, and out
 * of the hook's import graph: `bundle-graph.test.ts` checks both.
 */

import { execFile } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import type {
  CheckFailure,
  FileOutcome,
  GitOutcome,
  ProcessOutcome,
  VerifyIO,
} from "./core/verify/types.js";

/** The `git` argument lists verification may run, exactly as written. */
export const GIT_ALLOW_LIST: readonly (readonly string[])[] = [
  ["rev-parse", "--show-toplevel"],
  ["ls-files", "-z"],
];

/** Put before every allow-listed call, so a repository's config cannot start a program. */
export const GIT_SAFETY_ARGS: readonly string[] = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.pager=cat",
  "-c",
  "diff.external=",
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

/** Most process names `processNames` returns. */
const MAX_PROCESS_NAMES = 4_096;

/** Is `args` exactly one of the allow-listed argument lists? */
export function isAllowedGitCall(args: readonly string[]): boolean {
  return GIT_ALLOW_LIST.some(
    (allowed) => allowed.length === args.length && allowed.every((arg, i) => arg === args[i]),
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

/** Process names from `ps -axo comm=`: one per line, a path cut to its last part. */
export function parsePsNames(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => line.split("/").pop() ?? line)
    .slice(0, MAX_PROCESS_NAMES);
}

/** Process names from `tasklist /fo csv /nh`: the first quoted field of each line. */
export function parseTasklistNames(stdout: string): string[] {
  const names: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^"([^"]*)"/.exec(line.trim());
    if (match?.[1] !== undefined && match[1] !== "") names.push(match[1]);
  }
  return names.slice(0, MAX_PROCESS_NAMES);
}

/** Is `path` inside `root` (and not `root` itself)? Both are real paths. */
function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
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
}

/** The real `VerifyIO`. Created only when `scan --verify` runs. */
export function createRealVerifyIO(options: VerifyIOOptions = {}): VerifyIO {
  const exec = options.exec ?? realExec;
  const env = gitEnvironment(options.env ?? process.env);
  const platform = options.platform ?? process.platform;
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
      if (!isAllowedGitCall(args)) return { ok: false, reason: "refused" };
      const result = await run("git", [...GIT_SAFETY_ARGS, ...args], cwd);
      if (typeof result === "string") return { ok: false, reason: result };
      if (result.kind !== "ok") return { ok: false, reason: failureOf(result) };
      if (args[0] === "rev-parse") {
        try {
          roots.add(realpathSync(result.stdout.trim()));
        } catch {
          return { ok: false, reason: "failed" };
        }
      }
      return { ok: true, stdout: result.stdout };
    },

    isDirectory(path: string): boolean | undefined {
      try {
        return statSync(path).isDirectory();
      } catch {
        return undefined;
      }
    },

    readFile(path: string): Promise<FileOutcome> {
      if (spent >= budget) return Promise.resolve({ ok: false, reason: "budget" });
      const started = now();
      try {
        // The REAL path is what is checked, so a link inside a repo that points out of it is
        // refused rather than followed.
        const real = realpathSync(path);
        if (![...roots].some((root) => isInside(root, real))) {
          return Promise.resolve({ ok: false, reason: "refused" });
        }
        const stat = statSync(real);
        if (!stat.isFile()) return Promise.resolve({ ok: false, reason: "failed" });
        if (stat.size > MAX_FILE_BYTES) return Promise.resolve({ ok: false, reason: "too-large" });
        return Promise.resolve({ ok: true, text: readFileSync(real, "utf8") });
      } catch {
        return Promise.resolve({ ok: false, reason: "missing" });
      } finally {
        spent += Math.max(0, now() - started);
      }
    },

    async processNames(): Promise<ProcessOutcome> {
      const windows = platform === "win32";
      const result = windows
        ? await run("tasklist", ["/fo", "csv", "/nh"], undefined)
        : await run("ps", ["-axo", "comm="], undefined);
      if (typeof result === "string") return { ok: false, reason: result };
      if (result.kind !== "ok") return { ok: false, reason: failureOf(result) };
      return {
        ok: true,
        names: windows ? parseTasklistNames(result.stdout) : parsePsNames(result.stdout),
      };
    },
  };
}
