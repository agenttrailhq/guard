// cspell:words fsmonitor tasklist
/**
 * The read-only seam `scan --verify` uses (`src/verify-io.ts`).
 *
 * The allow-list and the process options are checked with a recording `exec`, so a refused
 * call is proved never to start a process. The failure modes are checked against real
 * processes, and the git calls against a real temporary repository built in the test,
 * including one whose own config names programs to run.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createRealVerifyIO,
  type Exec,
  type ExecOptions,
  GIT_ALLOW_LIST,
  GIT_SAFETY_ARGS,
  gitEnvironment,
  isAllowedGitCall,
  MAX_FILE_BYTES,
  parsePsNames,
  parseTasklistNames,
  realExec,
} from "../verify-io.js";

/** An `exec` that records every call and answers `ok`. */
function recorder(stdout = "/repo\n"): {
  exec: Exec;
  calls: { file: string; args: readonly string[]; options: ExecOptions }[];
} {
  const calls: { file: string; args: readonly string[]; options: ExecOptions }[] = [];
  return {
    calls,
    exec: (file, args, options) => {
      calls.push({ file, args, options });
      return Promise.resolve({ kind: "ok", stdout });
    },
  };
}

/** A temporary git repo holding `files`, all added to the index. */
function repo(files: Record<string, string> = { "a.txt": "alpha" }): string {
  const root = mkdtempSync(join(tmpdir(), "agenttrail-verify-io-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  execFileSync("git", ["add", "-A"], { cwd: root });
  return root;
}

describe("the git allow-list", () => {
  it("is exactly the two read-only calls the checks make", () => {
    expect(GIT_ALLOW_LIST).toEqual([
      ["rev-parse", "--show-toplevel"],
      ["ls-files", "-z"],
    ]);
  });

  it.each([
    [["status"]],
    [["fetch"]],
    [["ls-files"]],
    [["ls-files", "-z", "--", "x"]],
    [["rev-parse", "--show-toplevel", "HEAD"]],
    [["-c", "core.pager=sh", "ls-files", "-z"]],
    [["fsck", "--lost-found"]],
    [["config", "core.hooksPath", "x"]],
    [[]],
  ])("refuses %j without starting a process", async (args) => {
    expect(isAllowedGitCall(args)).toBe(false);
    const { exec, calls } = recorder();
    const io = createRealVerifyIO({ exec });
    expect(await io.git("/repo", args)).toEqual({ ok: false, reason: "refused" });
    expect(calls).toEqual([]);
  });

  it("runs an allowed call through execFile options with no shell, and the safety flags first", async () => {
    const { exec, calls } = recorder();
    const io = createRealVerifyIO({ exec, env: { PATH: "/bin", GIT_DIR: "/elsewhere" } });
    await io.git("/repo", ["ls-files", "-z"]);
    expect(calls).toHaveLength(1);
    const [only] = calls;
    expect(only?.file).toBe("git");
    expect(only?.args).toEqual([...GIT_SAFETY_ARGS, "ls-files", "-z"]);
    expect(only?.options.shell).toBe(false);
    expect(only?.options.cwd).toBe("/repo");
    expect(only?.options.timeout).toBeLessThanOrEqual(5_000);
    expect(only?.options.maxBuffer).toBe(1024 * 1024);
    expect(only?.options.env.GIT_DIR).toBeUndefined();
    expect(only?.options.env.GIT_OPTIONAL_LOCKS).toBe("0");
    expect(only?.options.env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("builds the environment fresh, leaving every git override behind", () => {
    const env = gitEnvironment({
      PATH: "/bin",
      HOME: "/h",
      GIT_DIR: "/x",
      GIT_WORK_TREE: "/y",
      GIT_CONFIG_GLOBAL: "/z",
      GIT_SSH_COMMAND: "ssh -o x",
      SECRET_TOKEN: "s",
    });
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/h",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      LANG: "C",
    });
  });
});

describe("failures become a reason, never an answer", () => {
  it("a process that runs past its timeout", async () => {
    const result = await realExec("node", ["-e", "setTimeout(() => {}, 10000)"], {
      env: gitEnvironment(process.env),
      timeout: 200,
      maxBuffer: 1024,
      shell: false,
      windowsHide: true,
      encoding: "utf8",
    });
    expect(result).toEqual({ kind: "timeout" });
  });

  it("output over the cap", async () => {
    const result = await realExec("node", ["-e", "process.stdout.write('x'.repeat(4096))"], {
      env: gitEnvironment(process.env),
      timeout: 10_000,
      maxBuffer: 1024,
      shell: false,
      windowsHide: true,
      encoding: "utf8",
    });
    expect(result).toEqual({ kind: "too-large" });
  });

  it("a program that is not installed", async () => {
    const result = await realExec("agenttrail-no-such-program", [], {
      env: gitEnvironment(process.env),
      timeout: 5_000,
      maxBuffer: 1024,
      shell: false,
      windowsHide: true,
      encoding: "utf8",
    });
    expect(result).toEqual({ kind: "missing" });
  });

  it("a non-zero exit", async () => {
    const result = await realExec("node", ["-e", "process.exit(3)"], {
      env: gitEnvironment(process.env),
      timeout: 10_000,
      maxBuffer: 1024,
      shell: false,
      windowsHide: true,
      encoding: "utf8",
    });
    expect(result).toMatchObject({ kind: "exit", code: 3 });
  });

  it.each([
    [{ kind: "timeout" } as const, "timeout"],
    [{ kind: "too-large" } as const, "too-large"],
    [{ kind: "missing" } as const, "missing"],
    [{ kind: "failed" } as const, "failed"],
    [{ kind: "exit", code: 1, stderr: "" } as const, "failed"],
    [{ kind: "exit", code: 128, stderr: "fatal: not a git repository" } as const, "not-a-repo"],
  ])("maps %j to %s", async (result, reason) => {
    const io = createRealVerifyIO({ exec: () => Promise.resolve(result) });
    expect(await io.git("/repo", ["ls-files", "-z"])).toEqual({ ok: false, reason });
  });

  it("stops at the run's total budget", async () => {
    let clock = 0;
    const exec: Exec = () => {
      clock += 40_000;
      return Promise.resolve({ kind: "ok", stdout: "" });
    };
    const io = createRealVerifyIO({ exec, now: () => clock });
    expect((await io.git("/r", ["ls-files", "-z"])).ok).toBe(true);
    expect((await io.git("/r", ["ls-files", "-z"])).ok).toBe(true);
    expect(await io.git("/r", ["ls-files", "-z"])).toEqual({ ok: false, reason: "budget" });
    expect(await io.readFile("/r/a")).toEqual({ ok: false, reason: "budget" });
  });

  it("gives a call no more than what is left of the budget", async () => {
    const { exec, calls } = recorder();
    const io = createRealVerifyIO({ exec, totalBudgetMs: 1_500, now: () => 0 });
    await io.git("/r", ["ls-files", "-z"]);
    expect(calls[0]?.options.timeout).toBe(1_500);
  });
});

describe("against a real repository", () => {
  it("finds the top level and lists the tracked files", async () => {
    const root = repo({ "a.txt": "alpha", "dir/b.txt": "beta" });
    const io = createRealVerifyIO();
    const top = await io.git(join(root, "dir"), ["rev-parse", "--show-toplevel"]);
    expect(top.ok && realpathSync(top.stdout.trim())).toBe(realpathSync(root));
    const files = await io.git(root, ["ls-files", "-z"]);
    expect(files.ok && files.stdout.split("\0").filter(Boolean).sort()).toEqual([
      "a.txt",
      "dir/b.txt",
    ]);
  });

  it("says a folder outside any repository is not a repo", async () => {
    const plain = mkdtempSync(join(tmpdir(), "agenttrail-verify-plain-"));
    const io = createRealVerifyIO();
    expect(await io.git(plain, ["rev-parse", "--show-toplevel"])).toEqual({
      ok: false,
      reason: "not-a-repo",
    });
  });

  it("starts none of the programs a repository's own config names", async () => {
    const root = repo();
    const marker = join(root, "..", `marker-${Date.now()}`);
    const script = join(root, "..", `run-${Date.now()}.sh`);
    writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    for (const [key, value] of [
      ["core.fsmonitor", script],
      ["core.pager", script],
      ["diff.external", script],
      ["core.hooksPath", root],
    ]) {
      execFileSync("git", ["config", key as string, value as string], { cwd: root });
    }
    writeFileSync(join(root, "post-index-change"), `#!/bin/sh\ntouch "${marker}"\n`, {
      mode: 0o755,
    });
    const io = createRealVerifyIO();
    expect((await io.git(root, ["rev-parse", "--show-toplevel"])).ok).toBe(true);
    expect((await io.git(root, ["ls-files", "-z"])).ok).toBe(true);
    expect(existsSync(marker)).toBe(false);

    // Negative control: the same listing WITHOUT the safety flags does start the planted
    // file-system monitor, so the assertion above is a fence that bites.
    execFileSync("git", ["ls-files", "-z"], { cwd: root, stdio: "pipe" });
    expect(existsSync(marker)).toBe(true);
  });

  it("reads a tracked file, and nothing outside a repository it has seen", async () => {
    const root = repo({ "a.txt": "alpha" });
    const io = createRealVerifyIO();
    // No `rev-parse` yet, so no root is known.
    expect(await io.readFile(join(root, "a.txt"))).toEqual({ ok: false, reason: "refused" });
    await io.git(root, ["rev-parse", "--show-toplevel"]);
    expect(await io.readFile(join(root, "a.txt"))).toEqual({ ok: true, text: "alpha" });
    const outside = join(mkdtempSync(join(tmpdir(), "agenttrail-outside-")), "x.txt");
    writeFileSync(outside, "outside");
    expect(await io.readFile(outside)).toEqual({ ok: false, reason: "refused" });
  });

  it("refuses a link inside the repository that points out of it", async () => {
    const root = repo();
    const outside = join(mkdtempSync(join(tmpdir(), "agenttrail-outside-")), "secret.txt");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(root, "link.txt"));
    const io = createRealVerifyIO();
    await io.git(root, ["rev-parse", "--show-toplevel"]);
    expect(await io.readFile(join(root, "link.txt"))).toEqual({ ok: false, reason: "refused" });
  });

  it("refuses a file over the size cap, a folder and a missing file", async () => {
    const root = repo({ "big.txt": "x".repeat(MAX_FILE_BYTES + 1), "d/a.txt": "a" });
    const io = createRealVerifyIO();
    await io.git(root, ["rev-parse", "--show-toplevel"]);
    expect(await io.readFile(join(root, "big.txt"))).toEqual({ ok: false, reason: "too-large" });
    expect(await io.readFile(join(root, "d"))).toEqual({ ok: false, reason: "failed" });
    expect(await io.readFile(join(root, "gone.txt"))).toEqual({ ok: false, reason: "missing" });
  });

  it("tells a folder from a file and from nothing", () => {
    const root = repo();
    const io = createRealVerifyIO();
    expect(io.isDirectory(root)).toBe(true);
    expect(io.isDirectory(join(root, "a.txt"))).toBe(false);
    expect(io.isDirectory(join(root, "nope"))).toBeUndefined();
  });
});

describe("process names, never arguments", () => {
  it("reads ps output as names", () => {
    expect(parsePsNames("/usr/bin/node\n  zsh \n\n/Applications/X.app/Contents/MacOS/X\n")).toEqual(
      ["node", "zsh", "X"],
    );
  });

  it("reads tasklist output as names", () => {
    expect(
      parseTasklistNames(
        '"node.exe","123","Console","1","10,000 K"\r\n"Code.exe","9","C","1","1 K"\r\n',
      ),
    ).toEqual(["node.exe", "Code.exe"]);
  });

  it("runs ps with names only, or tasklist on Windows", async () => {
    const unix = recorder("node\n");
    expect(
      await createRealVerifyIO({ exec: unix.exec, platform: "darwin" }).processNames(),
    ).toEqual({
      ok: true,
      names: ["node"],
    });
    expect(unix.calls.map((c) => [c.file, ...c.args])).toEqual([["ps", "-axo", "comm="]]);
    const win = recorder('"node.exe","1"\r\n');
    expect(await createRealVerifyIO({ exec: win.exec, platform: "win32" }).processNames()).toEqual({
      ok: true,
      names: ["node.exe"],
    });
    expect(win.calls.map((c) => [c.file, ...c.args])).toEqual([["tasklist", "/fo", "csv", "/nh"]]);
  });

  it("a process list that cannot be read is a reason", async () => {
    const io = createRealVerifyIO({ exec: () => Promise.resolve({ kind: "missing" }) });
    expect(await io.processNames()).toEqual({ ok: false, reason: "missing" });
  });

  it("reads this machine's list", async () => {
    const result = await createRealVerifyIO().processNames();
    expect(result.ok && result.names.length).toBeGreaterThan(0);
  });
});
