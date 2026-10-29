// cspell:words dropdb flushdb flushall mysqladmin PGHOST shutil rmtree libpq pathspecs tmpdata
/**
 * Destructive commands (`core/verify/destructive.ts`): each `rm -rf` target classed against a
 * real temporary repository and home folder, and each database wipe classed by where the
 * database is. Each class boundary, with the ran / mentioned / unknown split.
 *
 * The destructive-looking commands here are test data, held in strings and never run by the
 * check. The files a test removes, it removes from its own temporary folder with `rmSync`.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pickHeadline, UNCONFIRMED_SENTENCE, unconfirmedOf } from "../core/verify/cards.js";
import {
  DESTRUCTIVE_TEMPLATES,
  type DestructiveFacts,
  databaseTargetClasses,
  destructiveCard,
  guarded,
  literalPart,
  namesScratch,
  RM_TARGET_CLASSES,
  recursiveRmTargets,
} from "../core/verify/destructive.js";
import { checkGitBacked, GIT_CARD_BUILDERS } from "../core/verify/git-checks.js";
import { type CardExtras, isUnder, TEMP_ROOTS } from "../core/verify/git-copy.js";
import { shellCommands } from "../core/verify/shell-words.js";
import type { VerifyIO } from "../core/verify/types.js";
import { UNAVAILABLE_VERIFY_IO } from "../core/verify/verify.js";
import {
  checkedOf,
  corpusOf,
  type GitSession,
  makeRepo,
  quoted,
  runChecks,
  tempFolder,
  verifyIO,
} from "./git-check-fixtures.js";

/** The context of a scan whose results are recorded. */
const TOOL_RESULT = { ranEvidence: "tool-result" } as const;

/** The destructive result for sessions. */
async function destructive(
  sessions: readonly GitSession[],
  options: {
    agent?: "claude" | "codex" | "cursor";
    home?: string;
    scratchRoots?: readonly string[];
    unavailable?: boolean;
  } = {},
) {
  const outcome = await runChecks(
    options.agent ?? "claude",
    sessions,
    options.home ?? tempFolder("home"),
    {
      scratchRoots: options.scratchRoots ?? [],
      ...(options.unavailable === true ? { io: UNAVAILABLE_VERIFY_IO } : {}),
    },
  );
  return {
    result: checkedOf(outcome.destructive),
    facts: checkedOf(outcome.destructive).facts,
    fixes: outcome.localFixes.filter((f) => f.category === "destructive").map((f) => f.command),
  };
}

/** One session in `cwd` that ran each command. */
function ran(cwd: string | null, ...commands: string[]): GitSession[] {
  return [
    { cwd, events: commands.map((command) => ({ kind: "bash" as const, command, output: "" })) },
  ];
}

/** Every class at zero, then `over`. */
function classes(over: Partial<Record<(typeof RM_TARGET_CLASSES)[number], number>>) {
  return { ...Object.fromEntries(RM_TARGET_CLASSES.map((c) => [c, 0])), ...over };
}

describe("reading rm", () => {
  const targets = (text: string) =>
    recursiveRmTargets(shellCommands(text)[0]?.words.slice(1) ?? []).map((w) => w.value);

  it.each([
    ["rm -rf a b", ["a", "b"]],
    ["rm -fr a", ["a"]],
    ["rm -r -f a", ["a"]],
    ["rm -R a", ["a"]],
    ["rm --recursive --force a", ["a"]],
    ["rm -rf -- -odd", ["-odd"]],
    ["rm -f a", []],
    ["rm a", []],
  ])("%s → %j", (text, expected) => {
    expect(targets(text)).toEqual(expected);
  });

  it.each([
    [`\${DIR:?}/x`, true],
    [`"\${DIR:?}"/"\${SUB:?}"`, true],
    ["$DIR/x", false],
    [`\${DIR}/x`, false],
    [`\${DIR:-/tmp}/x`, false],
    ["$(pwd)/x", false],
    ["`pwd`/x", false],
  ])("guarded(%s) → %s", (raw, expected) => {
    expect(guarded(raw)).toBe(expected);
  });

  it("names scratch only below the folder the command ran in", () => {
    expect(namesScratch("/w/proj/node_modules/x", "/w/proj")).toBe(true);
    expect(namesScratch("/w/proj/dist", "/w/proj")).toBe(true);
    expect(namesScratch("/w/build/proj/src", "/w/build/proj")).toBe(false);
    expect(namesScratch("/elsewhere/.cache", "/w/proj")).toBe(true);
    expect(namesScratch("/elsewhere/src", undefined)).toBe(false);
  });

  it("a glob is read as the folder before its first wildcard", () => {
    expect(literalPart("src/*")).toBe("src");
    expect(literalPart("src/a*.ts")).toBe("src");
    expect(literalPart("*")).toBe(".");
    expect(literalPart("/*")).toBe("/");
    expect(literalPart("plain/path")).toBe("plain/path");
  });

  it.each([
    [`src/*`, 4],
    [`"src/*"`, -1],
    [`'[ab]'`, -1],
    [`[ab]`, 0],
    [`src/\\*`, -1],
    [`"src"/a?`, 5],
    [`"$HOME"/x`, -1],
  ])("ShellWord.globAt(%s) → %d", (text, expected) => {
    expect(shellCommands(`rm -rf ${text}`)[0]?.words[2]?.globAt).toBe(expected);
  });

  it("a quoted wildcard is kept in the literal part", () => {
    expect(literalPart("[ab]", -1)).toBe("[ab]");
    expect(literalPart("src/a*", -1)).toBe("src/a*");
    expect(literalPart("src/a*", 5)).toBe("src");
  });
});

describe("rm -rf targets, one per class", () => {
  it("a variable with no guard: act, and the headline", async () => {
    const root = makeRepo("rm-var");
    const { facts, result } = await destructive(
      ran(
        root,
        `rm -rf "$BUILD_DIR/out"`,
        `rm -rf \${CACHE}/x $(pwd)/y`,
        `rm -rf "\${TMP_DIR:?}/z"`,
      ),
    );
    expect(facts.rm.classes).toEqual(classes({ "unguarded-variable": 3, "guarded-variable": 1 }));
    expect(result.status).toBe("act");
    const card = destructiveCard(result, { ranEvidence: "tool-result" });
    expect(card.headline).toEqual({
      basis: "unguarded-recursive-deletes",
      count: 3,
      restsOnCodexRan: false,
      sentence: {
        template: "destructive.headline",
        text: "3 rm -rf targets were built from a variable with no guard.",
      },
    });
    expect(pickHeadline([card], TOOL_RESULT)?.category).toBe("destructive");
  });

  it("behind a prefix word's option with a value: the delete is still read", async () => {
    const root = makeRepo("rm-prefix");
    const { facts } = await destructive(
      ran(
        root,
        `env --chdir /x rm -rf "$BUILD_DIR/out"`,
        `sudo -D /x rm -rf "$BUILD_DIR/out"`,
        `sudo -n rm -rf "$BUILD_DIR/out"`,
      ),
    );
    expect(facts.rm.classes).toEqual(classes({ "unguarded-variable": 3 }));
  });

  it("scratch, temp and build output: clean", async () => {
    const root = makeRepo("rm-scratch");
    const scratch = tempFolder("scratch-root");
    const { facts, result } = await destructive(
      ran(root, "rm -rf node_modules dist .next build/cache", `rm -rf ${join(scratch, "work")}`),
      { scratchRoots: [scratch] },
    );
    expect(facts.rm.classes).toEqual(classes({ scratch: 5 }));
    expect(facts.rm.targets).toBe(5);
    expect(result.status).toBe("clean");
    expect(destructiveCard(result, { ranEvidence: "tool-result" }).headline).toBeUndefined();
  });

  it("tracked files wholly gone: act, with the exact restore command kept local", async () => {
    const root = makeRepo("rm-tracked", { files: { "src/a.ts": "a\n", "src/b.ts": "b\n" } });
    rmSync(join(root, "src"), { recursive: true });
    const { facts, result, fixes } = await destructive(ran(root, "rm -rf src"));
    expect(facts.rm.classes).toEqual(classes({ tracked: 1 }));
    expect(facts.rm).toMatchObject({ trackedGone: 1, trackedPartlyBack: 0, trackedBack: 0 });
    expect(result.status).toBe("act");
    expect(fixes).toEqual([
      quoted("git", "-C", root, "--literal-pathspecs", "restore", "--", "src"),
    ]);
    const card = destructiveCard(result, { ranEvidence: "tool-result" });
    expect(card.fixes).toEqual([{ shape: "git --literal-pathspecs restore -- <path>" }]);
    expect(JSON.stringify(card)).not.toContain(root);
    // Missing tracked files are not an unguarded delete: no headline claim.
    expect(card.headline).toBeUndefined();
  });

  it("a build-output name with tracked files gone is tracked, not scratch", async () => {
    const root = makeRepo("rm-tracked-dist", { files: { "dist/index.js": "x\n" } });
    rmSync(join(root, "dist"), { recursive: true });
    const { facts, result, fixes } = await destructive(ran(root, "rm -rf dist", "rm -rf build"));
    expect(facts.rm.classes).toEqual(classes({ tracked: 1, scratch: 1 }));
    expect(facts.rm.trackedGone).toBe(1);
    expect(result.status).toBe("act");
    expect(fixes).toEqual([
      quoted("git", "-C", root, "--literal-pathspecs", "restore", "--", "dist"),
    ]);
  });

  it("a repository in a temp folder: git is asked first, so tracked files gone are tracked", async () => {
    const root = makeRepo("rm-tracked-in-temp", { files: { "src/a.ts": "a\n" } });
    rmSync(join(root, "src"), { recursive: true });
    const outside = tempFolder("scratch-outside");
    // The whole repository sits in a temp folder: a clone made under /tmp, say.
    const { facts, result, fixes } = await destructive(
      ran(root, "rm -rf src", "rm -rf untracked-here", `rm -rf ${join(outside, "work")}`),
      { scratchRoots: [root, outside] },
    );
    expect(facts.rm.classes).toEqual(classes({ tracked: 1, scratch: 2 }));
    expect(facts.rm.trackedGone).toBe(1);
    expect(result.status).toBe("act");
    expect(fixes).toEqual([
      quoted("git", "-C", root, "--literal-pathspecs", "restore", "--", "src"),
    ]);
  });

  it("tracked files partly back: no command restores them as a whole, and the card says why", async () => {
    const root = makeRepo("rm-partly", { files: { "src/a.ts": "a\n", "src/b.ts": "b\n" } });
    rmSync(join(root, "src", "a.ts"));
    const { facts, fixes, result } = await destructive(ran(root, "rm -rf src"));
    expect(facts.rm).toMatchObject({ trackedGone: 0, trackedPartlyBack: 1 });
    expect(fixes).toEqual([]);
    const card = destructiveCard(result, { ranEvidence: "tool-result" });
    expect(card.now.map((s) => s.text)).toContain(
      "1 tracked target is partly back, with tracked files still missing. No exact command is made for it: restoring a whole target would overwrite any new changes in the files that are back.",
    );
    expect(card.fixes).toEqual([]);
  });

  it("a quoted [, * or ? is part of the name, not a wildcard", async () => {
    const root = makeRepo("rm-quoted-glob", {
      files: { "[ab]/x.ts": "x\n", "keep.ts": "k\n", "other.ts": "o\n" },
    });
    // The user deleted an unrelated tracked file on purpose; the quoted target is untouched.
    rmSync(join(root, "other.ts"));
    const { facts, fixes } = await destructive(ran(root, `rm -rf "[ab]"`, `rm -rf 'a*'`));
    // `"[ab]"` names that folder, which is back: not the whole repo with a file missing.
    expect(facts.rm.trackedPartlyBack).toBe(0);
    expect(facts.rm.trackedBack).toBe(1);
    // `'a*'` names a folder that never existed, not every name starting with a.
    expect(facts.rm.classes).toEqual(classes({ tracked: 1, untracked: 1 }));
    expect(fixes).toEqual([]);
  });

  it("an unquoted wildcard is still read as the folder before it", async () => {
    const root = makeRepo("rm-glob", { files: { "src/a.ts": "a\n", "keep.ts": "k\n" } });
    rmSync(join(root, "src"), { recursive: true });
    const { facts, fixes } = await destructive(ran(root, "rm -rf src/*"));
    expect(facts.rm.trackedGone).toBe(1);
    expect(fixes).toEqual([
      quoted("git", "-C", root, "--literal-pathspecs", "restore", "--", "src"),
    ]);
  });

  it("a wholly gone target whose name is outside the safe set makes no command, with a counted note", async () => {
    const root = makeRepo("rm-odd-name", { files: { "[ab]/x.ts": "x\n" } });
    rmSync(join(root, "[ab]"), { recursive: true });
    const { facts, fixes, result } = await destructive(ran(root, `rm -rf "[ab]"`));
    expect(facts.rm.trackedGone).toBe(1);
    expect(facts.unsafeFixes).toBe(1);
    expect(fixes).toEqual([]);
    expect(result.status).toBe("act");
  });

  it("tracked files all back: clean", async () => {
    const root = makeRepo("rm-back", { files: { "src/a.ts": "a\n" } });
    const { facts, result } = await destructive(ran(root, "rm -rf src", "rm -rf src/*"));
    expect(facts.rm.classes).toEqual(classes({ tracked: 2 }));
    expect(facts.rm.trackedBack).toBe(2);
    expect(result.status).toBe("clean");
  });

  it("untracked files in a repo: review", async () => {
    const root = makeRepo("rm-untracked");
    mkdirSync(join(root, "notes"), { recursive: true });
    writeFileSync(join(root, "notes", "n.txt"), "x\n");
    const { facts, result } = await destructive(ran(root, "rm -rf notes", "rm -rf never-existed"));
    expect(facts.rm.classes).toEqual(classes({ untracked: 2 }));
    expect(result.status).toBe("review");
  });

  it("under the home folder, outside a repo: review", async () => {
    const home = tempFolder("home");
    mkdirSync(join(home, "Downloads", "old"), { recursive: true });
    const { facts, result } = await destructive(
      ran(home, "rm -rf Downloads/old", "rm -rf ~/gone/deep"),
      {
        home,
      },
    );
    expect(facts.rm.classes).toEqual(classes({ home: 2 }));
    expect(result.status).toBe("review");
  });

  it("the home folder itself, a folder that holds it, or the root: act", async () => {
    const home = tempFolder("home");
    const { facts, result } = await destructive(
      ran(home, "rm -rf ~", "rm -rf ~/*", `rm -rf ${join(home, "..")}`, "rm -rf /"),
      { home },
    );
    expect(facts.rm.classes).toEqual(classes({ "home-or-above": 4 }));
    expect(result.status).toBe("act");
    const found = destructiveCard(result, TOOL_RESULT).found.map((s) => s.template);
    expect(found).toContain("destructive.rm.home-or-above");
  });

  it("a .. after a wildcard cannot be read from the text: could-not-check", async () => {
    const root = makeRepo("rm-glob-up");
    const { facts, result } = await destructive(ran(root, "rm -rf build/*/../../x"));
    expect(facts.rm.couldNotCheck).toBe(1);
    expect(result.status).toBe("could-not-check");
  });

  it("a target built only from guarded variables keeps the card from clean", async () => {
    const root = makeRepo("rm-guarded-only");
    const { facts, result } = await destructive(ran(root, `rm -rf "\${TMP_DIR:?}/z"`));
    expect(facts.rm.classes).toEqual(classes({ "guarded-variable": 1 }));
    expect(result.status).toBe("could-not-check");
  });

  it("a heredoc commit message with a stray quote stays a message", async () => {
    const root = makeRepo("rm-odd-quote");
    const message = [
      `git commit -m "$(cat <<'EOF'`,
      `Fit 12" screens`,
      "",
      "rm -rf $BUILD_DIR",
      "EOF",
      `)"`,
    ].join("\n");
    const { facts, result } = await destructive(ran(root, message));
    expect(facts.rm.targets).toBe(0);
    expect(facts.rm.calls.ran).toBe(0);
    expect(result.status).not.toBe("act");
  });

  it("a git failure in a folder that exists is could-not-check, not home or other", async () => {
    const home = tempFolder("home");
    const elsewhere = tempFolder("git-fails");
    const real = verifyIO(home);
    const io: VerifyIO = { ...real, git: () => Promise.resolve({ ok: false, reason: "failed" }) };
    const outcome = await runChecks("claude", ran(elsewhere, "rm -rf old"), home, {
      scratchRoots: [],
      io,
    });
    const result = checkedOf(outcome.destructive);
    expect(result.facts.rm.couldNotCheck).toBe(1);
    expect(result.facts.rm.classes).toEqual(classes({}));
    expect(result.status).toBe("could-not-check");
  });

  it("the default temp folders are scratch, /tmp and /private/tmp both, and /tmpdata is not", async () => {
    expect(TEMP_ROOTS).toContain("/tmp");
    expect(TEMP_ROOTS).toContain("/private/tmp");
    expect(isUnder("/tmp/agenttrail-x/build", TEMP_ROOTS)).toBe(true);
    expect(isUnder("/private/tmp/agenttrail-x", TEMP_ROOTS)).toBe(true);
    expect(isUnder("/tmpdata/x", ["/tmp"])).toBe(false);
    expect(isUnder("/tmp", ["/tmp/"])).toBe(true);
    // Through the check, with no scratch folders given: the defaults apply. Both targets sit under
    // temp folders that exist on macOS and on Linux: `/private/tmp` has no Linux counterpart, and
    // a target with no existing parent but `/` cannot be checked there.
    const home = tempFolder("home");
    const outcome = await checkGitBacked({
      corpus: corpusOf(
        "claude",
        ran(home, "rm -rf /tmp/agenttrail-scratch-x /var/tmp/agenttrail-scratch-y"),
      ),
      io: verifyIO(home),
      home,
    });
    expect(checkedOf(outcome.destructive).facts.rm.classes).toEqual(classes({ scratch: 2 }));
  });

  it("outside the home folder and outside any repo: other", async () => {
    const elsewhere = tempFolder("elsewhere");
    const { facts } = await destructive(
      ran(elsewhere, `sudo rm -rf ${join(elsewhere, "opt-tool")}`),
    );
    expect(facts.rm.classes).toEqual(classes({ other: 1 }));
  });

  it("a relative target with no known folder, or no way to ask the machine: could-not-check", async () => {
    const none = await destructive(ran(null, "rm -rf src"));
    expect(none.facts.rm.couldNotCheck).toBe(1);
    expect(none.result.status).toBe("could-not-check");
    const root = makeRepo("rm-io");
    const io = await destructive(ran(root, "rm -rf src"), { unavailable: true });
    expect(io.facts.rm.couldNotCheck).toBe(1);
    expect(io.result.status).toBe("could-not-check");
  });
});

describe("commands this reading cannot open: could not confirm, never clean", () => {
  it.each([
    [`bash -c "rm -rf build"`, "shell-string"],
    [`sh -c 'make clean'`, "shell-string"],
    ["find . -name build -type d -exec rm -rf {} +", "find-exec"],
    ["ls -d build | xargs rm -rf", "xargs"],
    [`echo "$(make clean)"`, "command-substitution"],
    [`python3 -c "import shutil; shutil.rmtree('build')"`, "inline-code"],
  ])("%s ran: could-not-check, with the form named", async (command, form) => {
    const root = makeRepo("hiding");
    const { facts, result } = await destructive(ran(root, command));
    expect(facts.hidingCalls).toBe(1);
    expect(facts.hidingForms).toContain(form);
    expect(result.status).toBe("could-not-check");
    const card = destructiveCard(result, TOOL_RESULT);
    const found = card.found.map((s) => s.template);
    expect(found).not.toContain("destructive.none");
    // The frame's one could-not-confirm line names the form; the card has no line of its own.
    expect(found.filter((t) => t.endsWith("could-not-confirm"))).toEqual([]);
    expect(unconfirmedOf("destructive", result.status, result.facts, true)?.forms).toContain(form);
  });

  it("a delete behind a program no check reads, beside one that was read: could not confirm", async () => {
    const root = makeRepo("backstop-mixed", {
      files: { "keep/a.txt": "a\n", "build/b.txt": "b\n" },
    });
    // The delete read alone: its tracked files are all there, so nothing is lost.
    const alone = await destructive(ran(root, `rm -rf ${"build"}`));
    expect(alone.result.status).toBe("clean");
    const mixed = await destructive(
      ran(root, `rm -rf ${"build"} && my-wrapper rm -rf /Users/sample/${"important"}`),
    );
    expect(mixed.facts.hidingForms).toEqual(["unread-match"]);
    expect(mixed.facts.hidingCalls).toBe(1);
    expect(mixed.result.status).toBe("could-not-check");
    // Behind a launcher the readers know, the second delete is read, not missed.
    const launched = await destructive(
      ran(root, `rm -rf ${"build"} && aws-vault exec prod -- rm -rf /Users/sample/${"important"}`),
    );
    expect(launched.facts.hidingForms).toEqual([]);
    expect(launched.facts.rm.targets).toBe(2);
    expect(launched.result.status).not.toBe("clean");
  });

  it("a command inside a shell string or a substitution is read too", async () => {
    const root = makeRepo("hiding-read", { files: { "src/a.ts": "a\n" } });
    rmSync(join(root, "src"), { recursive: true });
    const { facts, result } = await destructive(ran(root, `bash -c "rm -rf src"`));
    expect(facts.rm.trackedGone).toBe(1);
    // What it found leads; the form still keeps it from clean on its own.
    expect(result.status).toBe("act");
    const sub = await destructive(ran(root, `echo "$(rm -rf "$BUILD_DIR")"`));
    expect(sub.facts.rm.classes["unguarded-variable"]).toBe(1);
  });

  it("a hiding form in a call that may have run counts: no result recorded", async () => {
    const root = makeRepo("hiding-no-result");
    const { facts, result } = await destructive([
      { cwd: root, events: [{ kind: "bash", command: `bash -c "rm -rf build"`, noResult: true }] },
    ]);
    expect(facts.hidingCalls).toBe(1);
    expect(facts.hidingForms).toContain("shell-string");
    expect(result.status).toBe("could-not-check");
  });

  it("a hiding form in a refused or blocked call, or only mentioned, does not count", async () => {
    const root = makeRepo("hiding-not-ran");
    const { facts, result } = await destructive([
      {
        cwd: root,
        events: [
          { kind: "bash", command: `bash -c "ls"`, output: "blocked", error: true },
          { kind: "bash", command: `echo 'find . -exec ls {} +'`, output: "" },
        ],
      },
    ]);
    expect(facts.hidingCalls).toBe(0);
    expect(result.status).toBe("clean");
    const quiet = await destructive(ran(root, "ls"));
    expect(quiet.facts.hidingCalls).toBe(0);
    expect(quiet.result.status).toBe("clean");
  });

  /** A find that deletes through -exec, built here in test code. */
  const findExec = ["find", ".", "-name", "build", "-type", "d", "-exec", "rm", "-rf", "{}", "+"];

  it.each([
    "claude",
    "cursor",
  ] as const)("%s, no result: an unopened form keeps all three categories from clean", async (agent) => {
    const root = makeRepo(`hiding-may-${agent}`);
    const command = findExec.join(" ");
    const outcome = await runChecks(
      agent,
      [{ cwd: root, events: [{ kind: "bash", command, noResult: true }] }],
      tempFolder("home"),
      { scratchRoots: [] },
    );
    for (const name of ["skipped-checks", "lost-work", "destructive"] as const) {
      const category = checkedOf<{ readonly hidingCalls: number }>(outcome[name] as never);
      expect(category.status, name).toBe("could-not-check");
      expect(category.facts.hidingCalls, name).toBe(1);
      const card = GIT_CARD_BUILDERS[name](category as never, TOOL_RESULT);
      const found = card.found.map((s) => s.template);
      expect(found, name).not.toContain(`${name}.none`);
      // The frame says it could not confirm, for a call that ran or may have run.
      const unconfirmed = unconfirmedOf(name, category.status, category.facts, agent === "claude");
      expect(unconfirmed, name).toBeDefined();
      expect(
        UNCONFIRMED_SENTENCE.render(unconfirmed as NonNullable<typeof unconfirmed>),
        name,
      ).toContain("that ran, or may have run,");
    }
  });
});

describe("the folder a target is read from, across calls", () => {
  /** A repo whose tracked `src/` is gone, and a scratch folder a session starts in. */
  function setUp(label: string) {
    const root = makeRepo(label, { files: { "src/a.ts": "a\n" } });
    rmSync(join(root, "src"), { recursive: true });
    const scratch = tempFolder(`${label}-scratch`);
    return { root, scratch };
  }

  it("Claude Code: a cd in an earlier call that ran moves the folder for the next", async () => {
    const { root, scratch } = setUp("cd-across");
    const { facts } = await destructive(
      [
        {
          cwd: scratch,
          events: [
            { kind: "bash", command: `cd ${root}`, output: "" },
            { kind: "bash", command: "rm -rf src", output: "" },
          ],
        },
      ],
      { scratchRoots: [scratch] },
    );
    expect(facts.rm.classes).toEqual(classes({ tracked: 1 }));
    expect(facts.rm.trackedGone).toBe(1);
  });

  it("a cd in a call that may not have run leaves the folder unknown, never scratch", async () => {
    const { root, scratch } = setUp("cd-unknown");
    for (const first of [
      { kind: "bash" as const, command: `cd ${root}`, noResult: true },
      { kind: "bash" as const, command: `cd ${root} && make`, output: "Exit code 2", error: true },
      { kind: "bash" as const, command: "cd $SOMEWHERE", output: "" },
    ]) {
      const { facts, result } = await destructive(
        [{ cwd: scratch, events: [first, { kind: "bash", command: "rm -rf src", output: "" }] }],
        { scratchRoots: [scratch] },
      );
      expect(facts.rm.classes.scratch).toBe(0);
      expect(facts.rm.couldNotCheck).toBe(1);
      expect(result.status).toBe("could-not-check");
    }
  });

  it("a subshell's cd in an earlier call does not move the folder", async () => {
    const { root, scratch } = setUp("cd-subshell");
    const { facts } = await destructive(
      [
        {
          cwd: root,
          events: [
            { kind: "bash", command: `(cd ${scratch} && ls)`, output: "" },
            { kind: "bash", command: "rm -rf src", output: "" },
          ],
        },
      ],
      { scratchRoots: [scratch] },
    );
    expect(facts.rm.trackedGone).toBe(1);
  });

  it("Claude Code's reset notice puts the folder back", async () => {
    const { root, scratch } = setUp("cd-reset");
    const { facts } = await destructive(
      [
        {
          cwd: root,
          events: [
            {
              kind: "bash",
              command: `cd ${scratch}`,
              output: `Shell cwd was reset to ${root}`,
            },
            { kind: "bash", command: "rm -rf src", output: "" },
          ],
        },
      ],
      { scratchRoots: [scratch] },
    );
    expect(facts.rm.trackedGone).toBe(1);
  });

  it("Codex: each call runs in the workdir it names, absolute or relative to the session", async () => {
    const { root, scratch } = setUp("codex-workdir");
    const named = await destructive(
      [
        {
          cwd: scratch,
          events: [{ kind: "bash", command: "rm -rf src", workdir: root, output: "" }],
        },
      ],
      { scratchRoots: [scratch], agent: "codex" },
    );
    expect(named.facts.rm.trackedGone).toBe(1);
    // A cd in one Codex call does not carry to the next: each starts in its own folder.
    const carried = await destructive(
      [
        {
          cwd: scratch,
          events: [
            { kind: "bash", command: `cd ${root}`, output: "" },
            { kind: "bash", command: "rm -rf src", output: "" },
          ],
        },
      ],
      { scratchRoots: [scratch], agent: "codex" },
    );
    expect(carried.facts.rm.classes.scratch).toBe(1);
  });
});

describe("ran, mentioned, unknown", () => {
  it("mentions are counted apart", async () => {
    const root = makeRepo("rm-mention");
    const { facts, result } = await destructive(
      ran(
        root,
        `echo "rm -rf build"`,
        `grep -rn "rm -rf $HOME" scripts`,
        "cat > notes.md <<'EOF'\nrm -rf ~/projects\nEOF",
        `grep -rn "psql -h db.example.com -c 'DROP TABLE x'" .`,
      ),
    );
    expect(facts.rm.calls).toEqual({ ran: 0, mentioned: 3, unknown: 0 });
    expect(facts.databases.calls).toEqual({ ran: 0, mentioned: 1, unknown: 0 });
    expect(facts.rm.targets).toBe(0);
    expect(result.status).toBe("clean");
  });

  it("no recorded result: unknown, never clean", async () => {
    const root = makeRepo("rm-unknown");
    const { facts, result } = await destructive([
      { cwd: root, events: [{ kind: "bash", command: "rm -rf dist", noResult: true }] },
    ]);
    expect(facts.rm.calls).toEqual({ ran: 0, mentioned: 0, unknown: 1 });
    expect(facts.rm.targets).toBe(0);
    expect(result.status).toBe("could-not-check");
  });

  it("Cursor: unknown. Codex: ran, with the caveat on the card and no headline", async () => {
    const root = makeRepo("rm-apps");
    const cursor = await destructive(
      [{ cwd: root, events: [{ kind: "bash", command: `rm -rf "$X"` }] }],
      {
        agent: "cursor",
      },
    );
    expect(cursor.facts.rm.calls).toEqual({ ran: 0, mentioned: 0, unknown: 1 });
    expect(cursor.result.status).toBe("could-not-check");

    const codex = await destructive(ran(root, `rm -rf "$X"`), { agent: "codex" });
    expect(codex.facts.rm.classes["unguarded-variable"]).toBe(1);
    const card = destructiveCard(codex.result, { ranEvidence: "output-record" });
    expect(card.codexCaveat).toBe(true);
    expect(card.headline?.restsOnCodexRan).toBe(true);
    expect(pickHeadline([card], TOOL_RESULT)).toBeUndefined();
  });
});

describe("databases", () => {
  it.each([
    [`psql -h db.prod.example.com -c "DROP TABLE users"`, "other"],
    [`psql postgresql://app@10.0.0.5:5432/app -c "DROP TABLE x"`, "other"],
    [`psql -h localhost -c "DROP DATABASE app_test"`, "scratch"],
    [`psql -h localhost -d app -c "TRUNCATE orders"`, "local"],
    [`psql -h /var/run/postgresql -c "DROP TABLE t"`, "local"],
    [`PGHOST=db.example.com psql -c "DROP TABLE t"`, "other"],
    [`psql "$DATABASE_URL" -c "DROP SCHEMA public CASCADE"`, "unresolved"],
    // No host given: the client's environment or config files pick the server.
    [`psql -c "DROP DATABASE app_test"`, "unresolved"],
    ["psql app <<'SQL'\nDROP TABLE t;\nSQL", "unresolved"],
    ["dropdb app_dev", "unresolved"],
    // A libpq connection string names its host, or a service looked up elsewhere.
    [`psql "host=db.prod.example.com dbname=app user=admin" -c "DROP TABLE users"`, "other"],
    [`psql -d "host=localhost dbname=app" -c "DROP TABLE users"`, "local"],
    [`psql "service=prod" -c "DROP TABLE users"`, "unresolved"],
    // A remote server is other, whatever its database is called.
    [`psql -h db.prod.example.com -c "DROP DATABASE app_test"`, "other"],
    ["dropdb -h 127.0.0.1 app_dev", "local"],
    [`mysql -h db.internal -e "DROP DATABASE shop"`, "other"],
    [`mysql -h localhost -e "DROP DATABASE shop_tmp"`, "scratch"],
    [`mysql -e "DROP DATABASE shop_tmp"`, "unresolved"],
    ["mysqladmin -h localhost drop shop", "local"],
    ["redis-cli FLUSHALL", "local"],
    ["redis-cli -h cache.example.com flushdb", "other"],
    [`mongosh mongodb://db.example.com/app --eval "db.dropDatabase()"`, "other"],
    [`mongosh db.prod.example.com/app --eval "db.dropDatabase()"`, "other"],
    [`mongosh localhost:27017/app --eval "db.dropDatabase()"`, "local"],
    [`mongosh --eval "db.dropDatabase()"`, "unresolved"],
    ["npx prisma migrate reset --force", "unresolved"],
    ["bin/rails db:drop", "unresolved"],
    [`docker exec -it pg psql -U postgres -c "DROP DATABASE app"`, "local"],
    [`kubectl exec db-0 -- psql -c "DROP TABLE x"`, "other"],
    [`kubectl -n prod --context live exec pg-0 -- psql -c "DROP TABLE users"`, "other"],
    [`ssh prod-db "psql -c 'DROP TABLE x'"`, "other"],
  ])("%s → %s", async (command, expected) => {
    const root = makeRepo("db");
    const { facts } = await destructive(ran(root, command));
    expect(facts.databases.calls.ran).toBe(1);
    expect(facts.databases.classes[expected as "local"]).toBe(1);
  });

  it("a SQLite file in a temp folder is scratch", async () => {
    const root = makeRepo("db-sqlite");
    const scratch = tempFolder("sqlite");
    const { facts } = await destructive(
      ran(
        root,
        `sqlite3 ${join(scratch, "app.db")} "DROP TABLE t"`,
        `sqlite3 app.db "DROP TABLE t"`,
      ),
      {
        scratchRoots: [scratch],
      },
    );
    expect(facts.databases.classes).toEqual({ local: 1, scratch: 1, other: 0, unresolved: 0 });
  });

  it.each([
    `psql -c "SELECT 1"`,
    "redis-cli GET k",
    `mysql -e "SHOW TABLES"`,
    "prisma migrate dev",
  ])("%s is not destructive", async (command) => {
    const root = makeRepo("db-safe");
    const { facts } = await destructive(ran(root, command));
    expect(facts.databases.calls).toEqual({ ran: 0, mentioned: 0, unknown: 0 });
  });

  it("databaseTargetClasses gives the counts of databases wiped by commands that ran", async () => {
    const root = makeRepo("db-export");
    const { result } = await destructive([
      {
        cwd: root,
        events: [
          { kind: "bash", command: `psql -h db.example.com -c "DROP TABLE t"`, output: "" },
          { kind: "bash", command: `psql -h localhost -c "DROP DATABASE app_test"`, output: "" },
          { kind: "bash", command: `psql -c "DROP TABLE t"`, output: "" },
          { kind: "bash", command: `echo "psql -h db2.example.com -c 'DROP TABLE t'"`, output: "" },
          { kind: "bash", command: `psql -h db3.example.com -c "DROP TABLE t"`, noResult: true },
        ],
      },
    ]);
    // `unresolved` is a host this check could not tell: it is not counted as `other`.
    expect(databaseTargetClasses(result)).toEqual({
      local: 0,
      scratch: 1,
      other: 1,
      unresolved: 1,
    });
    expect(databaseTargetClasses({ status: "not-checked" })).toBeUndefined();
  });

  it("a database on another machine, or an unresolved one, is review; local and scratch alone are clean", async () => {
    const root = makeRepo("db-status");
    expect(
      (await destructive(ran(root, `psql -h db.example.com -c "DROP TABLE t"`))).result.status,
    ).toBe("review");
    expect((await destructive(ran(root, `psql -c "DROP TABLE t"`))).result.status).toBe("review");
    expect(
      (await destructive(ran(root, `psql -h localhost -c "DROP TABLE t"`))).result.status,
    ).toBe("clean");
  });
});

describe("the card", () => {
  const none = { ran: 0, mentioned: 0, unknown: 0 };
  /** Facts with every count zero, then `over` applied. */
  function facts(
    over: Partial<DestructiveFacts["rm"]> = {},
    db: Partial<DestructiveFacts["databases"]["classes"]> = {},
  ): DestructiveFacts {
    return {
      unsafeFixes: 0,
      hidingCalls: 0,
      hidingForms: [],
      rm: {
        calls: none,
        targets: 0,
        classes: classes({}) as DestructiveFacts["rm"]["classes"],
        trackedBack: 0,
        trackedGone: 0,
        trackedPartlyBack: 0,
        couldNotCheck: 0,
        ...over,
      },
      databases: {
        calls: none,
        classes: { local: 0, scratch: 0, other: 0, unresolved: 0, ...db },
      },
    };
  }

  it("states each class it found, from templates", () => {
    const f = facts(
      {
        calls: { ran: 3, mentioned: 1, unknown: 0 },
        targets: 6,
        classes: classes({
          "unguarded-variable": 1,
          scratch: 3,
          tracked: 1,
          home: 1,
        }) as DestructiveFacts["rm"]["classes"],
        trackedGone: 1,
      },
      { other: 1, local: 2 },
    );
    const card = destructiveCard(
      { status: "act", matches: 5, facts: f },
      { ranEvidence: "tool-result" },
    ) as ReturnType<typeof destructiveCard> & CardExtras;
    const ids = new Set(DESTRUCTIVE_TEMPLATES.map((t) => t.id));
    for (const line of [...card.found, ...card.now, ...(card.fixSteps ?? [])]) {
      expect(ids.has(line.template)).toBe(true);
    }
    expect(card.found.map((s) => s.text)).toEqual([
      "3 rm -rf commands ran, with 6 targets.",
      `1 target was built from a variable with no \${VAR:?} guard, so an empty value deletes from the wrong folder.`,
      "3 targets were scratch, temp or build output.",
      "1 target held files git tracks.",
      "1 target was under the home folder, outside any repo.",
      "3 databases were dropped or wiped: 1 on another machine, 2 local.",
      "1 match only mentioned a delete, and is not counted.",
    ]);
    expect(card.now.map((s) => s.text)).toEqual(["1 tracked target is still gone."]);
    expect(card.chip).toEqual({
      count: 1,
      label: {
        template: "destructive.chip",
        // The page writes the count in front of the label.
        text: "rm -rf target built from an unguarded variable",
      },
    });
    expect(card.fixSteps?.map((s) => s.template)).toEqual([
      "destructive.fix.restore",
      "destructive.fix.guard",
      "destructive.fix.outside",
      "destructive.fix.databases",
    ]);
  });

  it("a clean result states zero on its chip and makes no claim that can lead", () => {
    const card = destructiveCard(
      { status: "clean", matches: 0, facts: facts() },
      { ranEvidence: "tool-result" },
    ) as ReturnType<typeof destructiveCard> & CardExtras;
    expect(card.chip?.count).toBe(0);
    expect(card.chip?.label.text).toBe("rm -rf targets built from an unguarded variable");
    expect(card.found.map((s) => s.text)).toEqual([
      "No rm -rf and no database wipe that this check could read ran.",
    ]);
    expect(card.headline).toBeUndefined();
    expect(pickHeadline([card], TOOL_RESULT)).toBeUndefined();
    expect(card.fixes).toEqual([]);
  });
});
