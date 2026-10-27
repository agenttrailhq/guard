/**
 * Finding the repo a path or a working directory belongs to, through `VerifyIO`.
 *
 * `VerifyIO.readFile` reads only under a root that a `git rev-parse --show-toplevel` call has
 * returned, so a check that reads a file asks for the file's repo first. Answers are kept per
 * folder for the run, so each folder is asked about once.
 */

import { dirname, isAbsolute, join } from "node:path";
import type { CheckFailure, FileOutcome, VerifyIO } from "./types.js";

/** A repo root, or why there is none. */
export type RootOutcome =
  | { readonly ok: true; readonly root: string }
  | { readonly ok: false; readonly reason: CheckFailure };

/** Repo roots found so far, by folder. */
export type RootCache = Map<string, RootOutcome>;

/** A new, empty cache. */
export function rootCache(): RootCache {
  return new Map();
}

/** The repo `dir` is in. */
export async function repoRoot(io: VerifyIO, dir: string, cache: RootCache): Promise<RootOutcome> {
  const known = cache.get(dir);
  if (known !== undefined) return known;
  let outcome: RootOutcome;
  if (io.isDirectory(dir) !== true) outcome = { ok: false, reason: "missing" };
  else {
    const top = await io.git(dir, ["rev-parse", "--show-toplevel"]);
    const root = top.ok ? top.stdout.trim() : "";
    outcome = top.ok
      ? root === ""
        ? { ok: false, reason: "failed" }
        : { ok: true, root }
      : { ok: false, reason: top.reason };
  }
  cache.set(dir, outcome);
  return outcome;
}

/**
 * `path` made absolute against `cwd`. `undefined` when it is relative and there is no
 * working directory to place it in.
 */
export function placed(path: string, cwd: string | null): string | undefined {
  if (isAbsolute(path)) return path;
  return cwd === null || cwd === "" ? undefined : join(cwd, path);
}

/** Read `path`, after asking for the repo its folder is in. */
export async function readRepoFile(
  io: VerifyIO,
  path: string,
  cache: RootCache,
): Promise<FileOutcome> {
  const root = await repoRoot(io, dirname(path), cache);
  if (!root.ok) return { ok: false, reason: root.reason };
  return io.readFile(path);
}
