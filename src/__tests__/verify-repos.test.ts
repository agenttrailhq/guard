/**
 * Finding a path's repo (`core/verify/repos.ts`), through a fake `VerifyIO` that records each
 * call: a root is what `rev-parse --show-toplevel` returned, never an empty answer; a folder that
 * is not there is never asked about; each folder is asked about once; a relative path is placed
 * only against a working directory; and a file is read only once its repo is found.
 */

import { describe, expect, it } from "vitest";
import { placed, readRepoFile, repoRoot, rootCache } from "../core/verify/repos.js";
import type { GitOutcome, VerifyIO } from "../core/verify/types.js";

/** A fake seam: which folders exist, what `rev-parse` answers, and every call it got. */
function fakeIO(options: {
  readonly folders?: readonly string[];
  readonly toplevel?: (cwd: string) => GitOutcome;
}) {
  const gitCalls: { cwd: string; args: readonly string[] }[] = [];
  const reads: string[] = [];
  const io: VerifyIO = {
    git: (cwd, args) => {
      gitCalls.push({ cwd, args });
      return Promise.resolve(options.toplevel?.(cwd) ?? { ok: false, reason: "missing" });
    },
    isDirectory: (path) => ((options.folders ?? []).includes(path) ? true : undefined),
    readFile: (path) => {
      reads.push(path);
      return Promise.resolve({ ok: true, text: "content" });
    },
    processNames: () => Promise.resolve({ ok: false, reason: "missing" }),
  };
  return { io, gitCalls, reads };
}

describe("repoRoot", () => {
  it("is what rev-parse --show-toplevel returned, trimmed", async () => {
    const { io, gitCalls } = fakeIO({
      folders: ["/r/src"],
      toplevel: () => ({ ok: true, stdout: "/r\n" }),
    });
    expect(await repoRoot(io, "/r/src", rootCache())).toEqual({ ok: true, root: "/r" });
    expect(gitCalls).toEqual([{ cwd: "/r/src", args: ["rev-parse", "--show-toplevel"] }]);
  });

  it.each([
    ["an empty answer", ""],
    ["a blank line", "\n"],
    ["only spaces", "   \n"],
  ])("%s is no root: failed, never a root of ''", async (_label, stdout) => {
    const { io } = fakeIO({ folders: ["/r"], toplevel: () => ({ ok: true, stdout }) });
    expect(await repoRoot(io, "/r", rootCache())).toEqual({ ok: false, reason: "failed" });
  });

  it("a failed call keeps its reason", async () => {
    const { io } = fakeIO({
      folders: ["/r"],
      toplevel: () => ({ ok: false, reason: "not-a-repo" }),
    });
    expect(await repoRoot(io, "/r", rootCache())).toEqual({ ok: false, reason: "not-a-repo" });
  });

  it("a folder that is not there is missing, and git is never asked about it", async () => {
    const { io, gitCalls } = fakeIO({ toplevel: () => ({ ok: true, stdout: "/r\n" }) });
    expect(await repoRoot(io, "/gone", rootCache())).toEqual({ ok: false, reason: "missing" });
    expect(gitCalls).toEqual([]);
  });

  it("asks about each folder once per cache", async () => {
    const { io, gitCalls } = fakeIO({
      folders: ["/r", "/s"],
      toplevel: (cwd) => ({ ok: true, stdout: `${cwd}\n` }),
    });
    const cache = rootCache();
    await repoRoot(io, "/r", cache);
    await repoRoot(io, "/r", cache);
    await repoRoot(io, "/s", cache);
    expect(gitCalls.map((c) => c.cwd)).toEqual(["/r", "/s"]);
    // A new cache asks again.
    await repoRoot(io, "/r", rootCache());
    expect(gitCalls).toHaveLength(3);
  });
});

describe("placed", () => {
  it("keeps an absolute path, and places a relative one in the working directory", () => {
    expect(placed("/abs/x.ts", "/w")).toBe("/abs/x.ts");
    expect(placed("/abs/x.ts", null)).toBe("/abs/x.ts");
    expect(placed("src/x.ts", "/w")).toBe("/w/src/x.ts");
  });

  it.each([
    ["no working directory", null],
    ["an empty one", ""],
  ] as const)("a relative path with %s is not placed", (_label, cwd) => {
    expect(placed("src/x.ts", cwd)).toBeUndefined();
  });
});

describe("readRepoFile", () => {
  it("reads a file once its repo is found", async () => {
    const { io, reads } = fakeIO({
      folders: ["/r/src"],
      toplevel: () => ({ ok: true, stdout: "/r\n" }),
    });
    expect(await readRepoFile(io, "/r/src/a.ts", rootCache())).toEqual({
      ok: true,
      text: "content",
    });
    expect(reads).toEqual(["/r/src/a.ts"]);
  });

  it.each([
    ["its folder is not there", { toplevel: () => ({ ok: true, stdout: "/r\n" }) }, "missing"],
    [
      "its folder is in no repo",
      { folders: ["/r/src"], toplevel: () => ({ ok: false, reason: "not-a-repo" }) },
      "not-a-repo",
    ],
    [
      "rev-parse gave no root",
      { folders: ["/r/src"], toplevel: () => ({ ok: true, stdout: "" }) },
      "failed",
    ],
  ] as const)("is never read when %s", async (_label, options, reason) => {
    const { io, reads } = fakeIO(options as Parameters<typeof fakeIO>[0]);
    expect(await readRepoFile(io, "/r/src/a.ts", rootCache())).toEqual({ ok: false, reason });
    expect(reads).toEqual([]);
  });
});
