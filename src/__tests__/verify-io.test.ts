// cspell:words fsmonitor tasklist mkfifo statted secretdb cursorless gpgsig lnbm
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
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createRealVerifyIO,
  type Exec,
  type ExecOptions,
  GIT_ALLOW_LIST,
  GIT_SAFETY_ARGS,
  gitEnvironment,
  isAllowedGitCall,
  isNetworkPath,
  MAX_FILE_BYTES,
  MAX_PROCESS_ENTRIES,
  realExec,
  resolveProgram,
  watchedInPs,
  watchedInTasklist,
  watchedProcessOf,
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
    [["-z", "ls-files"]],
    [["--show-toplevel", "rev-parse"]],
    [[]],
  ])("refuses %j without starting a process", async (args) => {
    expect(isAllowedGitCall(args)).toBe(false);
    const { exec, calls } = recorder();
    const io = createRealVerifyIO({ exec });
    expect(await io.git("/repo", args)).toEqual({ ok: false, reason: "refused" });
    expect(calls).toEqual([]);
  });

  it("pins the safety flags, written out rather than read back from the constant", () => {
    expect(GIT_SAFETY_ARGS).toEqual([
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.pager=cat",
      "-c",
      "diff.external=",
      "-c",
      "log.showSignature=false",
      "--no-pager",
    ]);
  });

  it("runs an allowed call by absolute path, with no shell and the safety flags first", async () => {
    const { exec, calls } = recorder();
    const io = createRealVerifyIO({
      exec,
      env: { PATH: "/opt/tools/bin", GIT_DIR: "/elsewhere" },
      isExecutable: (path) => path === "/opt/tools/bin/git",
    });
    await io.git("/repo", ["ls-files", "-z"]);
    expect(calls).toHaveLength(1);
    const [only] = calls;
    expect(only?.file).toBe("/opt/tools/bin/git");
    expect(isAbsolute(only?.file ?? "")).toBe(true);
    expect(only?.args).toEqual([
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.pager=cat",
      "-c",
      "diff.external=",
      "-c",
      "log.showSignature=false",
      "--no-pager",
      "ls-files",
      "-z",
    ]);
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
    [{ kind: "exit", code: 1, stderr: "fatal: not a git repository" } as const, "failed"],
    [{ kind: "exit", code: 128, stderr: "fatal: unsafe repository" } as const, "failed"],
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

  it("starts no signature program for a signed commit, through log or stash list", () => {
    // A repository asking for signatures to be shown, a gpg program that leaves a marker, and
    // a commit object carrying a signature header (any bytes will do). Built here, in test code.
    const root = repo();
    const marker = join(root, "..", `gpg-marker-${Date.now()}`);
    const script = join(root, "..", `gpg-${Date.now()}.sh`);
    writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });
    execFileSync("git", ["config", "log.showSignature", "true"], { cwd: root });
    execFileSync("git", ["config", "gpg.program", script], { cwd: root });
    const tree = execFileSync("git", ["hash-object", "-t", "tree", "--stdin", "-w"], {
      cwd: root,
      input: "",
      encoding: "utf8",
    }).trim();
    const commit = [
      `tree ${tree}`,
      "author A <a@example.invalid> 1700000000 +0000",
      "committer A <a@example.invalid> 1700000000 +0000",
      "gpgsig -----BEGIN PGP SIGNATURE-----",
      " ",
      " c2lnbmF0dXJl",
      " -----END PGP SIGNATURE-----",
      "",
      "signed",
      "",
    ].join("\n");
    const sha = execFileSync("git", ["hash-object", "-t", "commit", "--stdin", "-w"], {
      cwd: root,
      input: commit,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["update-ref", "--create-reflog", "-m", "stash", "refs/stash", sha], {
      cwd: root,
    });

    const run = (args: readonly string[]): void => {
      try {
        execFileSync("git", [...args], { cwd: root, stdio: "pipe" });
      } catch {
        // A failed signature check exits non-zero; only whether the script ran matters here.
      }
    };
    run([...GIT_SAFETY_ARGS, "log", "-1", "--format=%H", sha]);
    run([...GIT_SAFETY_ARGS, "stash", "list", "--format=%H"]);
    expect(existsSync(marker)).toBe(false);

    // Negative control: the same log without the safety flags does start the planted program.
    run(["log", "-1", "--format=%H", sha]);
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

  it("refuses a pipe in the repository without blocking on it", async () => {
    const root = repo();
    const fifo = join(root, "pipe");
    execFileSync("mkfifo", [fifo]);
    const io = createRealVerifyIO();
    await io.git(root, ["rev-parse", "--show-toplevel"]);
    const started = Date.now();
    expect(await io.readFile(fifo)).toEqual({ ok: false, reason: "failed" });
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 10_000);

  it("reads a file of exactly the cap, and nothing past it", async () => {
    const root = repo({ "edge.txt": "y".repeat(MAX_FILE_BYTES) });
    const io = createRealVerifyIO();
    await io.git(root, ["rev-parse", "--show-toplevel"]);
    const read = await io.readFile(join(root, "edge.txt"));
    expect(read.ok && read.text.length).toBe(MAX_FILE_BYTES);
  });

  it("tells a folder from a file and from nothing", () => {
    const root = repo();
    const io = createRealVerifyIO();
    expect(io.isDirectory(root)).toBe(true);
    expect(io.isDirectory(join(root, "a.txt"))).toBe(false);
    expect(io.isDirectory(join(root, "nope"))).toBeUndefined();
  });
});

describe("programs are run by absolute path only", () => {
  /** A temporary folder holding an executable file called `name`. */
  function folderWith(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), "agenttrail-verify-bin-"));
    writeFileSync(join(dir, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    return dir;
  }

  it("finds a program in an absolute PATH entry", () => {
    const dir = folderWith("git");
    expect(
      resolveProgram("git", { PATH: `/nonexistent:${dir}` }, "darwin", (p) => existsSync(p)),
    ).toBe(join(dir, "git"));
  });

  it("skips empty, relative and network entries", () => {
    const seen: string[] = [];
    const found = resolveProgram(
      "git",
      { PATH: ":bin:./tools://host/share/bin:/usr/local/bin" },
      "linux",
      (p) => {
        seen.push(p);
        return p === "/usr/local/bin/git";
      },
    );
    expect(found).toBe("/usr/local/bin/git");
    expect(seen).toEqual(["/usr/local/bin/git"]);
  });

  it("on Windows, looks for the .exe in absolute entries split on ;", () => {
    const seen: string[] = [];
    expect(
      resolveProgram(
        "git",
        { Path: "relative;C:\\Program Files\\Git\\cmd;\\\\host\\share" },
        "win32",
        (p) => {
          seen.push(p);
          return p.endsWith("\\cmd\\git.exe");
        },
      ),
    ).toBe("C:\\Program Files\\Git\\cmd\\git.exe");
    expect(seen).toEqual(["C:\\Program Files\\Git\\cmd\\git.exe"]);
  });

  it("a git that is not on PATH is missing, and nothing runs", async () => {
    const { exec, calls } = recorder();
    const io = createRealVerifyIO({ exec, env: { PATH: "/none" }, isExecutable: () => false });
    expect(await io.git("/repo", ["ls-files", "-z"])).toEqual({ ok: false, reason: "missing" });
    expect(calls).toEqual([]);
  });

  it("a git that sits inside the folder it would run in is refused", async () => {
    const { exec, calls } = recorder();
    const io = createRealVerifyIO({
      exec,
      env: { PATH: "/work/repo/bin" },
      isExecutable: (p) => p === "/work/repo/bin/git",
    });
    expect(await io.git("/work/repo", ["ls-files", "-z"])).toEqual({
      ok: false,
      reason: "refused",
    });
    expect(calls).toEqual([]);
    // The same git, run in a folder that does not contain it, is allowed.
    expect((await io.git("/work/other", ["ls-files", "-z"])).ok).toBe(true);
  });

  it("finds a program once, however many calls are made", async () => {
    let lookups = 0;
    const { exec } = recorder();
    const io = createRealVerifyIO({
      exec,
      env: { PATH: "/opt/bin" },
      isExecutable: (p) => {
        lookups += 1;
        return p === "/opt/bin/git";
      },
    });
    await io.git("/a", ["ls-files", "-z"]);
    await io.git("/b", ["ls-files", "-z"]);
    expect(lookups).toBe(1);
  });

  it("the real seam runs git by an absolute path", async () => {
    const calls: string[] = [];
    const io = createRealVerifyIO({
      exec: (file, args, options) => {
        calls.push(file);
        return realExec(file, args, options);
      },
    });
    const root = repo();
    expect((await io.git(root, ["ls-files", "-z"])).ok).toBe(true);
    expect(calls.every((file) => isAbsolute(file))).toBe(true);
  });
});

describe("network paths are not touched", () => {
  it.each([
    "\\\\host\\share\\repo",
    "//host/share/repo",
    "/net/host/repo",
    "/net",
    "/Network/Servers/host",
  ])("%s is a network path", (path) => {
    expect(isNetworkPath(path)).toBe(true);
  });

  it.each([
    "/home/user/repo",
    "C:\\Users\\me\\repo",
    "/network-tools",
    "/netflix",
  ])("%s is not", (path) => {
    expect(isNetworkPath(path)).toBe(false);
  });

  it("nothing is statted, run or read on one", async () => {
    const { exec, calls } = recorder();
    const io = createRealVerifyIO({ exec });
    expect(io.isDirectory("//host/share/repo")).toBeUndefined();
    expect(await io.git("//host/share/repo", ["ls-files", "-z"])).toEqual({
      ok: false,
      reason: "refused",
    });
    expect(await io.readFile("/net/host/repo/a.txt")).toEqual({ ok: false, reason: "refused" });
    expect(calls).toEqual([]);
  });
});

describe("process names: agent ids only, never arguments or titles", () => {
  it.each([
    ["claude", "claude"],
    ["/usr/local/bin/claude", "claude"],
    ["codex", "codex"],
    ["/Applications/Cursor.app/Contents/MacOS/Cursor", "cursor"],
    ["Cursor Helper", "cursor"],
    ["Cursor Helper (Plugin): 4c1d-9a (agent-exec) --type=utility", "cursor"],
    ["Cursor.exe", "cursor"],
    ["C:\\Program Files\\Cursor\\Cursor.exe", "cursor"],
    ["claude.exe", "claude"],
    ["cursor-agent", "cursor"],
    ["/Users/a/.local/bin/cursor-agent", "cursor"],
    ["cursor-agent.exe", "cursor"],
    // Case is ignored: the Claude desktop app runs as `Claude`, and Windows names vary.
    ["Claude", "claude"],
    ["CODEX.EXE", "codex"],
  ])("%s is %s", (entry, id) => {
    expect(watchedProcessOf(entry)).toBe(id);
  });

  it.each([
    "node",
    "zsh",
    "postgres: alice secretdb 127.0.0.1(5432) idle",
    "cursorless",
    "claude-helper",
    "my-codex-tool",
    "Cursor Helper (Plugin) extra",
    "cursor-agent-helper",
    "my-cursor-agent",
    "",
  ])("%j is no watched process", (entry) => {
    expect(watchedProcessOf(entry)).toBeUndefined();
  });

  it("reads ps output down to ids, each once, and keeps nothing else", () => {
    const stdout = [
      "/usr/bin/node",
      "postgres: alice secretdb 127.0.0.1(5432) idle",
      "codex",
      "Cursor Helper (Plugin): 4c1d-9a (agent-exec)",
      "/Applications/Cursor.app/Contents/MacOS/Cursor",
      "claude",
      "claude",
      "",
    ].join("\n");
    const running = watchedInPs(stdout);
    expect(running).toEqual({ ok: true, running: ["claude", "cursor", "codex"] });
    expect(JSON.stringify(running)).not.toMatch(/secretdb|alice|agent-exec|4c1d/);
  });

  it("reads the Cursor CLI as cursor", () => {
    expect(watchedInPs("node\ncursor-agent\n")).toEqual({ ok: true, running: ["cursor"] });
  });

  it("a list longer than the cap is too large, never a complete list without the process", () => {
    const filler = Array.from({ length: MAX_PROCESS_ENTRIES }, () => "node");
    // The watched process sits past the cap: reading only the first part would miss it.
    const over = [...filler, "claude"].join("\n");
    expect(watchedInPs(over)).toEqual({ ok: false, reason: "too-large" });
    const overTasklist = [...filler, "claude.exe"].map((n) => `"${n}","1"`).join("\r\n");
    expect(watchedInTasklist(overTasklist)).toEqual({ ok: false, reason: "too-large" });
  });

  it("a list at the cap is complete, and blank lines do not count", () => {
    const atCap = [...Array.from({ length: MAX_PROCESS_ENTRIES - 1 }, () => "node"), "claude"];
    expect(watchedInPs(`${atCap.join("\n")}\n\n\n`)).toEqual({ ok: true, running: ["claude"] });
  });

  it("processNames passes a too-large list on as a reason", async () => {
    const stdout = Array.from({ length: MAX_PROCESS_ENTRIES + 1 }, () => "node").join("\n");
    const io = createRealVerifyIO({
      exec: () => Promise.resolve({ kind: "ok", stdout }),
      platform: "darwin",
      env: { PATH: "/bin" },
      isExecutable: (path) => path === "/bin/ps",
    });
    expect(await io.processNames()).toEqual({ ok: false, reason: "too-large" });
  });

  it("output over the byte cap is too large too", async () => {
    const io = createRealVerifyIO({
      exec: () => Promise.resolve({ kind: "too-large" }),
      platform: "darwin",
      env: { PATH: "/bin" },
      isExecutable: (path) => path === "/bin/ps",
    });
    expect(await io.processNames()).toEqual({ ok: false, reason: "too-large" });
  });

  it("reads tasklist output down to ids", () => {
    expect(
      watchedInTasklist(
        '"node.exe","123","Console","1","10,000 K"\r\n"Cursor.exe","9","C","1","1 K"\r\n"codex.exe","7","C","1","1 K"\r\n',
      ),
    ).toEqual({ ok: true, running: ["cursor", "codex"] });
  });

  it("runs ps, or tasklist on Windows, each by absolute path", async () => {
    const unix = recorder("node\nclaude\n");
    expect(
      await createRealVerifyIO({
        exec: unix.exec,
        platform: "darwin",
        env: { PATH: "/bin:/usr/bin" },
        isExecutable: (path) => path === "/bin/ps",
      }).processNames(),
    ).toEqual({ ok: true, running: ["claude"] });
    expect(unix.calls.map((c) => [c.file, ...c.args])).toEqual([["/bin/ps", "-axo", "comm="]]);
    const win = recorder('"node.exe","1"\r\n');
    expect(
      await createRealVerifyIO({
        exec: win.exec,
        platform: "win32",
        env: { Path: "C:\\Windows\\system32;C:\\Windows" },
        isExecutable: (path) => path === "C:\\Windows\\system32\\tasklist.exe",
      }).processNames(),
    ).toEqual({ ok: true, running: [] });
    expect(win.calls.map((c) => [c.file, ...c.args])).toEqual([
      ["C:\\Windows\\system32\\tasklist.exe", "/fo", "csv", "/nh"],
    ]);
  });

  it("a ps that is not on PATH is missing, and nothing runs", async () => {
    const { exec, calls } = recorder();
    const io = createRealVerifyIO({ exec, env: { PATH: "/none" }, isExecutable: () => false });
    expect(await io.processNames()).toEqual({ ok: false, reason: "missing" });
    expect(calls).toEqual([]);
  });

  it("a process list that cannot be read is a reason", async () => {
    const io = createRealVerifyIO({ exec: () => Promise.resolve({ kind: "missing" }) });
    expect(await io.processNames()).toEqual({ ok: false, reason: "missing" });
  });

  it("reads this machine's list as ids", async () => {
    const result = await createRealVerifyIO().processNames();
    expect(result.ok).toBe(true);
    if (result.ok) {
      for (const id of result.running) expect(["claude", "cursor", "codex"]).toContain(id);
    }
  });
});
