// cspell:words pathspec Pathspec toplevels
/**
 * Read-only questions the git-backed checks ask about a repository, through `VerifyIO`.
 *
 * Every question is one allow-listed `git` call (`verify-io.ts`) or a stat, answered once per
 * repository and cached. Every value taken from a transcript is checked before it reaches a
 * call: a commit id must be hex (`isCommitId`), and a path must lie inside the folder `git`
 * runs in and is passed as a `:(literal)` pathspec (`literalPathspec`). A call that is refused,
 * times out or fails is a `Failure`, which the checks turn into could-not-check, never clean.
 *
 * Questions are asked with exit-0 forms, whose answer is in the output: `log --no-walk
 * --ignore-missing` prints nothing for a missing commit, and `for-each-ref --contains` prints
 * the refs that hold one. A non-zero exit is therefore always a failure, never "no".
 */

import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CheckFailure, VerifyIO } from "./types.js";

/** A question that got no answer. */
export interface Failure {
  readonly failed: CheckFailure;
}

/** Was the answer a failure? */
export function isFailure(value: unknown): value is Failure {
  return typeof value === "object" && value !== null && "failed" in value;
}

/** A commit id as a command prints it: 7 to 64 lower-case hex digits. */
export function isCommitId(value: string): boolean {
  return /^[0-9a-f]{7,64}$/.test(value);
}

/** The `:(literal)` pathspec for `path` read from `folder`, or `undefined` when outside it. */
export function literalPathspec(folder: string, path: string): string | undefined {
  const rel = relative(folder, path);
  if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
  const posix = rel === "" ? "." : rel.split(sep).join("/");
  if (posix.startsWith("-") || /[\0\r\n\\]/.test(posix)) return undefined;
  return `:(literal)${posix}`;
}

/** Hook files that `--no-verify` skips on a commit. */
export const COMMIT_HOOKS: readonly string[] = ["pre-commit", "commit-msg"];

/** Every hook file a repository's checks commonly run from. */
export const CHECK_HOOKS: readonly string[] = [
  "pre-commit",
  "commit-msg",
  "pre-push",
  "pre-merge-commit",
  "prepare-commit-msg",
];

/** The default branches a commit can reach. */
export type DefaultRefs = readonly string[];

/** A repository's hooks now. See `RepoProbe.hooksState`. */
export type HooksState = "on" | "off" | "none";

/** Tracked files under a path, and how many of them are missing from the working tree now. */
export interface TrackedState {
  readonly tracked: number;
  readonly missing: number;
}

/** Answers questions about repositories, caching what it has asked. */
export class RepoProbe {
  readonly #io: VerifyIO;
  readonly #toplevels = new Map<string, Promise<string | Failure>>();
  readonly #hooks = new Map<string, Promise<string | Failure>>();
  readonly #defaults = new Map<string, Promise<DefaultRefs | Failure>>();
  readonly #stashes = new Map<string, Promise<ReadonlySet<string> | Failure>>();

  constructor(io: VerifyIO) {
    this.#io = io;
  }

  /**
   * Is anything at `path`? `false` only when the seam says nothing is there; `undefined` when
   * it cannot be told, which no caller reads as missing.
   */
  exists(path: string): boolean | undefined {
    if (this.#io.pathExists !== undefined) return this.#io.pathExists(path);
    return this.#io.isDirectory(path) === undefined ? undefined : true;
  }

  /** Is `path` a folder: `undefined` when it cannot be read. */
  isFolder(path: string): boolean | undefined {
    return this.#io.isDirectory(path);
  }

  /**
   * The top folder of the repository `folder` is in. `missing` only when the folder is not
   * there; a folder that cannot be told about is `failed`.
   */
  toplevel(folder: string): Promise<string | Failure> {
    let answer = this.#toplevels.get(folder);
    if (answer === undefined) {
      answer = (async (): Promise<string | Failure> => {
        const isFolder = this.#io.isDirectory(folder);
        if (isFolder === false) return { failed: "missing" };
        if (isFolder === undefined) {
          return { failed: this.exists(folder) === false ? "missing" : "failed" };
        }
        const top = await this.#io.git(folder, ["rev-parse", "--show-toplevel"]);
        if (!top.ok) return { failed: top.reason };
        const root = top.stdout.trim();
        return root === "" ? { failed: "failed" } : root;
      })();
      this.#toplevels.set(folder, answer);
    }
    return answer;
  }

  /** The folder git runs a repository's hooks from now, after `core.hooksPath`. */
  hooksFolder(root: string): Promise<string | Failure> {
    let answer = this.#hooks.get(root);
    if (answer === undefined) {
      answer = (async (): Promise<string | Failure> => {
        const out = await this.#io.git(root, ["rev-parse", "--git-path", "hooks"]);
        if (!out.ok) return { failed: out.reason };
        const path = out.stdout.trim();
        if (path === "") return { failed: "failed" };
        return isAbsolute(path) ? path : resolve(root, path);
      })();
      this.#hooks.set(root, answer);
    }
    return answer;
  }

  /**
   * Does the repository have any of `names` as a hook file now? A folder by a hook's name is no
   * hook. A name that cannot be told about, with no hook found, is a failure, never "none".
   */
  async hasHooks(root: string, names: readonly string[]): Promise<boolean | Failure> {
    const folder = await this.hooksFolder(root);
    if (isFailure(folder)) return folder;
    return this.#anyHook(folder, names);
  }

  /** Is any of `names` a hook file in `folder`: yes, no, or a failure when it cannot be told. */
  #anyHook(folder: string, names: readonly string[]): boolean | Failure {
    let unsure = false;
    for (const name of names) {
      const path = join(folder, name);
      const there = this.exists(path);
      if (there === false) continue;
      const isFolder = there === undefined ? undefined : this.#io.isDirectory(path);
      if (isFolder === false) return true;
      if (isFolder === undefined) unsure = true;
    }
    return unsure ? { failed: "failed" } : false;
  }

  /**
   * The repository's hooks now: `on` when the folder in effect holds one of `names`; `off` when
   * `core.hooksPath` points away from the default folder at one that holds none (switched
   * off); `none` when the default folder holds none (never set up).
   */
  async hooksState(root: string, names: readonly string[]): Promise<HooksState | Failure> {
    const folder = await this.hooksFolder(root);
    if (isFailure(folder)) return folder;
    const hook = this.#anyHook(folder, names);
    if (isFailure(hook)) return hook;
    if (hook) return "on";
    const common = await this.#io.git(root, ["rev-parse", "--git-common-dir"]);
    if (!common.ok) return { failed: common.reason };
    const dir = common.stdout.trim();
    if (dir === "") return { failed: "failed" };
    const standard = resolve(isAbsolute(dir) ? dir : resolve(root, dir), "hooks");
    return resolve(folder) === standard ? "none" : "off";
  }

  /** The full id of a commit that is still in the object store, or `null` when it is not. */
  async commit(root: string, id: string): Promise<string | null | Failure> {
    if (!isCommitId(id)) return { failed: "refused" };
    const out = await this.#io.git(root, [
      "log",
      "--no-walk",
      "--ignore-missing",
      "--format=%H",
      id,
    ]);
    if (!out.ok) return { failed: out.reason };
    const full = out.stdout.trim().split("\n")[0] ?? "";
    if (full === "") return null;
    return isCommitId(full) && full.startsWith(id) ? full : { failed: "failed" };
  }

  /** Which of origin/main and origin/master the repository has. */
  defaultRefs(root: string): Promise<DefaultRefs | Failure> {
    let answer = this.#defaults.get(root);
    if (answer === undefined) {
      answer = (async (): Promise<DefaultRefs | Failure> => {
        const out = await this.#io.git(root, [
          "for-each-ref",
          "--format=%(refname)",
          "refs/remotes/origin/main",
          "refs/remotes/origin/master",
        ]);
        return out.ok ? lines(out.stdout) : { failed: out.reason };
      })();
      this.#defaults.set(root, answer);
    }
    return answer;
  }

  /** Is the commit on origin/main or origin/master? Pass a full id `commit` returned. */
  async onDefaultBranch(root: string, full: string): Promise<boolean | Failure> {
    if (!isCommitId(full)) return { failed: "refused" };
    const out = await this.#io.git(root, [
      "for-each-ref",
      "--contains",
      full,
      "--format=%(refname)",
      "refs/remotes/origin/main",
      "refs/remotes/origin/master",
    ]);
    return out.ok ? lines(out.stdout).length > 0 : { failed: out.reason };
  }

  /** Is the commit on any branch, remote-tracking branch or tag? */
  async onAnyRef(root: string, full: string): Promise<boolean | Failure> {
    if (!isCommitId(full)) return { failed: "refused" };
    const out = await this.#io.git(root, [
      "for-each-ref",
      "--contains",
      full,
      "--format=%(refname)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ]);
    return out.ok ? lines(out.stdout).length > 0 : { failed: out.reason };
  }

  /** The commits in the repository's stash list now. */
  stashes(root: string): Promise<ReadonlySet<string> | Failure> {
    let answer = this.#stashes.get(root);
    if (answer === undefined) {
      answer = (async (): Promise<ReadonlySet<string> | Failure> => {
        const out = await this.#io.git(root, ["stash", "list", "--format=%H"]);
        return out.ok ? new Set(lines(out.stdout)) : { failed: out.reason };
      })();
      this.#stashes.set(root, answer);
    }
    return answer;
  }

  /**
   * The tracked files under `path`, asked from `folder` (an existing folder `path` is in), and
   * how many of them are missing from the working tree now.
   */
  async tracked(folder: string, path: string): Promise<TrackedState | Failure> {
    const spec = literalPathspec(folder, path);
    if (spec === undefined) return { failed: "refused" };
    const all = await this.#io.git(folder, ["ls-files", "-z", "--", spec]);
    if (!all.ok) return { failed: all.reason };
    const tracked = entries(all.stdout).length;
    if (tracked === 0) return { tracked: 0, missing: 0 };
    const gone = await this.#io.git(folder, ["ls-files", "--deleted", "-z", "--", spec]);
    if (!gone.ok) return { failed: gone.reason };
    return { tracked, missing: entries(gone.stdout).length };
  }

  /** Read one file through the seam. */
  read(path: string): ReturnType<VerifyIO["readFile"]> {
    return this.#io.readFile(path);
  }
}

/** The non-empty lines of an output. */
function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** The entries of a `-z` listing. */
function entries(text: string): string[] {
  return text.split("\0").filter((entry) => entry !== "");
}
