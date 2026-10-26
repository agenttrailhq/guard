// cspell:words cursorrules
/**
 * Skipped safety checks (`core/verify/skipped.ts`): `--no-verify` commits checked against a real
 * temporary repository, `HUSKY=0`, `core.hooksPath` changes, and instruction files that tell the
 * agent to skip checks. Each with the ran / mentioned / unknown split.
 *
 * The destructive-looking commands here are test data, held in strings and never run; the
 * repositories are built by running `git` from the test.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pickHeadline } from "../core/verify/cards.js";
import type { CardExtras } from "../core/verify/git-copy.js";
import { shellCommands } from "../core/verify/shell-words.js";
import {
  commitSkipsHooks,
  isInstructionFile,
  SKIPPED_CHECKS_TEMPLATES,
  type SkippedChecksFacts,
  skippedChecksCard,
  tellsToSkip,
} from "../core/verify/skipped.js";
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
  setRemoteBranch,
  tempFolder,
} from "./git-check-fixtures.js";

/** The context of a scan whose results are recorded. */
const TOOL_RESULT = { ranEvidence: "tool-result" } as const;

/** The skipped-checks result for sessions. */
async function skipped(
  sessions: readonly GitSession[],
  home = tempFolder("home"),
  agent: "claude" | "codex" | "cursor" = "claude",
) {
  const outcome = await runChecks(agent, sessions, home);
  return {
    result: checkedOf(outcome["skipped-checks"]),
    facts: checkedOf(outcome["skipped-checks"]).facts,
    fixes: outcome.localFixes.filter((f) => f.category === "skipped-checks").map((f) => f.command),
  };
}

/** A repo with a commit hook, and a `--no-verify` commit's printed line and full id. */
function noVerifyRepo(label: string, hooks: readonly string[] = ["pre-commit"]) {
  const root = makeRepo(label, { hooks });
  const first = rev(root, "HEAD");
  const output = commitLine(root, "a.txt", "change a", ["--no-verify"]);
  return { root, first, output, commit: rev(root, "HEAD") };
}

const COMMIT = `git commit --no-verify -m "change a"`;

describe("commitSkipsHooks", () => {
  const skips = (text: string) => commitSkipsHooks(shellCommands(text)[0]?.words.slice(2) ?? []);

  it.each([
    ["git commit --no-verify -m x", true],
    ["git commit -n -m x", true],
    ["git commit -nm x", true],
    ["git commit -anm x", true],
    ["git commit -m x -n", true],
    ["git commit -F msg.txt --no-verify", true],
    // The message itself blanked out, as the text that ran has it.
    ["git commit -m        --no-verify", true],
    ["git commit -m x", false],
    ["git commit -am x", false],
    ["git commit -mn", false],
    [`git commit -m "use --no-verify next time"`, false],
    [`git commit -m "-n is a flag"`, false],
    ["git commit -- --no-verify", false],
  ])("%s → %s", (text, expected) => {
    expect(skips(text)).toBe(expected);
  });
});

describe("--no-verify commits, against a real repository", () => {
  it("one that reached origin/main: act, with the headline and the exact command kept local", async () => {
    const { root, output, commit } = noVerifyRepo("nv-main");
    setRemoteBranch(root, "main", commit);
    const { result, facts, fixes } = await skipped([
      { cwd: root, events: [{ kind: "bash", command: COMMIT, output }] },
    ]);
    expect(facts.noVerify).toEqual({
      calls: { ran: 1, mentioned: 0, unknown: 0 },
      commits: 1,
      notIdentified: 0,
      withoutHooks: 0,
      onMain: 1,
      offMain: 0,
      noMainToCheck: 0,
      gone: 0,
      couldNotCheck: 0,
    });
    expect(result.status).toBe("act");
    expect(result.matches).toBe(1);
    expect(fixes).toEqual([quoted("git", "-C", root, "show", "--stat", commit)]);

    const card = skippedChecksCard(result, { ranEvidence: "tool-result" });
    expect(card.headline).toEqual({
      basis: "commits-on-main-without-checks",
      count: 1,
      restsOnCodexRan: false,
      sentence: {
        template: "skipped-checks.headline",
        text: "1 commit reached main without its checks.",
      },
    });
    expect(pickHeadline([card], TOOL_RESULT)?.category).toBe("skipped-checks");
    // The page and the JSON get the redacted shape; the real id and path stay local.
    expect(card.fixes).toEqual([{ shape: "git show --stat <sha>" }]);
    expect(JSON.stringify(card)).not.toContain(commit.slice(0, 7));
    expect(JSON.stringify(card)).not.toContain(root);
  });

  it("origin/master counts as main too", async () => {
    const { root, output, commit } = noVerifyRepo("nv-master");
    setRemoteBranch(root, "master", commit);
    const { facts } = await skipped([
      { cwd: root, events: [{ kind: "bash", command: COMMIT, output }] },
    ]);
    expect(facts.noVerify.onMain).toBe(1);
  });

  it("one not on origin/main: review, with no headline", async () => {
    const { root, first, output } = noVerifyRepo("nv-off");
    setRemoteBranch(root, "main", first);
    const { result, facts } = await skipped([
      { cwd: root, events: [{ kind: "bash", command: COMMIT, output }] },
    ]);
    expect(facts.noVerify.offMain).toBe(1);
    expect(facts.noVerify.onMain).toBe(0);
    expect(result.status).toBe("review");
    const card = skippedChecksCard(result, { ranEvidence: "tool-result" });
    expect(card.headline).toBeUndefined();
    expect(pickHeadline([card], TOOL_RESULT)).toBeUndefined();
  });

  it("a repo with no origin/main or origin/master to check against", async () => {
    const { root, output } = noVerifyRepo("nv-no-remote");
    const { facts, result } = await skipped([
      { cwd: root, events: [{ kind: "bash", command: COMMIT, output }] },
    ]);
    expect(facts.noVerify.noMainToCheck).toBe(1);
    expect(result.status).toBe("review");
  });

  it("a repo with no commit hook: nothing was skipped, so clean", async () => {
    const { root, output, commit } = noVerifyRepo("nv-no-hook", []);
    setRemoteBranch(root, "main", commit);
    const { facts, result } = await skipped([
      { cwd: root, events: [{ kind: "bash", command: COMMIT, output }] },
    ]);
    expect(facts.noVerify.withoutHooks).toBe(1);
    expect(facts.noVerify.onMain).toBe(0);
    expect(result.status).toBe("clean");
  });

  it("a pre-push hook alone is not a commit hook", async () => {
    const { root, output, commit } = noVerifyRepo("nv-pre-push", ["pre-push"]);
    setRemoteBranch(root, "main", commit);
    const { facts } = await skipped([
      { cwd: root, events: [{ kind: "bash", command: COMMIT, output }] },
    ]);
    expect(facts.noVerify.withoutHooks).toBe(1);
  });

  it("a commit no longer in the repo is gone, not on main", async () => {
    const root = makeRepo("nv-gone", { hooks: ["commit-msg"] });
    setRemoteBranch(root, "main", rev(root, "HEAD"));
    const output = "[main 0123456789ab] change a\n 1 file changed\n";
    const { facts } = await skipped([
      { cwd: root, events: [{ kind: "bash", command: COMMIT, output }] },
    ]);
    expect(facts.noVerify.gone).toBe(1);
  });

  it("a root commit's line is read too", async () => {
    const root = makeRepo("nv-root", { hooks: ["pre-commit"] });
    const commit = rev(root, "HEAD");
    setRemoteBranch(root, "main", commit);
    const output = `[main (root-commit) ${commit.slice(0, 7)}] first\n`;
    const { facts } = await skipped([
      { cwd: root, events: [{ kind: "bash", command: COMMIT, output }] },
    ]);
    expect(facts.noVerify.onMain).toBe(1);
  });

  it("follows cd and git -C to the repo the commit ran in", async () => {
    const { root, output, commit } = noVerifyRepo("nv-cd");
    setRemoteBranch(root, "main", commit);
    const elsewhere = tempFolder("elsewhere");
    const { facts } = await skipped([
      {
        cwd: elsewhere,
        events: [
          { kind: "bash", command: `cd ${root} && ${COMMIT}`, output },
          { kind: "bash", command: `git -C ${root} commit -n -m again`, output },
        ],
      },
    ]);
    expect(facts.noVerify.commits).toBe(2);
    // The same commit read twice is looked up once.
    expect(facts.noVerify.onMain).toBe(1);
  });

  it("a call with two commits, only one skipping hooks, cannot say which id is which", async () => {
    const { root, output } = noVerifyRepo("nv-ambiguous");
    const { facts, result } = await skipped([
      {
        cwd: root,
        events: [
          { kind: "bash", command: `git commit -m a && ${COMMIT}`, output: `${output}${output}` },
        ],
      },
    ]);
    expect(facts.noVerify.notIdentified).toBe(1);
    expect(facts.noVerify.commits).toBe(0);
    expect(result.status).toBe("could-not-check");
  });

  it("a commit that printed no id is not identified, never clean", async () => {
    const { root } = noVerifyRepo("nv-quiet");
    const { facts, result } = await skipped([
      { cwd: root, events: [{ kind: "bash", command: `${COMMIT} -q`, output: "" }] },
    ]);
    expect(facts.noVerify.notIdentified).toBe(1);
    expect(result.status).toBe("could-not-check");
  });
});

describe("ran, mentioned, unknown", () => {
  it("mentions are counted apart and not checked", async () => {
    const { root, output, commit } = noVerifyRepo("nv-mention");
    setRemoteBranch(root, "main", commit);
    const { facts, result } = await skipped([
      {
        cwd: root,
        events: [
          // The command written out in printed text, a search pattern, a heredoc and a comment.
          { kind: "bash", command: "echo 'git commit --no-verify -m x'", output },
          { kind: "bash", command: `grep -rn "git commit --no-verify" docs`, output: "" },
          {
            kind: "bash",
            command: "cat > notes.md <<'EOF'\ngit commit --no-verify -m x\nEOF",
            output: "",
          },
          { kind: "bash", command: "# git commit --no-verify\nls", output: "" },
          // A word alone is not a command: not even a mention.
          { kind: "bash", command: `grep -rn -e "--no-verify" docs`, output: "" },
        ],
      },
    ]);
    expect(facts.noVerify.calls).toEqual({ ran: 0, mentioned: 4, unknown: 0 });
    expect(facts.noVerify.commits).toBe(0);
    expect(facts.otherNoVerify).toEqual({ ran: 0, mentioned: 0, unknown: 0 });
    expect(result.status).toBe("clean");
    const card = skippedChecksCard(result, { ranEvidence: "tool-result" });
    expect(card.found.map((s) => s.template)).toContain("skipped-checks.mentioned");
  });

  it("a call with no recorded result is unknown, and keeps the check from clean", async () => {
    const { root } = noVerifyRepo("nv-unknown");
    const { facts, result } = await skipped([
      { cwd: root, events: [{ kind: "bash", command: COMMIT, noResult: true }] },
    ]);
    expect(facts.noVerify.calls).toEqual({ ran: 0, mentioned: 0, unknown: 1 });
    expect(result.status).toBe("could-not-check");
  });

  it("a refused call (an error with no exit code) is unknown, not ran", async () => {
    const { root, output } = noVerifyRepo("nv-refused");
    const { facts } = await skipped([
      {
        cwd: root,
        events: [{ kind: "bash", command: COMMIT, output: `blocked\n${output}`, error: true }],
      },
    ]);
    expect(facts.noVerify.calls.unknown).toBe(1);
    expect(facts.noVerify.commits).toBe(0);
  });

  it("Cursor records no results: every call is unknown", async () => {
    const { root } = noVerifyRepo("nv-cursor");
    const { facts, result } = await skipped(
      [{ cwd: root, events: [{ kind: "bash", command: COMMIT }] }],
      tempFolder("home"),
      "cursor",
    );
    expect(facts.noVerify.calls).toEqual({ ran: 0, mentioned: 0, unknown: 1 });
    expect(result.status).toBe("could-not-check");
  });

  it("Codex records that a call ran but not its output: ran, with no commit id to look up", async () => {
    const { root, output } = noVerifyRepo("nv-codex");
    const { facts, result } = await skipped(
      [{ cwd: root, events: [{ kind: "bash", command: COMMIT, output }] }],
      tempFolder("home"),
      "codex",
    );
    expect(facts.noVerify.calls.ran).toBe(1);
    expect(facts.noVerify.notIdentified).toBe(1);
    expect(result.status).toBe("could-not-check");
  });
});

describe("other --no-verify, HUSKY=0 and core.hooksPath", () => {
  it("a push with --no-verify that ran is review", async () => {
    const root = makeRepo("push");
    const { facts, result } = await skipped([
      {
        cwd: root,
        events: [
          { kind: "bash", command: "git push --no-verify origin main", output: "" },
          { kind: "bash", command: `echo "git push --no-verify"`, output: "" },
        ],
      },
    ]);
    expect(facts.otherNoVerify).toEqual({ ran: 1, mentioned: 1, unknown: 0 });
    expect(result.status).toBe("review");
  });

  it.each([
    ["HUSKY=0 git commit -m x", 1],
    ["env HUSKY=0 git push", 1],
    ["export HUSKY=0 && git commit -m x", 1],
    ["HUSKY_SKIP_HOOKS=1 git commit -m x", 1],
    ["HUSKY=1 git commit -m x", 0],
    ["git commit -m x", 0],
  ])("%s ran: husky %d", async (command, ran) => {
    const root = makeRepo("husky");
    const { facts } = await skipped([
      { cwd: root, events: [{ kind: "bash", command, output: "" }] },
    ]);
    expect(facts.husky.ran).toBe(ran);
  });

  it("HUSKY=0 only printed is mentioned", async () => {
    const root = makeRepo("husky-mention");
    const { facts } = await skipped([
      { cwd: root, events: [{ kind: "bash", command: `echo "HUSKY=0 git commit"`, output: "" }] },
    ]);
    expect(facts.husky).toEqual({ ran: 0, mentioned: 1, unknown: 0 });
  });

  it("hooks switched off and still off now: act, with the exact command kept local", async () => {
    const root = makeRepo("hooks-path-off", { hooks: ["pre-commit"] });
    git(root, "config", "core.hooksPath", "/dev/null");
    const { facts, result, fixes } = await skipped([
      {
        cwd: root,
        events: [
          { kind: "bash", command: "git config core.hooksPath /dev/null", output: "" },
          { kind: "bash", command: "git config --get core.hooksPath", output: "/dev/null" },
        ],
      },
    ]);
    expect(facts.hooksPath).toEqual({
      calls: { ran: 1, mentioned: 0, unknown: 0 },
      off: 1,
      on: 0,
      none: 0,
      couldNotCheck: 0,
    });
    expect(result.status).toBe("act");
    expect(fixes).toEqual([quoted("git", "-C", root, "config", "--unset", "core.hooksPath")]);
    const card = skippedChecksCard(result, { ranEvidence: "tool-result" });
    expect(card.fixes).toEqual([{ shape: "git config --unset core.hooksPath" }]);
    // Switching hooks off is not a commit that reached main: no headline claim.
    expect(card.headline).toBeUndefined();
  });

  it("hooks switched and back on now", async () => {
    const root = makeRepo("hooks-path-on", { hooks: ["pre-commit"] });
    const { facts, result } = await skipped([
      {
        cwd: root,
        events: [
          { kind: "bash", command: "git config core.hooksPath /dev/null", output: "" },
          { kind: "bash", command: "git config --unset core.hooksPath", output: "" },
        ],
      },
    ]);
    expect(facts.hooksPath.calls.ran).toBe(2);
    expect(facts.hooksPath.on).toBe(1);
    expect(facts.hooksPath.off).toBe(0);
    expect(result.status).toBe("clean");
  });

  it("hooks pointed at a folder that holds them are on", async () => {
    const root = makeRepo("hooks-path-husky");
    mkdirSync(join(root, ".husky"), { recursive: true });
    writeFileSync(join(root, ".husky", "pre-commit"), "#!/bin/sh\n");
    git(root, "config", "core.hooksPath", ".husky");
    const { facts } = await skipped([
      {
        cwd: root,
        events: [{ kind: "bash", command: "git config core.hooksPath .husky", output: "" }],
      },
    ]);
    expect(facts.hooksPath.on).toBe(1);
  });

  it("HUSKY=0 for one command in a repo whose hooks are on: review, hooks on", async () => {
    const root = makeRepo("husky-on", { hooks: ["pre-commit"] });
    const { facts, result } = await skipped([
      { cwd: root, events: [{ kind: "bash", command: "HUSKY=0 git commit -m x", output: "" }] },
    ]);
    expect(facts.husky.ran).toBe(1);
    expect(facts.hooksPath).toMatchObject({ off: 0, on: 1, none: 0 });
    expect(result.status).toBe("review");
  });

  it("HUSKY=0 in a repo whose hooks are switched off persistently: act", async () => {
    const root = makeRepo("husky-off", { hooks: ["pre-commit"] });
    git(root, "config", "core.hooksPath", "/dev/null");
    const { facts, result, fixes } = await skipped([
      { cwd: root, events: [{ kind: "bash", command: "HUSKY=0 git push", output: "" }] },
    ]);
    // The agent changed no config here, but hooks are off now where it skipped them.
    expect(facts.hooksPath).toMatchObject({ calls: { ran: 0, mentioned: 0, unknown: 0 }, off: 1 });
    expect(result.status).toBe("act");
    expect(fixes).toEqual([quoted("git", "-C", root, "config", "--unset", "core.hooksPath")]);
  });

  it("a repo with no hooks set up is neither on nor switched off", async () => {
    const root = makeRepo("husky-none");
    const { facts, result } = await skipped([
      { cwd: root, events: [{ kind: "bash", command: "HUSKY=0 git commit -m x", output: "" }] },
    ]);
    expect(facts.hooksPath).toMatchObject({ off: 0, on: 0, none: 1 });
    expect(result.status).toBe("review");
  });

  it("each repo is counted once, across every kind of skip", async () => {
    const { root, output } = noVerifyRepo("hooks-once");
    const { facts } = await skipped([
      {
        cwd: root,
        events: [
          { kind: "bash", command: COMMIT, output },
          { kind: "bash", command: "HUSKY=0 git push --no-verify", output: "" },
          { kind: "bash", command: `git -C ${root} config core.hooksPath .git/hooks`, output: "" },
        ],
      },
    ]);
    expect(facts.hooksPath).toMatchObject({ off: 0, on: 1, none: 0, couldNotCheck: 0 });
  });
});

describe("instruction files", () => {
  it.each([
    ["Use --no-verify when the hooks are slow.", true],
    ["Commit with HUSKY=0 to skip the hooks.", true],
    ["Run SKIP=eslint git commit when lint is flaky.", true],
    ["Point core.hooksPath at /dev/null.", true],
    ["Skip the pre-commit hooks on docs-only changes.", true],
    ["Bypass git hooks if they fail.", true],
    ["Never use --no-verify.", false],
    ["Don't skip hooks.", false],
    ["Do not bypass the pre-commit checks.", false],
    ["If hooks aren't active, run git config core.hooksPath .githooks", false],
    ["Run the checks before every commit.", false],
  ])("%s → %s", (text, expected) => {
    expect(tellsToSkip(text)).toBe(expected);
  });

  it.each([
    ["/r/CLAUDE.md", true],
    ["/r/sub/AGENTS.md", true],
    ["/r/.cursorrules", true],
    ["/h/.claude/projects/p/memory/feedback.md", true],
    ["/r/.cursor/rules/style.mdc", true],
    ["/r/.github/copilot-instructions.md", true],
    ["/r/README.md", false],
    ["/h/.claude/settings.json", false],
  ])("isInstructionFile(%s) → %s", (path, expected) => {
    expect(isInstructionFile(path)).toBe(expected);
  });

  it("a memory file the agent wrote, still saying so: act, with the path kept local", async () => {
    const home = tempFolder("home");
    const root = makeRepo("memory");
    const memory = join(home, ".claude", "projects", "p", "memory", "feedback.md");
    mkdirSync(join(memory, ".."), { recursive: true });
    const text = "Hooks are slow here.\nUse --no-verify when committing.\n";
    writeFileSync(memory, text);
    const { facts, result, fixes } = await skipped(
      [{ cwd: root, events: [{ kind: "write", path: memory, content: text }] }],
      home,
    );
    expect(facts.instructions).toMatchObject({
      sayToSkip: 1,
      agentWrote: 1,
      agentWroteStill: 1,
      agentWroteRemoved: 0,
      couldNotRead: 0,
    });
    expect(result.status).toBe("act");
    expect(fixes).toEqual([
      quoted("grep", "-n", "-i", "-E", "no-verify|HUSKY|SKIP=|hooks", memory),
    ]);
    const card = skippedChecksCard(result, { ranEvidence: "tool-result" });
    expect(card.fixes).toEqual([{ shape: "grep -n -i -E 'no-verify|HUSKY|SKIP=|hooks' <path>" }]);
    expect(JSON.stringify(card)).not.toContain(home);
  });

  it("one the agent wrote that no longer says so, or is gone, is removed", async () => {
    const home = tempFolder("home");
    const root = makeRepo("memory-removed");
    const kept = join(root, "CLAUDE.md");
    writeFileSync(kept, "Run the checks before every commit.\n");
    const gone = join(root, "AGENTS.md");
    const { facts, result } = await skipped(
      [
        {
          cwd: root,
          events: [
            { kind: "edit", path: kept, newString: "Use --no-verify." },
            { kind: "write", path: gone, content: "Commit with HUSKY=0." },
          ],
        },
      ],
      home,
    );
    expect(facts.instructions).toMatchObject({
      sayToSkip: 0,
      agentWrote: 2,
      agentWroteStill: 0,
      agentWroteRemoved: 2,
    });
    expect(result.status).toBe("clean");
  });

  it("an edit's replaced text is not what it wrote", async () => {
    const home = tempFolder("home");
    const root = makeRepo("memory-old");
    const file = join(root, "CLAUDE.md");
    writeFileSync(file, "Run the checks.\n");
    const { facts } = await skipped(
      [
        {
          cwd: root,
          events: [
            {
              kind: "edit",
              path: file,
              oldString: "Use --no-verify.",
              newString: "Run the checks.",
            },
          ],
        },
      ],
      home,
    );
    expect(facts.instructions.agentWrote).toBe(0);
  });

  it("standard files at the top of a repo and the home instruction file are read too", async () => {
    const home = tempFolder("home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "Skip the hooks on docs changes.\n");
    const root = makeRepo("standard", {
      files: { "AGENTS.md": "Never use --no-verify.\n", "README.md": "x\n" },
    });
    const { facts } = await skipped([{ cwd: root, events: [] }], home);
    expect(facts.instructions.read).toBe(2);
    expect(facts.instructions.sayToSkip).toBe(1);
    expect(facts.instructions.agentWrote).toBe(0);
  });

  it("a Cursor scan reads no Claude Code home file", async () => {
    const home = tempFolder("home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "Skip the hooks.\n");
    const { facts } = await skipped([{ cwd: null, events: [] }], home, "cursor");
    expect(facts.instructions.read).toBe(0);
  });
});

describe("what could not be checked is never clean", () => {
  it("a repo that is gone", async () => {
    const { facts, result } = await skipped([
      {
        cwd: join(tempFolder("gone"), "deleted-repo"),
        events: [{ kind: "bash", command: COMMIT, output: "[main 1234567] change a\n" }],
      },
    ]);
    expect(facts.noVerify.couldNotCheck).toBe(1);
    expect(result.status).toBe("could-not-check");
  });

  it("a session with no working directory", async () => {
    const { facts } = await skipped([
      {
        cwd: null,
        events: [{ kind: "bash", command: COMMIT, output: "[main 1234567] change a\n" }],
      },
    ]);
    expect(facts.noVerify.couldNotCheck).toBe(1);
  });

  it("a machine that cannot be asked", async () => {
    const { root, output } = noVerifyRepo("nv-io");
    const outcome = await runChecks(
      "claude",
      [{ cwd: root, events: [{ kind: "bash", command: COMMIT, output }] }],
      tempFolder("home"),
      { io: UNAVAILABLE_VERIFY_IO },
    );
    expect(checkedOf(outcome["skipped-checks"]).facts.noVerify.couldNotCheck).toBe(1);
    expect(outcome["skipped-checks"].status).toBe("could-not-check");
  });

  it("no sessions: not checked", async () => {
    const { result } = await skipped([]);
    expect(result.status).toBe("not-checked");
  });
});

describe("the card", () => {
  /** Facts with every count zero, then `over` applied. */
  function facts(over: Partial<SkippedChecksFacts> = {}): SkippedChecksFacts {
    const none = { ran: 0, mentioned: 0, unknown: 0 };
    return {
      unsafeFixes: 0,
      noVerify: {
        calls: none,
        commits: 0,
        notIdentified: 0,
        withoutHooks: 0,
        onMain: 0,
        offMain: 0,
        noMainToCheck: 0,
        gone: 0,
        couldNotCheck: 0,
      },
      otherNoVerify: none,
      husky: none,
      hooksPath: { calls: none, off: 0, on: 0, none: 0, couldNotCheck: 0 },
      instructions: {
        read: 0,
        sayToSkip: 0,
        agentWrote: 0,
        agentWroteStill: 0,
        agentWroteRemoved: 0,
        couldNotRead: 0,
      },
      ...over,
    };
  }

  const busy = facts({
    noVerify: {
      ...facts().noVerify,
      calls: { ran: 3, mentioned: 1, unknown: 1 },
      commits: 3,
      onMain: 2,
      offMain: 1,
    },
    husky: { ran: 1, mentioned: 0, unknown: 0 },
    instructions: {
      ...facts().instructions,
      read: 2,
      sayToSkip: 1,
      agentWrote: 1,
      agentWroteStill: 1,
    },
  });

  it("every line comes from a named template, and the chip states its count, zero included", () => {
    const ids = new Set(SKIPPED_CHECKS_TEMPLATES.map((t) => t.id));
    expect(ids.size).toBe(SKIPPED_CHECKS_TEMPLATES.length);
    for (const f of [facts(), busy]) {
      const card = skippedChecksCard(
        { status: "act", matches: 4, facts: f },
        { ranEvidence: "tool-result" },
      ) as ReturnType<typeof skippedChecksCard> & CardExtras;
      for (const line of [...card.found, ...card.now, ...(card.fixSteps ?? [])]) {
        expect(ids.has(line.template)).toBe(true);
      }
      expect(card.chip?.count).toBe(f.noVerify.onMain);
      expect(card.chip?.label.template).toBe("skipped-checks.chip");
    }
    const quiet = skippedChecksCard(
      { status: "clean", matches: 0, facts: facts() },
      { ranEvidence: "tool-result" },
    ) as ReturnType<typeof skippedChecksCard> & CardExtras;
    expect(quiet.chip?.label.text).toBe("0 commits reached main without their checks");
    expect(quiet.found.map((s) => s.text)).toEqual(["No command that ran skipped a hook."]);
    expect(quiet.fixSteps).toBeUndefined();
  });

  it("states the counts it found", () => {
    const card = skippedChecksCard(
      { status: "act", matches: 4, facts: busy },
      { ranEvidence: "tool-result" },
    ) as ReturnType<typeof skippedChecksCard> & CardExtras;
    expect(card.found.map((s) => s.text)).toEqual([
      "3 commits were made with --no-verify in a repo with commit hooks.",
      "1 command ran with Husky's hooks turned off for that one command (HUSKY=0).",
      "1 agent instruction or memory file tells the agent to skip checks.",
      "The agent wrote an instruction to skip checks into 1 file itself.",
      "1 match only mentioned skipping a check, and is not counted.",
      "1 command could not be confirmed as run.",
    ]);
    expect(card.now.map((s) => s.text)).toEqual([
      "2 of those commits are on origin/main or origin/master now.",
      "1 commit is not on origin/main or origin/master.",
      "1 file still holds the instruction the agent wrote.",
    ]);
    expect(card.fixSteps?.map((s) => s.template)).toEqual([
      "skipped-checks.fix.review-commits",
      "skipped-checks.fix.instructions",
    ]);
  });

  it("a Codex count carries the caveat, and its claim never leads", () => {
    const card = skippedChecksCard(
      { status: "act", matches: 4, facts: busy },
      { ranEvidence: "output-record" },
    );
    expect(card.codexCaveat).toBe(true);
    expect(card.headline?.restsOnCodexRan).toBe(true);
    expect(pickHeadline([card], TOOL_RESULT)).toBeUndefined();
    expect(
      skippedChecksCard({ status: "act", matches: 4, facts: busy }, { ranEvidence: "tool-result" })
        .codexCaveat,
    ).toBe(false);
  });

  it("a clean result makes no claim that can lead", () => {
    const card = skippedChecksCard(
      { status: "clean", matches: 0, facts: facts() },
      { ranEvidence: "tool-result" },
    );
    expect(card.headline).toBeUndefined();
    expect(pickHeadline([card], TOOL_RESULT)).toBeUndefined();
  });
});
