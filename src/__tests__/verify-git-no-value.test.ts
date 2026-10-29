// cspell:words CANARYbranch CANARYmessage CANARYtracked CANARYhost CANARYtable CANARYproject CANARYmemory CANARYinstruction CANARYdiscard CANARYstash CANARYrepo pathspecs
/**
 * No name, path, message or commit id the git-backed checks read leaves `scan --verify` — not
 * in `--json`, the report in any decoded form (either variant), `--review` or the terminal —
 * while the exact local fix commands do carry them, beside the verification and never in it.
 *
 * A canary marker is planted in every value the checks read: a deleted branch's name, a
 * `--no-verify` commit's message, a deleted folder, a database host and table, a memory file's
 * path and text, and a discarded file. The catalog is empty, so the report lists no command
 * and a marker can only come from the checks. Corpus health is asserted first: each check
 * fired on its canary.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runScan } from "../commands/scan.js";
import { compileAllowlist } from "../core/evaluate.js";
import { FIXES_FILENAME } from "../core/report.js";
import { compileCatalog } from "../core/rules.js";
import type { ScanCorpus } from "../core/scan-report.js";
import { parseSession } from "../core/transcript/parse.js";
import { isLocalFix } from "../core/verify/cards.js";
import { GIT_FACT_ENUMS, GIT_FACT_KEYS } from "../core/verify/git-facts.js";
import { HIDING_FORMS, VERIFY_STATUSES } from "../core/verify/types.js";
import { verifyScan } from "../core/verify/verify.js";
import { createRealScanIO, type ScanIO } from "../scan-io.js";
import { createRealVerifyIO } from "../verify-io.js";
import { corpusOf, git, makeRepo, rev, setRemoteBranch } from "./git-check-fixtures.js";
import { decodedSurfaces, stringLeaves, whatHappenedNote } from "./html-text.js";

const MARKER = "canary";

/**
 * A repo with a canary in every value the checks read, and the commands that touched it. The
 * repo's own folder name carries the marker too, so a repo path in any output is found.
 */
function canaryCorpus(): { root: string; home: string; lines: string[]; ids: string[] } {
  const root = makeRepo("planted-CANARYrepo", {
    files: { "CANARYtracked/a.txt": "a\n", "CANARYdiscard.ts": "x\n" },
    hooks: ["pre-commit"],
  });
  // A force-deleted branch, still recoverable.
  git(root, "switch", "-q", "-c", "feature/CANARYbranch");
  writeFileSync(join(root, "b.txt"), "b\n");
  git(root, "add", "b.txt");
  git(root, "commit", "-q", "-m", "branch work");
  const branchCommit = rev(root, "HEAD");
  git(root, "switch", "-q", "main");
  const deleted = git(root, "branch", "-D", "feature/CANARYbranch");

  // A dropped stash, still recoverable.
  writeFileSync(join(root, "CANARYdiscard.ts"), "changed\n");
  git(root, "stash", "push", "-q", "-m", "CANARYstash");
  const stashCommit = rev(root, "refs/stash");
  const dropped = git(root, "stash", "drop");

  // The deleted folder is still gone, so an exact command to bring it back is made. Deleted
  // after the stash, which would otherwise put it back.
  rmSync(join(root, "CANARYtracked"), { recursive: true });

  // A commit that skipped its hooks and reached origin/main.
  writeFileSync(join(root, "c.txt"), "c\n");
  git(root, "add", "c.txt");
  const committed = git(root, "commit", "--no-verify", "-m", "CANARYmessage");
  const skipCommit = rev(root, "HEAD");
  setRemoteBranch(root, "main", skipCommit);

  // A memory file the agent wrote, still telling it to skip checks. The home folder is the
  // test's own, never the user's: the suite setup points HOME into the temp folder.
  const home = homedir();
  const tmp = realpathSync(tmpdir());
  if (!realpathSync(home).startsWith(`${tmp}/`)) {
    throw new Error("the home folder is not under the temp folder: refusing to write into it");
  }
  const memory = join(home, ".claude", "projects", "CANARYproject", "memory", "CANARYmemory.md");
  mkdirSync(join(memory, ".."), { recursive: true });
  const instruction = "Use --no-verify on CANARYinstruction commits.\n";
  writeFileSync(memory, instruction);

  const calls: { command: string; output: string }[] = [
    { command: "git branch -D feature/CANARYbranch", output: deleted },
    { command: "git stash drop", output: dropped },
    { command: `git commit --no-verify -m "CANARYmessage"`, output: committed },
    { command: "rm -rf CANARYtracked", output: "" },
    { command: `psql -h CANARYhost.example.com -c "DROP TABLE CANARYtable"`, output: "" },
    { command: "git checkout -- CANARYdiscard.ts", output: "" },
  ];
  const base = { sessionId: "planted", cwd: root, timestamp: "2026-10-01T00:00:00.000Z" };
  const lines: string[] = [];
  const use = (id: string, name: string, input: Record<string, unknown>, output: string) => {
    lines.push(
      JSON.stringify({
        ...base,
        type: "assistant",
        uuid: `a-${id}`,
        message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
      }),
      JSON.stringify({
        ...base,
        type: "user",
        uuid: `r-${id}`,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: id, content: output }],
        },
      }),
    );
  };
  lines.push(
    JSON.stringify({
      ...base,
      type: "user",
      uuid: "u0",
      message: { role: "user", content: "tidy up" },
    }),
  );
  use("w0", "Write", { file_path: memory, content: instruction }, "ok");
  for (const [i, call] of calls.entries()) {
    use(`t${i}`, "Bash", { command: call.command }, call.output);
  }
  return { root, home, lines, ids: [branchCommit, stashCommit, skipCommit] };
}

/**
 * Expect no commit id the checks looked up in `text`, in full or as a short id of `short`
 * digits. A large page holds encoded data, where 7 hex digits can turn up by chance, so the
 * report is searched for 12.
 */
function noIds(text: string, ids: readonly string[], where: string, short = 7): void {
  for (const id of ids) {
    expect(text, `${where}: full id`).not.toContain(id);
    expect(text, `${where}: short id`).not.toContain(id.slice(0, short));
  }
}

/** Write the canary corpus as a Claude Code transcript folder. */
function writeTranscripts(lines: readonly string[]): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "agenttrail-git-planted-projects-"));
  const folder = join(dir, "-planted-project");
  mkdirSync(folder, { recursive: true });
  const file = join(folder, "planted.jsonl");
  writeFileSync(file, `${lines.join("\n")}\n`);
  return { dir, file };
}

/**
 * One in-process run of `scan`, with no guardrail in the catalog. With `failFixes`, writing the
 * local fixes file fails, as on a folder the user cannot write to.
 */
async function scan(argv: readonly string[], answer?: string, failFixes = false) {
  const real = createRealScanIO();
  const out: string[] = [];
  const written = new Map<string, string>();
  const work = mkdtempSync(join(tmpdir(), "agenttrail-git-planted-work-"));
  const io: ScanIO = {
    ...real,
    cwd: () => work,
    writeStdout: (text) => {
      out.push(text);
    },
    readLine: () => Promise.resolve(answer),
    writeFile: (path, text) => {
      if (failFixes && path.endsWith(FIXES_FILENAME)) return false;
      written.set(path, text);
      return true;
    },
    openInBrowser: () => true,
    env: { CI: "1" },
    isTTY: () => false,
  };
  const code = await runScan(argv, io, {
    catalog: [],
    now: new Date("2026-10-01T00:00:00.000Z"),
    createVerifyIO: () => createRealVerifyIO(),
  });
  return { code, stdout: out.join(""), written, work };
}

/** Expect no canary marker in `text`. */
function clean(text: string, where: string): void {
  expect(text.toLowerCase(), where).not.toContain(MARKER);
}

describe("no value the git-backed checks read leaves scan --verify", () => {
  const { root, lines, ids } = canaryCorpus();
  const { dir, file } = writeTranscripts(lines);

  it("health: every check fired on its canary, and the exact fixes carry them locally", async () => {
    const corpus: ScanCorpus = {
      agent: "claude",
      sessions: [await parseSession(file, "planted", createRealScanIO())],
      quarantined: 0,
      notRead: 0,
      projects: 1,
      files: [file],
    };
    // No scratch folders: the repo is in the temp folder, and the deleted tracked folder must
    // be classed tracked so its exact command is made.
    const outcome = await verifyScan({
      corpus,
      catalog: compileCatalog([]),
      allowlist: compileAllowlist([]),
      readLines: (path) => createRealScanIO().readLines(path),
      io: createRealVerifyIO(),
      scratchRoots: [],
    });
    const c = outcome.verification.categories;
    expect(
      !("facts" in c["lost-work"]) ? undefined : c["lost-work"].facts.branches.recoverable,
    ).toBe(1);
    expect(
      !("facts" in c["lost-work"]) ? undefined : c["lost-work"].facts.stashes.recoverable,
    ).toBe(1);
    expect(!("facts" in c["lost-work"]) ? undefined : c["lost-work"].facts.discards.paths).toBe(1);
    expect(
      !("facts" in c["skipped-checks"]) ? undefined : c["skipped-checks"].facts.noVerify.onMain,
    ).toBe(1);
    expect(
      !("facts" in c["skipped-checks"])
        ? undefined
        : c["skipped-checks"].facts.instructions.sayToSkip,
    ).toBe(1);
    expect(!("facts" in c.destructive) ? undefined : c.destructive.facts.rm.targets).toBe(1);
    expect(!("facts" in c.destructive) ? undefined : c.destructive.facts.rm.trackedGone).toBe(1);
    expect(
      !("facts" in c.destructive) ? undefined : c.destructive.facts.databases.classes.other,
    ).toBe(1);

    // The verification holds no marker, no repo path and no commit id; the local fixes,
    // beside it, do.
    const verification = JSON.stringify(outcome.verification);
    clean(verification, "verification");
    expect(verification).not.toContain(root);
    noIds(verification, ids, "verification");
    noIds(JSON.stringify(outcome.unsafeFixes ?? []), ids, "unsafe fixes");
    const commands = outcome.localFixes.map((f) => (isLocalFix(f) ? f.command : "")).join("\n");
    expect(commands).toContain("recovered/feature/CANARYbranch");
    expect(commands).toContain("CANARYmemory.md");
    expect(commands).toContain("--literal-pathspecs");
    expect(commands).toContain("CANARYtracked");
    expect(commands).toContain(root);
    for (const id of ids) expect(commands).toContain(id);
    expect(() => JSON.stringify(outcome)).toThrow();
  });

  it("every string in the git-backed categories is one of their fixed enums or keys", async () => {
    const fence = new Set<string>([
      ...VERIFY_STATUSES,
      "status",
      "matches",
      "facts",
      // A key the secrets facts use too.
      "classes",
      ...GIT_FACT_ENUMS.flat(),
      ...GIT_FACT_KEYS,
      ...HIDING_FORMS,
      "hidingForms",
    ]);
    const { stdout } = await scan(["--agent", "claude", "--dir", dir, "--verify", "--json"]);
    const categories = JSON.parse(stdout).result.verification.categories;
    const strings = ["skipped-checks", "lost-work", "destructive"].flatMap((name) =>
      stringLeaves(categories[name]),
    );
    expect(strings.length).toBeGreaterThan(40);
    expect(strings.filter((s) => !fence.has(s))).toEqual([]);
    // Negative control: a value is outside the fence.
    expect(fence.has(ids[0] as string)).toBe(false);
    expect(fence.has(root)).toBe(false);
  });

  it("--json carries no marker, in any key or value", async () => {
    const { stdout } = await scan(["--agent", "claude", "--dir", dir, "--verify", "--json"]);
    clean(stdout, "json");
    noIds(stdout, ids, "json");
    for (const text of stringLeaves(JSON.parse(stdout))) clean(text, "json leaf");
    // The checks are in it, so the search above searched them, and their facts pass the
    // boundary because their keys and enums are registered.
    const categories = JSON.parse(stdout).result.verification.categories;
    expect(categories["lost-work"].status).toBe("act");
    expect(categories["lost-work"].facts.branches.recoverable).toBe(1);
    expect(categories["skipped-checks"].facts.noVerify.onMain).toBe(1);
    expect(categories.destructive.facts.databases.classes.other).toBe(1);
    expect(Object.keys(categories.destructive.facts.rm.classes).length).toBeGreaterThan(5);
  });

  it("the report carries no marker in any decoded form, either variant", async () => {
    for (const variant of [[], ["--artifact"]]) {
      const run = await scan([
        "--agent",
        "claude",
        "--dir",
        dir,
        "--verify",
        "--out",
        "r.html",
        ...variant,
      ]);
      expect(run.code).toBe(0);
      // The local fixes file holds the exact commands, real names and all, by design: it is the
      // one place they go, and it is not part of the report. Everything else written is checked.
      const html = [...run.written.entries()]
        .filter(([path]) => !path.endsWith(FIXES_FILENAME))
        .map(([, text]) => text)
        .join("\n");
      expect(html.length).toBeGreaterThan(1000);
      for (const [surface, text] of Object.entries({ raw: html, ...decodedSurfaces(html) })) {
        clean(text, surface);
        noIds(text, ids, surface, 12);
      }
      clean(run.stdout, "stdout");
      noIds(run.stdout, ids, "stdout");
    }
  });

  it("--review and the terminal summary carry no marker", async () => {
    const run = await scan(["--agent", "claude", "--dir", dir, "--verify", "--review"], "y");
    expect(run.stdout).toContain("Checked on this machine");
    clean(run.stdout, "review");
    noIds(run.stdout, ids, "review");
  });

  it("Codex and Cursor sessions running the same commands carry none either", async () => {
    const commands = [
      "git branch -D feature/CANARYbranch",
      `git commit --no-verify -m "CANARYmessage"`,
      "rm -rf CANARYtracked",
      `rm -rf "$CANARY_DIR/x"`,
      `psql -h CANARYhost.example.com -c "DROP TABLE CANARYtable"`,
      "git checkout -- CANARYdiscard.ts",
    ];
    for (const agent of ["codex", "cursor"] as const) {
      const corpus = corpusOf(agent, [
        {
          cwd: root,
          events: commands.map((command) => ({ kind: "bash" as const, command, output: "" })),
        },
      ]);
      const outcome = await verifyScan({
        corpus,
        catalog: compileCatalog([]),
        allowlist: compileAllowlist([]),
        readLines: (path) => createRealScanIO().readLines(path),
        io: createRealVerifyIO(),
      });
      const destructive = outcome.verification.categories.destructive;
      // Codex ran them; Cursor cannot say. Either way the checks saw them.
      expect(destructive.status === "not-checked" ? 0 : destructive.matches).toBe(3);
      clean(JSON.stringify(outcome.verification), agent);
    }
  });
});

describe("fixes the checks could not make safe reach the fixes file, and --review counts them", () => {
  /** A repo named `label`, with a force-deleted branch still recoverable, and the session. */
  function deletedBranchCorpus(label: string): { root: string; lines: string[] } {
    const root = makeRepo(label);
    git(root, "switch", "-q", "-c", "feature/kept-work");
    writeFileSync(join(root, "b.txt"), "b\n");
    git(root, "add", "b.txt");
    git(root, "commit", "-q", "-m", "branch work");
    git(root, "switch", "-q", "main");
    const deleted = git(root, "branch", "-D", "feature/kept-work");
    const base = { sessionId: "unsafe", cwd: root, timestamp: "2026-10-01T00:00:00.000Z" };
    const lines = [
      JSON.stringify({
        ...base,
        type: "user",
        uuid: "u0",
        message: { role: "user", content: "tidy up" },
      }),
      JSON.stringify({
        ...base,
        type: "assistant",
        uuid: "a0",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "t0",
              name: "Bash",
              input: { command: "git branch -D feature/kept-work" },
            },
          ],
        },
      }),
      JSON.stringify({
        ...base,
        type: "user",
        uuid: "r0",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t0", content: deleted }],
        },
      }),
    ];
    return { root, lines };
  }

  /** The written report and fixes file of a run, and the lost-work card's markup. */
  function outputs(written: ReadonlyMap<string, string>) {
    const fixesPath = [...written.keys()].find((path) => path.endsWith(FIXES_FILENAME));
    const report =
      [...written.entries()].find(([path]) => !path.endsWith(FIXES_FILENAME))?.[1] ?? "";
    const at = report.indexOf('id="check-lost-work"');
    // The card, and the note under the cards that names the fixes file for all of them.
    const card =
      report.slice(report.lastIndexOf("<article", at), report.indexOf("</article>", at)) +
      whatHappenedNote(report);
    return { fixes: fixesPath === undefined ? undefined : written.get(fixesPath), card };
  }

  it("a repo path with a space and shell characters: the file lists the note, --review counts it", async () => {
    // Every recovery command names the repo, so none can be made safe.
    const { root, lines } = deletedBranchCorpus(["unsafe repo;", "$", "(id)'x"].join(""));
    const { dir } = writeTranscripts(lines);
    const run = await scan(["--agent", "claude", "--dir", dir, "--review"], "y");
    expect(run.code).toBe(0);
    const { fixes, card } = outputs(run.written);
    expect(fixes, "a fixes file is written for the unsafe fix alone").toBeDefined();
    expect(fixes).toContain("could not make a safe command");
    // No command text for it, and nothing of the repo path or the branch.
    expect(fixes).not.toContain(root);
    expect(fixes).not.toContain("kept-work");
    // The review counts it before asking.
    expect(run.stdout).toContain("1 fix it could not make a safe command for");
    // The lost-work card says so. It names the file as listing the fix, which the written file
    // does, and not as holding a command for it, which the file does not.
    expect(card).toContain("Could not make a safe command for 1 fix");
    expect(card).toContain('data-template="card.fixes-file-unsafe"');
    expect(card).not.toContain('data-template="card.fixes-file"');
  });

  it("a fixes file that could not be written: no card says it lists anything", async () => {
    const { lines } = deletedBranchCorpus(["unsafe repo;", "$", "(id)'x"].join(""));
    const { dir } = writeTranscripts(lines);
    const run = await scan(["--agent", "claude", "--dir", dir], undefined, true);
    expect(run.code).toBe(0);
    const { fixes, card } = outputs(run.written);
    expect(fixes, "no fixes file was written").toBeUndefined();
    expect(run.stdout).toContain("Could not write the fix commands to");
    // The card still says the fix could not be made safe, and says nothing of the file.
    expect(card).toContain("Could not make a safe command for 1 fix");
    expect(card).not.toContain("card.fixes-file");
    expect(card).not.toContain(FIXES_FILENAME);
    expect(card).not.toMatch(/fixes file/i);
  });

  it("a fixes file that could not be written, for an exact command: the card does not name it", async () => {
    const { lines } = deletedBranchCorpus("safe-repo-unwritten");
    const { dir } = writeTranscripts(lines);
    const run = await scan(["--agent", "claude", "--dir", dir], undefined, true);
    const { fixes, card } = outputs(run.written);
    expect(fixes).toBeUndefined();
    expect(card).not.toContain("card.fixes-file");
    expect(card).not.toContain(FIXES_FILENAME);
  });

  it("negative control: a safe repo path gives an exact command, and the card names the file", async () => {
    const { lines } = deletedBranchCorpus("safe-repo");
    const { dir } = writeTranscripts(lines);
    const run = await scan(["--agent", "claude", "--dir", dir]);
    const { fixes, card } = outputs(run.written);
    expect(fixes).toContain("'branch' 'recovered/feature/kept-work'");
    expect(fixes).not.toContain("could not make a safe command");
    expect(card).toContain('data-template="card.fixes-file"');
  });
});

describe("a card whose every fix could not be made safe says nothing of a command in the file", () => {
  /**
   * A repo under a path a command cannot carry, with a force-deleted branch, a tracked folder
   * deleted and still gone, and an instruction file at its top that tells the agent to skip
   * checks. Every fix of lost work, destructive commands and skipped checks names that path.
   */
  function hostileCorpus(): string[] {
    const root = makeRepo(["hostile repo;", "$", "(id)'x"].join(""), {
      files: {
        "kept/a.txt": "a\n",
        "CLAUDE.md": "Use --no-verify on every commit.\n",
      },
    });
    git(root, "switch", "-q", "-c", "feature/kept-work");
    writeFileSync(join(root, "b.txt"), "b\n");
    git(root, "add", "b.txt");
    git(root, "commit", "-q", "-m", "branch work");
    git(root, "switch", "-q", "main");
    const deleted = git(root, "branch", "-D", "feature/kept-work");
    rmSync(join(root, "kept"), { recursive: true });
    const base = { sessionId: "hostile", cwd: root, timestamp: "2026-10-01T00:00:00.000Z" };
    const lines = [
      JSON.stringify({
        ...base,
        type: "user",
        uuid: "u0",
        message: { role: "user", content: "tidy up" },
      }),
    ];
    for (const [i, [command, output]] of [
      ["git branch -D feature/kept-work", deleted],
      ["rm -rf kept", ""],
    ].entries()) {
      lines.push(
        JSON.stringify({
          ...base,
          type: "assistant",
          uuid: `a${i}`,
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command } }],
          },
        }),
        JSON.stringify({
          ...base,
          type: "user",
          uuid: `r${i}`,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: `t${i}`, content: output }],
          },
        }),
      );
    }
    return lines;
  }

  /** One card's markup, by category. */
  function cardOf(report: string, category: string): string {
    const at = report.indexOf(`id="check-${category}"`);
    return report.slice(report.lastIndexOf("<article", at), report.indexOf("</article>", at));
  }

  /** The note naming the file for fixes that could not be made safe, which the file does hold. */
  const UNSAFE_NOTE = /<span data-template="card\.fixes-file-unsafe">[\s\S]*?<\/span>/;

  it.each([
    ["lost-work", "Recover each one by its commit id"],
    ["skipped-checks", "Remove the instruction to skip checks"],
    ["destructive", "Restore each tracked target"],
  ])("%s: its fix step and its lines never say the fixes file holds a command", async (category, step) => {
    const { dir } = writeTranscripts(hostileCorpus());
    const run = await scan(["--agent", "claude", "--dir", dir]);
    expect(run.code).toBe(0);
    const fixesPath = [...run.written.keys()].find((path) => path.endsWith(FIXES_FILENAME));
    expect(fixesPath, "the file is written for the unsafe fixes").toBeDefined();
    const report =
      [...run.written.entries()].find(([path]) => !path.endsWith(FIXES_FILENAME))?.[1] ?? "";
    const card = cardOf(report, category);
    // The card has a fix step to say, and every one of its fixes could not be made safe.
    expect(card).toContain(step);
    expect(card).toContain("Could not make a safe command for");
    const note = whatHappenedNote(report);
    expect(note).not.toContain('data-template="card.fixes-file"');
    // Only the note under the cards says where those fixes are listed; no card names the file.
    expect(note).toMatch(UNSAFE_NOTE);
    const rest = card + note.replace(UNSAFE_NOTE, "");
    expect(rest).not.toMatch(/fixes file/i);
    expect(rest).not.toContain(FIXES_FILENAME);
  });
});
