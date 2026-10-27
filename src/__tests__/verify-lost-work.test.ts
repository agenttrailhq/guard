// cspell:words worktrees
/**
 * Lost work (`core/verify/lost-work.ts`): force-deleted branches and dropped stashes looked up in
 * a real temporary repository, and discarded paths classed by where they were. Each with the
 * ran / mentioned / unknown split.
 *
 * The destructive-looking commands here are test data, held in strings and never run by the
 * check; the repositories are built and changed by running `git` from the test.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cardsFor, pickHeadline } from "../core/verify/cards.js";
import { GIT_CARD_BUILDERS } from "../core/verify/git-checks.js";
import type { CardExtras } from "../core/verify/git-copy.js";
import {
  discardedPaths,
  forceDeletesBranch,
  LOST_WORK_TEMPLATES,
  type LostWorkFacts,
  lostWorkCard,
} from "../core/verify/lost-work.js";
import { shellCommands } from "../core/verify/shell-words.js";
import { UNAVAILABLE_VERIFY_IO } from "../core/verify/verify.js";
import {
  checkedOf,
  commitLine,
  type GitSession,
  git,
  makeRepo,
  quoted,
  rev,
  runChecks,
  tempFolder,
} from "./git-check-fixtures.js";

/** The context of a scan whose results are recorded. */
const TOOL_RESULT = { ranEvidence: "tool-result" } as const;

/** The lost-work result for sessions. */
async function lost(
  sessions: readonly GitSession[],
  options: { agent?: "claude" | "codex" | "cursor"; scratchRoots?: readonly string[] } = {},
) {
  const outcome = await runChecks(options.agent ?? "claude", sessions, tempFolder("home"), {
    scratchRoots: options.scratchRoots ?? [],
  });
  return {
    result: checkedOf(outcome["lost-work"]),
    facts: checkedOf(outcome["lost-work"]).facts,
    fixes: outcome.localFixes.filter((f) => f.category === "lost-work").map((f) => f.command),
  };
}

/** A repo with a branch force-deleted from the test, and what `git branch -D` printed. */
function deletedBranch(label: string, name = "feature/x") {
  const root = makeRepo(label);
  git(root, "switch", "-q", "-c", name);
  commitLine(root, "f.txt", "feature work");
  const commit = rev(root, "HEAD");
  git(root, "switch", "-q", "main");
  const output = git(root, "branch", "-D", name);
  return { root, commit, output, name };
}

/** A repo with a stash dropped from the test, and what `git stash drop` printed. */
function droppedStash(label: string) {
  const root = makeRepo(label, { files: { "a.txt": "one\n" } });
  // Stash a change to a tracked file, then drop it.
  writeFileSync(join(root, "a.txt"), "two\n");
  git(root, "stash", "push", "-q", "-m", "wip");
  const stash = rev(root, "refs/stash");
  const output = git(root, "stash", "drop");
  return { root, stash, output };
}

const BRANCH_D = "git branch -D feature/x";

describe("forceDeletesBranch and discardedPaths", () => {
  const args = (text: string) => shellCommands(text)[0]?.words.slice(2) ?? [];

  it.each([
    ["git branch -D x", true],
    ["git branch -d -f x", true],
    ["git branch -df x", true],
    ["git branch --delete --force x", true],
    ["git branch -d x", false],
    ["git branch -D -r origin/x", false],
    ["git branch -Dr origin/x", false],
    ["git branch --list", false],
  ])("%s → %s", (text, expected) => {
    expect(forceDeletesBranch(args(text))).toBe(expected);
  });

  it.each([
    ["git checkout -- a.ts b.ts", ["a.ts", "b.ts"]],
    ["git checkout HEAD -- a.ts", ["a.ts"]],
    ["git checkout -- .", "all"],
    ["git checkout .", "all"],
    ["git checkout main", undefined],
    ["git checkout --", undefined],
    ["git restore a.ts", ["a.ts"]],
    ["git restore --source HEAD~1 a.ts", ["a.ts"]],
    ["git restore --staged a.ts", undefined],
    ["git restore --staged --worktree a.ts", ["a.ts"]],
    ["git restore .", "all"],
    ["git reset --hard", "all"],
    ["git reset --hard HEAD~1", "all"],
    ["git reset --soft HEAD~1", undefined],
    ["git checkout -f main", "all"],
    ["git checkout --force main", "all"],
    ["git switch --discard-changes main", "all"],
    ["git switch -f main", "all"],
    ["git switch main", undefined],
    ["git clean -fd", "all"],
    ["git clean -f build", ["build"]],
    ["git clean -fdn", undefined],
    ["git clean -d", undefined],
  ])("%s → %j", (text, expected) => {
    const [cmd] = shellCommands(text);
    const sub = cmd?.words[1]?.value ?? "";
    const got = discardedPaths(sub, cmd?.words.slice(2) ?? []);
    expect(got === "all" || got === undefined ? got : got.map((w) => w.value)).toEqual(expected);
  });
});

describe("force-deleted branches, against a real repository", () => {
  it("one whose commit is on no branch is recoverable: act, with the exact command kept local", async () => {
    const { root, commit, output } = deletedBranch("lw-branch");
    expect(output).toMatch(/^Deleted branch feature\/x \(was [0-9a-f]+\)\./);
    const { result, facts, fixes } = await lost([
      { cwd: root, events: [{ kind: "bash", command: BRANCH_D, output }] },
    ]);
    expect(facts.branches).toEqual({
      calls: { ran: 1, mentioned: 0, unknown: 0 },
      deleted: 1,
      notIdentified: 0,
      failed: 0,
      recoverable: 1,
      onAnotherRef: 0,
      gone: 0,
      couldNotCheck: 0,
    });
    expect(result.status).toBe("act");
    expect(fixes).toEqual([quoted("git", "-C", root, "branch", "recovered/feature/x", commit)]);

    const card = lostWorkCard(result, { ranEvidence: "tool-result" });
    expect(card.headline).toEqual({
      basis: "recoverable-deleted-work",
      count: 1,
      restsOnCodexRan: false,
      // The commit is still in the object store: git says so, not the command.
      confirmedBy: "git-state",
      sentence: {
        template: "lost-work.headline",
        text: "1 deleted branch or stash can still be recovered.",
      },
    });
    expect(card.fixes).toEqual([{ shape: "git branch recovered/<name> <sha>" }]);
    expect(JSON.stringify(card)).not.toContain("feature/x");
    expect(JSON.stringify(card)).not.toContain(commit.slice(0, 7));
  });

  it("one whose commit is still on another branch is not lost", async () => {
    const root = makeRepo("lw-other");
    git(root, "switch", "-q", "-c", "feature/x");
    commitLine(root, "f.txt", "work");
    git(root, "branch", "keep");
    git(root, "switch", "-q", "main");
    const output = git(root, "branch", "-D", "feature/x");
    const { facts, result } = await lost([
      { cwd: root, events: [{ kind: "bash", command: BRANCH_D, output }] },
    ]);
    expect(facts.branches.onAnotherRef).toBe(1);
    expect(facts.branches.recoverable).toBe(0);
    expect(result.status).toBe("clean");
  });

  it("after a quote inside a $(…) inside double quotes, the deletion is still read", async () => {
    const { root, output } = deletedBranch("lw-quoted-subst");
    const { facts, result } = await lost([
      {
        cwd: root,
        events: [{ kind: "bash", command: `X="$(printf '"')"; ${BRANCH_D}`, output }],
      },
    ]);
    expect(facts.branches.deleted).toBe(1);
    expect(facts.branches.recoverable).toBe(1);
    expect(result.status).toBe("act");
  });

  it("a merged branch's commit is on main: not lost", async () => {
    const root = makeRepo("lw-merged");
    git(root, "switch", "-q", "-c", "feature/x");
    commitLine(root, "f.txt", "work");
    git(root, "switch", "-q", "main");
    git(root, "merge", "-q", "--ff-only", "feature/x");
    const output = git(root, "branch", "-D", "feature/x");
    const { facts } = await lost([
      { cwd: root, events: [{ kind: "bash", command: BRANCH_D, output }] },
    ]);
    expect(facts.branches.onAnotherRef).toBe(1);
  });

  it("one no longer in the object store is gone", async () => {
    const root = makeRepo("lw-gone");
    const output = "Deleted branch feature/x (was 0123456789ab).\n";
    const { facts } = await lost([
      { cwd: root, events: [{ kind: "bash", command: BRANCH_D, output }] },
    ]);
    expect(facts.branches.gone).toBe(1);
  });

  it("a name unsafe for a command gets no recovery command", async () => {
    const { root, output } = deletedBranch("lw-name");
    const odd = output.replace("feature/x", "feature/..x");
    const { fixes } = await lost([
      { cwd: root, events: [{ kind: "bash", command: BRANCH_D, output: odd }] },
    ]);
    expect(fixes).toEqual([]);
  });

  it("a deletion that printed no branch is not identified, never clean", async () => {
    const root = makeRepo("lw-quiet");
    const { facts, result } = await lost([
      { cwd: root, events: [{ kind: "bash", command: BRANCH_D, output: "" }] },
    ]);
    expect(facts.branches.notIdentified).toBe(1);
    expect(result.status).toBe("could-not-check");
  });

  it("a deletion that ended in an error and deleted nothing is failed, not unidentified", async () => {
    const root = makeRepo("lw-failed");
    const { facts, result } = await lost([
      {
        cwd: root,
        events: [
          {
            kind: "bash",
            command: BRANCH_D,
            output: "Exit code 1\nerror: branch 'feature/x' not found",
            error: true,
          },
          {
            kind: "bash",
            command: "git stash drop",
            output: "Exit code 1\nNo stash entries found.",
            error: true,
          },
        ],
      },
    ]);
    expect(facts.branches).toMatchObject({ failed: 1, notIdentified: 0, deleted: 0 });
    expect(facts.stashes).toMatchObject({ failed: 1, notIdentified: 0, dropped: 0 });
    expect(result.status).toBe("clean");
    const card = lostWorkCard(result, TOOL_RESULT);
    expect(card.found.map((s) => s.template)).toContain("lost-work.failed");
  });

  it("a branch named like the short id, pointing elsewhere, is could-not-check, never the wrong commit", async () => {
    const { root, commit, output } = deletedBranch("lw-shadow");
    const short = commit.slice(0, 7);
    expect(output).toContain(`(was ${short})`);
    // A branch whose name is the short id, on another commit: git reads the name first.
    git(root, "branch", short, "main");
    const { facts, fixes } = await lost([
      { cwd: root, events: [{ kind: "bash", command: BRANCH_D, output }] },
    ]);
    expect(facts.branches).toMatchObject({ deleted: 1, recoverable: 0, couldNotCheck: 1 });
    expect(fixes).toEqual([]);
  });

  it("one call deleting branches in two repos cannot say which id is whose", async () => {
    const a = deletedBranch("lw-two-a");
    const b = deletedBranch("lw-two-b");
    const { facts, result } = await lost([
      {
        cwd: a.root,
        events: [
          {
            kind: "bash",
            command: `${BRANCH_D} && git -C ${b.root} branch -D feature/x`,
            output: `${a.output}${b.output}`,
          },
        ],
      },
    ]);
    expect(facts.branches).toMatchObject({ notIdentified: 1, deleted: 0, recoverable: 0 });
    expect(result.status).toBe("could-not-check");
  });
});

describe("dropped stashes, against a real repository", () => {
  it("one still in the object store and not listed is recoverable", async () => {
    const { root, stash, output } = droppedStash("lw-stash");
    expect(output).toMatch(/^Dropped refs\/stash@\{0\} \([0-9a-f]{40}\)/);
    const { facts, result, fixes } = await lost([
      { cwd: root, events: [{ kind: "bash", command: "git stash drop", output }] },
    ]);
    expect(facts.stashes).toEqual({
      calls: { ran: 1, mentioned: 0, unknown: 0 },
      dropped: 1,
      cleared: 0,
      notIdentified: 0,
      failed: 0,
      recoverable: 1,
      listed: 0,
      gone: 0,
      couldNotCheck: 0,
    });
    expect(result.status).toBe("act");
    expect(fixes).toEqual([quoted("git", "-C", root, "stash", "store", "-m", "recovered", stash)]);
    expect(lostWorkCard(result, { ranEvidence: "tool-result" }).fixes).toEqual([
      { shape: "git stash store -m recovered <sha>" },
    ]);
  });

  it("one stored back is listed, so not lost", async () => {
    const { root, stash, output } = droppedStash("lw-stash-back");
    git(root, "stash", "store", "-m", "back", stash);
    const { facts, result } = await lost([
      { cwd: root, events: [{ kind: "bash", command: "git stash drop stash@{0}", output }] },
    ]);
    expect(facts.stashes.listed).toBe(1);
    expect(result.status).toBe("clean");
  });

  it("git stash clear prints no ids: counted, and never clean", async () => {
    const root = makeRepo("lw-clear");
    const { facts, result } = await lost([
      { cwd: root, events: [{ kind: "bash", command: "git stash clear", output: "" }] },
    ]);
    expect(facts.stashes.cleared).toBe(1);
    expect(result.status).toBe("could-not-check");
  });

  it("git stash pop is not a drop", async () => {
    const root = makeRepo("lw-pop");
    const { facts } = await lost([
      { cwd: root, events: [{ kind: "bash", command: "git stash pop", output: "" }] },
    ]);
    expect(facts.stashes.calls).toEqual({ ran: 0, mentioned: 0, unknown: 0 });
  });
});

describe("discarded paths, classed by where they were", () => {
  it("in the main checkout, with no agent edit on record: review", async () => {
    const root = tempFolder("main");
    const { facts, result } = await lost([
      {
        cwd: root,
        events: [{ kind: "bash", command: "git checkout -- src/a.ts src/b.ts", output: "" }],
      },
    ]);
    expect(facts.discards).toEqual({
      calls: { ran: 1, mentioned: 0, unknown: 0 },
      paths: 2,
      ownCopy: 0,
      agentEdited: 0,
      mainCheckout: 2,
      couldNotCheck: 0,
    });
    expect(result.status).toBe("review");
    // Nothing to recover by id, so no headline.
    expect(lostWorkCard(result, { ranEvidence: "tool-result" }).headline).toBeUndefined();
  });

  it("files the agent had edited earlier, in this session or another", async () => {
    const root = tempFolder("edited");
    const { facts } = await lost([
      { cwd: root, events: [{ kind: "edit", path: join(root, "src", "b.ts"), newString: "x" }] },
      {
        cwd: root,
        events: [
          { kind: "write", path: join(root, "src", "a.ts"), content: "x" },
          { kind: "bash", command: "git checkout -- src/a.ts src/b.ts", output: "" },
          { kind: "bash", command: "git restore src/c.ts", output: "" },
        ],
      },
    ]);
    expect(facts.discards).toMatchObject({ paths: 3, agentEdited: 2, mainCheckout: 1 });
  });

  it("an edit made after the discard in the same session does not count", async () => {
    const root = tempFolder("after");
    const { facts } = await lost([
      {
        cwd: root,
        events: [
          { kind: "bash", command: "git checkout -- a.ts", output: "" },
          { kind: "write", path: join(root, "a.ts"), content: "x" },
        ],
      },
    ]);
    expect(facts.discards.mainCheckout).toBe(1);
  });

  it("a whole-tree discard in the main checkout is the main checkout, whatever the agent edited", async () => {
    const root = makeRepo("tree");
    for (const command of [
      "git reset --hard",
      "git checkout -f main",
      "git switch --discard-changes main",
      "git clean -fd",
    ]) {
      const { facts, result } = await lost([
        {
          cwd: join(root),
          events: [
            { kind: "write", path: join(root, "a.txt"), content: "x" },
            { kind: "bash", command, output: "" },
          ],
        },
      ]);
      expect(facts.discards, command).toMatchObject({ paths: 1, agentEdited: 0, mainCheckout: 1 });
      expect(result.status, command).toBe("review");
    }
  });

  it("a whole-tree discard run from a subfolder is judged at the repo's top", async () => {
    const root = makeRepo("tree-sub", { files: { "pkg/a.txt": "a\n" } });
    const scratch = tempFolder("tree-sub-scratch");
    const { facts } = await lost(
      [
        {
          cwd: join(root, "pkg"),
          events: [{ kind: "bash", command: "git reset --hard", output: "" }],
        },
      ],
      { scratchRoots: [scratch] },
    );
    expect(facts.discards.mainCheckout).toBe(1);
  });

  it("the agent's own worktree, a scratch copy, or an agent worktree folder", async () => {
    const root = tempFolder("own");
    const scratch = tempFolder("scratch");
    const { facts, result } = await lost(
      [
        {
          cwd: root,
          events: [
            { kind: "bash", command: "git worktree add ../wt-copy -b try", output: "" },
            { kind: "bash", command: "cd ../wt-copy && git checkout -- a.ts", output: "" },
            { kind: "bash", command: `cd ${scratch} && git reset --hard`, output: "" },
            {
              kind: "bash",
              command: `git -C ${join(root, ".claude", "worktrees", "w1")} restore b.ts`,
              output: "",
            },
          ],
        },
      ],
      { scratchRoots: [scratch] },
    );
    expect(facts.discards).toMatchObject({ paths: 3, ownCopy: 3, mainCheckout: 0 });
    expect(result.status).toBe("clean");
  });

  it("a clone is the agent's own copy too", async () => {
    const root = tempFolder("clone");
    const { facts } = await lost([
      {
        cwd: root,
        events: [
          { kind: "bash", command: "git clone https://example.invalid/team/app.git", output: "" },
          { kind: "bash", command: "cd app && git checkout .", output: "" },
        ],
      },
    ]);
    expect(facts.discards.ownCopy).toBe(1);
  });

  it("a staged-only restore is not a discard", async () => {
    const root = tempFolder("staged");
    const { facts } = await lost([
      { cwd: root, events: [{ kind: "bash", command: "git restore --staged a.ts", output: "" }] },
    ]);
    expect(facts.discards.paths).toBe(0);
  });

  it("a discard whose folder cannot be told is could-not-check", async () => {
    const { facts, result } = await lost([
      { cwd: null, events: [{ kind: "bash", command: "git checkout -- a.ts", output: "" }] },
    ]);
    expect(facts.discards.couldNotCheck).toBe(1);
    expect(result.status).toBe("could-not-check");
  });
});

describe("ran, mentioned, unknown", () => {
  it("mentions are counted apart", async () => {
    const { root, output } = deletedBranch("lw-mention");
    const { facts, result } = await lost([
      {
        cwd: root,
        events: [
          { kind: "bash", command: `echo "${BRANCH_D}"`, output },
          { kind: "bash", command: "printf '%s\\n' 'git stash drop'", output: "" },
          { kind: "bash", command: `grep -rn "git checkout -- ." docs`, output: "" },
        ],
      },
    ]);
    expect(facts.branches.calls).toEqual({ ran: 0, mentioned: 1, unknown: 0 });
    expect(facts.stashes.calls).toEqual({ ran: 0, mentioned: 1, unknown: 0 });
    expect(facts.discards.calls).toEqual({ ran: 0, mentioned: 1, unknown: 0 });
    expect(facts.branches.deleted).toBe(0);
    expect(result.status).toBe("clean");
    const card = lostWorkCard(result, { ranEvidence: "tool-result" });
    expect(card.found.map((s) => s.text)).toContain(
      "3 matches only mentioned deleting work, and are not counted.",
    );
  });

  it("no recorded result is unknown, and keeps the check from clean", async () => {
    const { root, output } = deletedBranch("lw-unknown");
    const { facts, result } = await lost([
      { cwd: root, events: [{ kind: "bash", command: BRANCH_D, output, noResult: true }] },
    ]);
    expect(facts.branches.calls).toEqual({ ran: 0, mentioned: 0, unknown: 1 });
    expect(facts.branches.deleted).toBe(0);
    expect(result.status).toBe("could-not-check");
  });

  it("Cursor: unknown. Codex: ran, with no id to look up", async () => {
    const { root, output } = deletedBranch("lw-apps");
    const cursor = await lost([{ cwd: root, events: [{ kind: "bash", command: BRANCH_D }] }], {
      agent: "cursor",
    });
    expect(cursor.facts.branches.calls).toEqual({ ran: 0, mentioned: 0, unknown: 1 });
    const codex = await lost(
      [{ cwd: root, events: [{ kind: "bash", command: BRANCH_D, output }] }],
      { agent: "codex" },
    );
    expect(codex.facts.branches.calls.ran).toBe(1);
    expect(codex.facts.branches.notIdentified).toBe(1);
    expect(codex.result.status).toBe("could-not-check");
  });

  it("a machine that cannot be asked: could-not-check", async () => {
    const { root, output } = deletedBranch("lw-io");
    const outcome = await runChecks(
      "claude",
      [{ cwd: root, events: [{ kind: "bash", command: BRANCH_D, output }] }],
      tempFolder("home"),
      { io: UNAVAILABLE_VERIFY_IO },
    );
    expect(checkedOf(outcome["lost-work"]).facts.branches.couldNotCheck).toBe(1);
    expect(outcome["lost-work"].status).toBe("could-not-check");
  });
});

describe("the card", () => {
  const none = { ran: 0, mentioned: 0, unknown: 0 };
  /** Facts with every count zero, then `over` applied. */
  function facts(over: Partial<LostWorkFacts> = {}): LostWorkFacts {
    return {
      unsafeFixes: 0,
      hidingCalls: 0,
      hidingForms: [],
      branches: {
        calls: none,
        deleted: 0,
        notIdentified: 0,
        failed: 0,
        recoverable: 0,
        onAnotherRef: 0,
        gone: 0,
        couldNotCheck: 0,
      },
      stashes: {
        calls: none,
        dropped: 0,
        cleared: 0,
        notIdentified: 0,
        failed: 0,
        recoverable: 0,
        listed: 0,
        gone: 0,
        couldNotCheck: 0,
      },
      discards: {
        calls: none,
        paths: 0,
        ownCopy: 0,
        agentEdited: 0,
        mainCheckout: 0,
        couldNotCheck: 0,
      },
      ...over,
    };
  }
  const busy = facts({
    branches: {
      ...facts().branches,
      calls: { ran: 2, mentioned: 0, unknown: 0 },
      deleted: 2,
      recoverable: 1,
      onAnotherRef: 1,
    },
    stashes: {
      ...facts().stashes,
      calls: { ran: 1, mentioned: 0, unknown: 0 },
      dropped: 1,
      recoverable: 1,
    },
    discards: {
      calls: { ran: 1, mentioned: 0, unknown: 0 },
      paths: 1,
      ownCopy: 0,
      agentEdited: 0,
      mainCheckout: 1,
      couldNotCheck: 0,
    },
  });

  it("states what it found and what is there now, from templates", () => {
    const card = lostWorkCard(
      { status: "act", matches: 4, facts: busy },
      { ranEvidence: "tool-result" },
    ) as ReturnType<typeof lostWorkCard> & CardExtras;
    const ids = new Set(LOST_WORK_TEMPLATES.map((t) => t.id));
    for (const line of [...card.found, ...card.now, ...(card.fixSteps ?? [])]) {
      expect(ids.has(line.template)).toBe(true);
    }
    expect(card.found.map((s) => s.text)).toEqual([
      "2 branches were force-deleted.",
      "1 stash was dropped.",
      "Uncommitted changes to 1 path were discarded with git checkout, git restore, git reset --hard, git switch or git clean.",
    ]);
    expect(card.now.map((s) => s.text)).toEqual([
      "1 deleted branch is still in the repo and on no other branch: recoverable by commit id.",
      "1 dropped stash is still in the repo: recoverable by commit id.",
      "1 deleted branch is still on another branch or tag, so nothing is lost.",
      "1 discarded path was in a main checkout with no agent edit on record, so it may have held someone's own changes. Git keeps no copy of those.",
    ]);
    expect(card.headline?.count).toBe(2);
    expect(card.chip).toEqual({
      count: 2,
      label: {
        template: "lost-work.chip",
        text: "2 deleted branches or stashes still recoverable",
      },
    });
    expect(card.fixes).toEqual([
      { shape: "git branch recovered/<name> <sha>" },
      { shape: "git stash store -m recovered <sha>" },
    ]);
    expect(card.fixSteps?.map((s) => s.template)).toEqual([
      "lost-work.fix.recover",
      "lost-work.fix.discards",
    ]);
  });

  it("says once, in the frame's words, that it could not confirm when a call could hide a deletion", () => {
    const result = {
      status: "could-not-check" as const,
      matches: 0,
      facts: facts({ hidingCalls: 2, hidingForms: ["eval"] }),
    };
    // The builder writes no could-not-confirm line of its own.
    const built = lostWorkCard(result, { ranEvidence: "tool-result" });
    expect(built.found.filter((s) => s.template.endsWith("could-not-confirm"))).toEqual([]);
    // Through the frame, the card says it once.
    const pending = { status: "not-checked" } as const;
    const card = cardsFor(
      {
        matchedCalls: { ran: 2, mentioned: 0, unknown: 0 },
        resultsRecorded: true,
        ranEvidence: "tool-result",
        categories: {
          secrets: pending,
          "skipped-checks": pending,
          "lost-work": result,
          cloud: pending,
          "prod-infra": pending,
          tests: pending,
          destructive: pending,
          unreviewed: pending,
          egress: pending,
        },
      } as never,
      { ...GIT_CARD_BUILDERS, secrets: () => ({}) as never } as never,
    ).find((c) => c.category === "lost-work");
    const lines = (card?.found ?? [])
      .map((s) => s.text)
      .filter((t) => t.startsWith("Could not confirm"));
    expect(lines).toEqual([
      "Could not confirm: commands that ran, or may have run, here used eval, which can run commands this reading does not take apart, so this is not a clean result.",
    ]);
  });

  it("a recoverable count leads where a call could hide more, and the card still says so", () => {
    const pending = { status: "not-checked" } as const;
    const verification = (result: unknown, ranEvidence: "tool-result" | "output-record") =>
      ({
        matchedCalls: { ran: 3, mentioned: 0, unknown: 0 },
        resultsRecorded: true,
        ranEvidence,
        categories: {
          secrets: pending,
          "skipped-checks": pending,
          "lost-work": result,
          cloud: pending,
          "prod-infra": pending,
          tests: pending,
          destructive: pending,
          unreviewed: pending,
          egress: pending,
        },
      }) as never;
    const builders = { ...GIT_CARD_BUILDERS, secrets: () => ({}) as never } as never;
    const result = {
      status: "act" as const,
      matches: 4,
      facts: { ...busy, hidingCalls: 1, hidingForms: ["eval"] },
    };
    const card = cardsFor(verification(result, "tool-result"), builders).find(
      (c) => c.category === "lost-work",
    );
    // The recoverable commits are in the object store: git confirms them, not the commands.
    expect(card?.headline?.confirmedBy).toBe("git-state");
    expect(card?.unconfirmed).toEqual({ reason: "hiding-forms", forms: ["eval"], found: true });
    expect(pickHeadline(card === undefined ? [] : [card], TOOL_RESULT)?.category).toBe("lost-work");
    expect((card?.found ?? []).map((s) => s.text).filter((t) => t.startsWith("Could not"))).toEqual(
      [
        "Could not confirm all of it: commands that ran, or may have run, here used eval, which can run commands this reading does not take apart, so there may be more than this card shows.",
      ],
    );
    // Never on a Codex scan, git state or not.
    const codex = cardsFor(verification(result, "output-record"), builders);
    expect(pickHeadline(codex, { ranEvidence: "output-record" })).toBeUndefined();
  });

  it("a clean result states zero on its chip and makes no claim that can lead", () => {
    const card = lostWorkCard(
      { status: "clean", matches: 0, facts: facts() },
      { ranEvidence: "tool-result" },
    ) as ReturnType<typeof lostWorkCard> & CardExtras;
    expect(card.chip?.label.text).toBe("0 deleted branches or stashes still recoverable");
    expect(card.headline).toBeUndefined();
    expect(pickHeadline([card], TOOL_RESULT)).toBeUndefined();
    expect(card.found.map((s) => s.template)).toEqual(["lost-work.none"]);
  });

  it("a Codex count carries the caveat, and its claim never leads", () => {
    const card = lostWorkCard(
      { status: "act", matches: 4, facts: busy },
      { ranEvidence: "output-record" },
    );
    expect(card.codexCaveat).toBe(true);
    expect(card.headline?.restsOnCodexRan).toBe(true);
    expect(pickHeadline([card], TOOL_RESULT)).toBeUndefined();
  });
});
