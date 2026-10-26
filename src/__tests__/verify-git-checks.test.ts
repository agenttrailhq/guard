// cspell:words fsmonitor gpgsig lnbm
/**
 * The git-backed checks together (`core/verify/git-checks.ts`): every `git` call they make is on
 * the allow-list and none is refused; a repository's own config starts no program; they write
 * nothing; and they never throw, whatever the transcript holds or the machine answers.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isLocalFix } from "../core/verify/cards.js";
import { checkGitBacked, GIT_CARD_BUILDERS } from "../core/verify/git-checks.js";
import type { GitOutcome, VerifyIO } from "../core/verify/types.js";
import { isAllowedGitCall } from "../verify-io.js";
import {
  commitLine,
  corpusOf,
  type GitSession,
  git,
  makeRepo,
  rev,
  runChecks,
  setRemoteBranch,
  tempFolder,
  verifyIO,
} from "./git-check-fixtures.js";

/** A repo, and a session that ran one command of every kind the checks look up. */
function everything(label: string): { root: string; sessions: GitSession[] } {
  const root = makeRepo(label, {
    files: { "src/a.ts": "a\n", "README.md": "r\n" },
    hooks: ["pre-commit"],
  });
  git(root, "switch", "-q", "-c", "topic");
  commitLine(root, "t.txt", "topic work");
  git(root, "switch", "-q", "main");
  const deleted = git(root, "branch", "-D", "topic");
  writeFileSync(join(root, "README.md"), "changed\n");
  git(root, "stash", "push", "-q");
  const dropped = git(root, "stash", "drop");
  const committed = commitLine(root, "c.txt", "skip hooks", ["--no-verify"]);
  setRemoteBranch(root, "main", rev(root, "HEAD"));
  rmSync(join(root, "src"), { recursive: true });
  const sessions: GitSession[] = [
    {
      cwd: root,
      events: [
        { kind: "bash", command: "git branch -D topic", output: deleted },
        { kind: "bash", command: "git stash drop", output: dropped },
        { kind: "bash", command: `git commit --no-verify -m "skip hooks"`, output: committed },
        { kind: "bash", command: "git config core.hooksPath /dev/null", output: "" },
        { kind: "bash", command: "rm -rf src", output: "" },
        { kind: "bash", command: "git checkout -- README.md", output: "" },
      ],
    },
  ];
  return { root, sessions };
}

/** A `VerifyIO` that records every `git` call and its outcome. */
function recording(inner: VerifyIO): {
  io: VerifyIO;
  calls: { args: readonly string[]; out: GitOutcome }[];
} {
  const calls: { args: readonly string[]; out: GitOutcome }[] = [];
  return {
    calls,
    io: {
      ...inner,
      git: async (cwd, args) => {
        const out = await inner.git(cwd, args);
        calls.push({ args, out });
        return out;
      },
    },
  };
}

describe("every git call is allow-listed", () => {
  it("none is refused, and every check found what it was given", async () => {
    const home = tempFolder("home");
    const { sessions } = everything("all-calls");
    const { io, calls } = recording(verifyIO(home));
    const outcome = await runChecks("claude", sessions, home, { io });
    expect(calls.length).toBeGreaterThan(8);
    for (const call of calls) {
      expect(isAllowedGitCall(call.args), JSON.stringify(call.args)).toBe(true);
      expect(call.out).not.toEqual({ ok: false, reason: "refused" });
    }
    expect(new Set(calls.map((c) => c.args[0]))).toEqual(
      new Set(["rev-parse", "log", "for-each-ref", "stash", "ls-files"]),
    );
    expect(outcome["lost-work"].facts.branches.recoverable).toBe(1);
    expect(outcome["lost-work"].facts.stashes.recoverable).toBe(1);
    expect(outcome["skipped-checks"].facts.noVerify.onMain).toBe(1);
    expect(outcome.destructive.facts.rm.trackedGone).toBe(1);
    expect(outcome.localFixes.every(isLocalFix)).toBe(true);
    expect(outcome.localFixes.map((f) => f.category).sort()).toEqual([
      "destructive",
      "lost-work",
      "lost-work",
      "skipped-checks",
    ]);
  });
});

describe("a repository's own config starts no program", () => {
  it("fsmonitor, pager and external diff never run through any check", async () => {
    const home = tempFolder("home");
    const { root, sessions } = everything("hostile");
    const marker = join(tempFolder("marker"), "ran");
    const script = join(tempFolder("script"), "run.sh");
    writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    for (const [key, value] of [
      ["core.fsmonitor", script],
      ["core.pager", script],
      ["diff.external", script],
    ] as const) {
      git(root, "config", key, value);
    }
    const outcome = await runChecks("claude", sessions, home);
    expect(outcome.destructive.facts.rm.trackedGone).toBe(1);
    expect(existsSync(marker)).toBe(false);

    // Negative control: the same listing without the safety flags does start the monitor.
    execFileSync("git", ["ls-files", "--deleted", "-z"], { cwd: root, stdio: "pipe" });
    expect(existsSync(marker)).toBe(true);
  });
});

describe("a signed commit starts no signature program", () => {
  it("through the lost-work lookups: log for a deleted branch, stash list for a dropped stash", async () => {
    const home = tempFolder("home");
    const root = makeRepo("signed");
    const marker = join(tempFolder("gpg-marker"), "ran");
    const script = join(tempFolder("gpg-script"), "gpg.sh");
    writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });
    // A commit object carrying a signature header (any bytes will do), built in test code,
    // made the tip of a deleted branch and the newest entry of the stash list.
    const tree = rev(root, "HEAD^{tree}");
    const signed = execFileSync("git", ["hash-object", "-t", "commit", "--stdin", "-w"], {
      cwd: root,
      input: [
        `tree ${tree}`,
        `parent ${rev(root, "HEAD")}`,
        "author A <a@example.invalid> 1700000000 +0000",
        "committer A <a@example.invalid> 1700000000 +0000",
        "gpgsig -----BEGIN PGP SIGNATURE-----",
        " ",
        " c2lnbmF0dXJl",
        " -----END PGP SIGNATURE-----",
        "",
        "signed",
        "",
      ].join("\n"),
      encoding: "utf8",
    }).trim();
    git(root, "update-ref", "--create-reflog", "-m", "stash", "refs/stash", signed);
    git(root, "config", "log.showSignature", "true");
    git(root, "config", "gpg.program", script);
    const outcome = await runChecks(
      "claude",
      [
        {
          cwd: root,
          events: [
            {
              kind: "bash",
              command: "git branch -D topic",
              output: `Deleted branch topic (was ${signed.slice(0, 7)}).\n`,
            },
            {
              kind: "bash",
              command: "git stash drop",
              output: `Dropped refs/stash@{1} (${rev(root, "HEAD")})\n`,
            },
          ],
        },
      ],
      home,
    );
    // Both lookups ran: the branch's commit was found, and the stash list was read.
    expect(outcome["lost-work"].facts.branches.recoverable).toBe(1);
    expect(outcome["lost-work"].facts.stashes.dropped).toBe(1);
    expect(outcome["lost-work"].facts.stashes.couldNotCheck).toBe(0);
    expect(existsSync(marker)).toBe(false);

    // Negative control: the same lookup without the safety flags does run the program.
    try {
      execFileSync("git", ["log", "--no-walk", "--ignore-missing", "--format=%H", signed], {
        cwd: root,
        stdio: "pipe",
      });
    } catch {
      // A failed signature check may exit non-zero; only whether the program ran matters.
    }
    expect(existsSync(marker)).toBe(true);
  });
});

describe("the checks write nothing", () => {
  it("no file in the repo, and no index refresh", async () => {
    const home = tempFolder("home");
    const { root, sessions } = everything("no-write");
    const before = readdirSync(root).sort();
    const index = statSync(join(root, ".git", "index")).mtimeMs;
    const refs = git(root, "for-each-ref");
    await runChecks("claude", sessions, home);
    expect(readdirSync(root).sort()).toEqual(before);
    expect(statSync(join(root, ".git", "index")).mtimeMs).toBe(index);
    expect(git(root, "for-each-ref")).toBe(refs);
    expect(readdirSync(home)).toEqual([]);
  });
});

describe("never throws, never clean on a failure", () => {
  it("a seam that throws gives could-not-check for every git-backed category", async () => {
    const { root, sessions } = everything("throws");
    const broken: VerifyIO = {
      ...verifyIO(tempFolder("home")),
      git: () => Promise.reject(new Error("broken")),
    };
    const outcome = await checkGitBacked({
      corpus: corpusOf("claude", sessions),
      io: broken,
      home: tempFolder("home"),
      scratchRoots: [],
    });
    expect(outcome["skipped-checks"].status).toBe("could-not-check");
    expect(outcome["lost-work"].status).toBe("could-not-check");
    expect(outcome.destructive.status).toBe("could-not-check");
    expect(outcome.localFixes).toEqual([]);
    expect(existsSync(root)).toBe(true);
  });

  it("hostile and malformed commands are read without throwing", async () => {
    const odd = [
      "",
      "'",
      '"',
      "$(",
      "`",
      "<<",
      "<<EOF",
      ")(",
      "rm -rf",
      "rm -rf -- ",
      "git",
      "git -C",
      "git branch -D",
      "git commit -n",
      "psql -h",
      "docker exec",
      "ssh",
      "kubectl exec --",
      `git -C "$(printf x)" checkout -- "$(rm -rf /)"`,
      "a".repeat(100_000),
      `${"(".repeat(2_000)}rm -rf x${")".repeat(2_000)}`,
      `rm -rf ${"x/".repeat(5_000)}`,
      "\u0000\u0001 rm -rf ‮ x",
    ];
    for (const agent of ["claude", "codex", "cursor"] as const) {
      const outcome = await runChecks(
        agent,
        [
          {
            cwd: tempFolder("odd"),
            events: odd.map((command) => ({
              kind: "bash" as const,
              command,
              output: "Deleted branch x (was zz).",
            })),
          },
        ],
        tempFolder("home"),
      );
      expect(outcome.destructive.status).not.toBe("not-checked");
    }
  });
});

describe("the builders for the page's registry", () => {
  it("are exported for each git-backed category", () => {
    expect(Object.keys(GIT_CARD_BUILDERS).sort()).toEqual([
      "destructive",
      "lost-work",
      "skipped-checks",
    ]);
  });
});
