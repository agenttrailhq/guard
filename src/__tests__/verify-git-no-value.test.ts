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
import { decodedSurfaces, stringLeaves } from "./html-text.js";

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

/** One in-process run of `scan`, with no guardrail in the catalog. */
async function scan(argv: readonly string[], answer?: string) {
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
