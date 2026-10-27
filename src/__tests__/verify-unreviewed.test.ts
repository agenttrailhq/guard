// cspell:words gpgsign oneline fsmonitor gpgsig lnbm
/**
 * The unreviewed-code check (`core/verify/unreviewed.ts`): commits pushed straight to main, by
 * a push that ran, still on the remote's main branch as this machine last saw it.
 *
 * The repos are built here: a bare remote, a clone, real commits and real pushes, whose output
 * is what the synthetic transcript records. The allow-list entries the check uses are proved to
 * refuse everything but a validated commit id, range and main-branch ref.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkUnreviewed,
  pushedRefs,
  readPushes,
  unreviewedCard,
} from "../core/verify/unreviewed.js";
import { createRealVerifyIO, isAllowedGitCall } from "../verify-io.js";
import { type CommandEvent, callsOf, fakeIO, fixText, OK } from "./verify-command-fixtures.js";

/** `git`, quietly, with no signing and a fixed identity, in `cwd`. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  );
}

/** A push, with what it printed (git writes ref lines to stderr). */
function push(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["push", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return `${r.stdout}${r.stderr}`;
}

/** A bare remote with `main`, a clone of it, and one commit already pushed. */
function repos(): { work: string; remote: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "agenttrail-verify-push-")));
  const remote = join(base, "remote.git");
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", "--bare", remote]);
  const work = join(base, "work");
  execFileSync("git", ["clone", "-q", remote, work], { encoding: "utf8" });
  git(work, "symbolic-ref", "HEAD", "refs/heads/main");
  writeFileSync(join(work, "a.txt"), "one\n");
  git(work, "add", "a.txt");
  git(work, "commit", "-q", "-m", "one");
  push(work, "-q", "origin", "main");
  return { work, remote };
}

/** Two more commits on `main` in `work`. */
function twoCommits(work: string): void {
  for (const n of ["two", "three"]) {
    writeFileSync(join(work, `${n}.txt`), `${n}\n`);
    git(work, "add", `${n}.txt`);
    git(work, "commit", "-q", "-m", n);
  }
}

const PUSH = `git push origin ${"main"}`;

describe("reading pushes", () => {
  it("finds the remote, the folder and the destination, and skips a dry run", () => {
    expect(readPushes(`cd /r && ${PUSH}`)).toEqual([
      { remote: "origin", dir: "/r", dryRun: false, destinations: ["main"] },
    ]);
    expect(readPushes("git -C /r push -u upstream HEAD:refs/heads/main")).toEqual([
      { remote: "upstream", dir: "/r", dryRun: false, destinations: ["refs/heads/main"] },
    ]);
    expect(readPushes("git push")[0]?.remote).toBe("origin");
    expect(readPushes(`git push --dry-run origin main`)[0]?.dryRun).toBe(true);
    expect(readPushes("git status")).toEqual([]);
  });

  it.each([
    ["--signed alone is a flag", "git push --signed origin main"],
    ["--signed=<value> is one word", "git push --signed=if-asked origin main"],
    ["--signed after the remote", "git push origin --signed main"],
    ["-o takes the next word", "git push -o ci.skip origin main"],
  ])("%s: the remote and the destination are read", (_label, command) => {
    expect(readPushes(command)).toEqual([
      { remote: "origin", dir: undefined, dryRun: false, destinations: ["main"] },
    ]);
  });

  it("reads range lines, forced or not, and created branches, and nothing else", () => {
    const output = [
      "To example.invalid:org/repo.git",
      "   1a2b3c4..5d6e7f8  main -> main",
      " + 0123abc...89defab feature -> feature (forced update)",
      " * [new branch]      next -> next",
      " ! [rejected]        master -> master (fetch first)",
      "   ZZZZZZZ..5d6e7f8  main -> main",
    ].join("\n");
    expect(pushedRefs(output)).toEqual([
      { from: "1a2b3c4", to: "5d6e7f8", branch: "main" },
      { from: "0123abc", to: "89defab", branch: "feature" },
      { from: undefined, to: undefined, branch: "next" },
    ]);
  });

  it.each([
    ["a subshell", `(git push origin ${"main"})`],
    ["an if", `if git push origin ${"main"}; then echo ok; fi`],
    ["a background job before it", `sleep 1 & git push origin ${"main"}`],
    ["sudo -u", `sudo -u bot git push origin ${"main"}`],
    ["timeout", `timeout 30 git push origin ${"main"}`],
    // Flags of sudo that take no value.
    ["sudo -n", `sudo -n git push origin ${"main"}`],
    ["sudo -s -k -E", `sudo -s -k -E git push origin ${"main"}`],
    ["sudo -h with a host", `sudo -h build git push origin ${"main"}`],
    ["timeout -s with a signal", `timeout -s KILL 30 git push origin ${"main"}`],
    ["nice -n", `nice -n 5 git push origin ${"main"}`],
    ["env -u", `env -u GIT_DIR git push origin ${"main"}`],
  ])("finds a push inside %s", (_, command) => {
    expect(readPushes(command)).toEqual([
      { remote: "origin", dir: undefined, dryRun: false, destinations: ["main"] },
    ]);
  });
});

describe("pushes whose commits cannot be read", () => {
  const RANGE = "   1a2b3c4..5d6e7f8  main -> main";

  async function unreviewed(command: string, text: string) {
    const io = fakeIO({
      git: (_, args) =>
        args[0] === "rev-parse"
          ? "/r\n"
          : args[0] === "for-each-ref"
            ? "refs/remotes/origin/main\n"
            : "a\n",
    });
    const calls = await callsOf("claude", [[{ kind: "shell", command, result: { text } }]], {
      cwd: "/r",
    });
    return (await checkUnreviewed({ calls, io })).check;
  }

  it("a first push of main: a push to main, not checked, never clean", async () => {
    const check = await unreviewed(
      `git push -u origin ${"main"}`,
      " * [new branch]      main -> main",
    );
    expect(check.facts).toMatchObject({
      pushesToMain: 1,
      pushesNotChecked: 1,
      pushesCreatingMain: 1,
      commitsOnMain: 0,
    });
    expect(check.status).toBe("could-not-check");
    // The output was read: the line says the range is what is unknown.
    const lines = unreviewedCard(check, { ranEvidence: "tool-result" }).found.map((s) => s.text);
    expect(lines).toContain(
      "1 push created a main branch on the remote, so its output names no range of commits, and it was not checked.",
    );
    expect(lines.join("\n")).not.toContain("the output or the repo could not be read");
  });

  it("a first push and an unreadable one: each gets its own line", async () => {
    const calls = await callsOf("claude", [
      [
        {
          kind: "shell",
          command: `git push -u origin ${"main"}`,
          result: { text: " * [new branch]      main -> main" },
        },
        { kind: "shell", command: `git push origin ${"main"}`, result: { text: "To x" } },
      ],
    ]);
    const { check } = await checkUnreviewed({ calls, io: fakeIO() });
    expect(check.facts).toMatchObject({ pushesNotChecked: 2, pushesCreatingMain: 1 });
    expect(unreviewedCard(check, { ranEvidence: "tool-result" }).found.map((s) => s.text)).toEqual(
      expect.arrayContaining([
        "1 push created a main branch on the remote, so its output names no range of commits, and it was not checked.",
        "1 more push could not be checked: the output or the repo could not be read.",
      ]),
    );
  });

  it("a recorded output with no ref line: not checked", async () => {
    const check = await unreviewed(`git push origin ${"main"}`, "To example.invalid:org/repo.git");
    expect(check.facts.pushesNotChecked).toBe(1);
    expect(check.status).toBe("could-not-check");
  });

  it("everything up to date: nothing pushed, and clean", async () => {
    const check = await unreviewed(`git push origin ${"main"}`, "Everything up-to-date");
    expect(check.facts).toMatchObject({ pushesToMain: 0, pushesNotChecked: 0 });
    expect(check.status).toBe("clean");
  });

  it.each([
    `(git push origin ${"main"})`,
    `if git push origin ${"main"}; then echo ok; fi`,
  ])("a push inside %s is read and checked", async (command) => {
    const check = await unreviewed(command, RANGE);
    expect(check.facts).toMatchObject({ pushesToMain: 1, commitsOnMain: 1 });
    expect(check.status).toBe("review");
  });
});

describe("against real repos", () => {
  it("commits pushed straight to main and still there: review, with the exact log command kept local", async () => {
    const { work } = repos();
    twoCommits(work);
    const output = push(work, "origin", "main");
    const [update] = pushedRefs(output);
    const calls = await callsOf(
      "claude",
      [[{ kind: "shell", command: PUSH, result: { text: output } }]],
      {
        cwd: work,
      },
    );
    const { check, localFixes } = await checkUnreviewed({ calls, io: createRealVerifyIO() });
    expect(check.facts).toMatchObject({
      pushesToMain: 1,
      commitsOnMain: 2,
      commitsNotOnMain: 0,
      pushesNotChecked: 0,
    });
    expect(check.status).toBe("review");
    expect(localFixes.map(fixText)).toEqual([
      `'git' '-C' '${work}' 'log' '--oneline' '${update?.to}' '--not' '${update?.from}'`,
    ]);
    const card = unreviewedCard(check, { ranEvidence: "tool-result" });
    expect(card.fixes).toEqual([{ shape: "git log --oneline <from>..<to>" }]);
    expect(JSON.stringify(card)).not.toContain(work);
  });

  it("commits the remote's main no longer contains are counted apart", async () => {
    const { work } = repos();
    const before = git(work, "rev-parse", "HEAD").trim();
    twoCommits(work);
    const output = push(work, "origin", "main");
    // Main is put back where it was, on the remote and in the remote-tracking ref.
    push(work, "-q", "--force", "origin", `${before}:main`);
    const calls = await callsOf(
      "claude",
      [[{ kind: "shell", command: PUSH, result: { text: output } }]],
      {
        cwd: work,
      },
    );
    const { check } = await checkUnreviewed({ calls, io: createRealVerifyIO() });
    expect(check.facts).toMatchObject({ pushesToMain: 1, commitsOnMain: 0, commitsNotOnMain: 2 });
    expect(check.status).toBe("clean");
  });

  it("a push to another branch is not counted", async () => {
    const { work } = repos();
    git(work, "checkout", "-q", "-b", "feature");
    twoCommits(work);
    push(work, "-q", "origin", "feature");
    writeFileSync(join(work, "four.txt"), "four\n");
    git(work, "add", "four.txt");
    git(work, "commit", "-q", "-m", "four");
    const output = push(work, "origin", "feature");
    const calls = await callsOf(
      "claude",
      [[{ kind: "shell", command: "git push origin feature", result: { text: output } }]],
      { cwd: work },
    );
    const { check } = await checkUnreviewed({ calls, io: createRealVerifyIO() });
    expect(check.facts).toMatchObject({ pushesToMain: 0, commitsOnMain: 0, pushesNotChecked: 0 });
    expect(check.status).toBe("clean");
  });

  it("a commit id the repo does not have is not checked, never clean", async () => {
    const { work } = repos();
    const calls = await callsOf(
      "claude",
      [[{ kind: "shell", command: PUSH, result: { text: "   abcdef0..1234567  main -> main" } }]],
      { cwd: work },
    );
    const { check } = await checkUnreviewed({ calls, io: createRealVerifyIO() });
    expect(check.facts.pushesNotChecked).toBe(1);
    expect(check.status).toBe("could-not-check");
  });
});

describe("what is never asked, and what is not a push that ran", () => {
  const output: CommandEvent = {
    kind: "shell",
    command: PUSH,
    result: { text: "   1a2b3c4..5d6e7f8  main -> main" },
  };

  it.each([
    "git push ../elsewhere main",
    "git push upstream main",
  ])("a push to a remote other than origin is not checked: %s", async (command) => {
    const io = fakeIO({ git: () => "/r\n" });
    const calls = await callsOf("claude", [[{ ...output, command } as CommandEvent]], {
      cwd: "/r",
    });
    const { check } = await checkUnreviewed({ calls, io });
    expect(check.facts.pushesNotChecked).toBe(1);
    expect(check.status).toBe("could-not-check");
    expect(io.gitCalls.map((c) => c.args[0])).toEqual(["rev-parse"]);
  });

  it("only the allow-listed calls are made, with validated arguments", async () => {
    const io = fakeIO({
      git: (_, args) =>
        args[0] === "rev-parse"
          ? "/r\n"
          : args[0] === "for-each-ref"
            ? "refs/remotes/origin/main\n"
            : "a\nb\nc\n",
    });
    const calls = await callsOf("claude", [[output]], { cwd: "/r" });
    const { check } = await checkUnreviewed({ calls, io });
    expect(check.facts.commitsOnMain).toBe(3);
    for (const call of io.gitCalls) expect(isAllowedGitCall(call.args)).toBe(true);
    expect(io.gitCalls.map((c) => c.args)).toEqual([
      ["rev-parse", "--show-toplevel"],
      [
        "for-each-ref",
        "--contains",
        "5d6e7f8",
        "--format=%(refname)",
        "refs/remotes/origin/main",
        "refs/remotes/origin/master",
      ],
      ["log", "--format=%H", "--max-count=1000", "5d6e7f8", "--not", "1a2b3c4"],
    ]);
  });

  it("mentioned in a heredoc, unconfirmed, or a dry run: not counted", async () => {
    const calls = await callsOf("claude", [
      [
        { kind: "shell", command: `cat > notes.md <<EOF\n${PUSH}\nEOF`, result: OK },
        { kind: "shell", command: PUSH },
        { kind: "shell", command: `git push --dry-run origin ${"main"}`, result: output.result },
      ],
    ]);
    const { check } = await checkUnreviewed({ calls, io: fakeIO() });
    expect(check.facts).toMatchObject({ pushesToMain: 0, mentioned: 1, unconfirmed: 1 });
    expect(check.status).toBe("could-not-check");
  });

  it("Codex: the reader keeps no output text, so a push that could have gone to main is not checked", async () => {
    const calls = await callsOf("codex", [
      [
        { kind: "shell", command: PUSH, result: OK },
        { kind: "shell", command: "git push origin feature", result: OK },
      ],
    ]);
    const { check } = await checkUnreviewed({ calls, io: fakeIO() });
    expect(check.facts.pushesNotChecked).toBe(1);
    expect(check.status).toBe("could-not-check");
  });

  it("Cursor: unconfirmed, never clean", async () => {
    const calls = await callsOf("cursor", [[{ kind: "shell", command: PUSH }]]);
    const { check } = await checkUnreviewed({ calls, io: fakeIO() });
    expect(check.facts.unconfirmed).toBe(1);
    expect(check.status).toBe("could-not-check");
  });
});

describe("the allow-list entries", () => {
  const forEach = (sha: string) => [
    "for-each-ref",
    "--contains",
    sha,
    "--format=%(refname)",
    "refs/remotes/origin/main",
    "refs/remotes/origin/master",
  ];
  const log = (to: string, from: string) => [
    "log",
    "--format=%H",
    "--max-count=1000",
    to,
    "--not",
    from,
  ];

  it("allow a commit id in each sha slot", () => {
    expect(isAllowedGitCall(forEach("1a2b3c4"))).toBe(true);
    expect(isAllowedGitCall(forEach("a".repeat(64)))).toBe(true);
    expect(isAllowedGitCall(log("1a2b3c4", "5d6e7f8"))).toBe(true);
  });

  it.each([
    [forEach("HEAD")],
    [forEach("1a2b3c")],
    [forEach("1A2B3C4")],
    [forEach("a".repeat(65))],
    [forEach("-x")],
    [forEach("1a2b3c4..5d6e7f8")],
    [["for-each-ref", "--contains", "1a2b3c4", "--format=%(refname)", "refs/heads/main"]],
    [[...forEach("1a2b3c4").slice(0, 5), "refs/remotes/upstream/master"]],
    [[...forEach("1a2b3c4"), "--points-at=HEAD"]],
    [log("HEAD", "5d6e7f8")],
    [log("1a2b3c4", "main")],
    [log("1a2b3c4", "--all")],
    [["log", "--format=%H", "--max-count=1000", "1a2b3c4..5d6e7f8"]],
    [["log", "--format=%H", "--max-count=1000", "5d6e7f8", "--not", "1a2b3c4", "--output=/tmp/x"]],
    [["log", "--format=%H", "--max-count=1000", "5d6e7f8", "--all", "1a2b3c4"]],
    [["merge-base", "--is-ancestor", "1a2b3c4", "refs/remotes/origin/main"]],
  ])("refuses %j", (args) => {
    expect(isAllowedGitCall(args)).toBe(false);
  });

  it("start no program a repository's config names, a signature program included", async () => {
    // A repository whose config names a program for every hook it can, a commit carrying a
    // signature header, and origin/main pointing at it. Built here, in test code.
    const { work } = repos();
    const marker = join(work, "..", `planted-marker-${Date.now()}`);
    const script = join(work, "..", `planted-${Date.now()}.sh`);
    writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });
    for (const [key, value] of [
      ["log.showSignature", "true"],
      ["gpg.program", script],
      ["gpg.ssh.program", script],
      ["gpg.x509.program", script],
      ["core.fsmonitor", script],
      ["core.pager", script],
      ["diff.external", script],
      ["core.hooksPath", join(work, "..")],
    ] as const) {
      execFileSync("git", ["config", key, value], { cwd: work });
    }
    const tree = git(work, "rev-parse", "HEAD^{tree}").trim();
    const parent = git(work, "rev-parse", "HEAD").trim();
    const signed = [
      `tree ${tree}`,
      `parent ${parent}`,
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
      cwd: work,
      input: signed,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", sha], { cwd: work });

    const io = createRealVerifyIO();
    expect((await io.git(work, ["rev-parse", "--show-toplevel"])).ok).toBe(true);
    const contains = await io.git(work, forEach(sha));
    const range = await io.git(work, log(sha, parent));
    expect(contains).toEqual({ ok: true, stdout: "refs/remotes/origin/main\n" });
    expect(range).toEqual({ ok: true, stdout: `${sha}\n` });
    expect(existsSync(marker)).toBe(false);

    // Negative control: a plain log of the same commit does start the planted program.
    try {
      execFileSync("git", ["log", "-1", sha], { cwd: work, stdio: "pipe" });
    } catch {
      // A failed signature check exits non-zero; only whether the program ran matters.
    }
    expect(existsSync(marker)).toBe(true);
  });
});
