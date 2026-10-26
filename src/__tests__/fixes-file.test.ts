/**
 * The local fixes file: the exact fix commands for this machine, next to the report, at `0600`.
 *
 * The text is pinned as a whole. Then `scan` runs for real, over a synthetic corpus in a
 * temporary folder, with the checks wrapped so they return exact commands the way a check that
 * finds lost work would: the file is written with mode `0600` (a file already there is set to it
 * too), the report's cards name it, and neither the page, its data block nor the review carries
 * an exact command. With no exact command, `--json`, or a declined `--review`, no file is written.
 */

import {
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runScan } from "../commands/scan.js";
import { fixCategories, fixesFileText } from "../core/fixes-file.js";
import { FIXES_FILENAME, REPORT_FILENAME } from "../core/report.js";
import {
  type CommandPart,
  isLocalFix,
  type LocalFix,
  localFixCommand,
} from "../core/verify/cards.js";
import type { VerifyCategory } from "../core/verify/types.js";
import { type VerifyInput, verifyScan } from "../core/verify/verify.js";
import { createRealScanIO, type ScanIO } from "../scan-io.js";
import { RULE_RM_RF } from "./scan-fixtures.js";
import { writeCorpus } from "./verify-fixtures.js";

/** An exact fix, built from quoted parts as the checks build them. Throws if it is not safe. */
function exact(category: VerifyCategory, parts: readonly CommandPart[]): LocalFix {
  const made = localFixCommand(category, parts);
  if (!isLocalFix(made)) throw new Error("not a safe command");
  return made;
}

const BRANCH = exact("lost-work", [
  "git",
  "branch",
  { branch: "recovered/feature-login" },
  { sha: "4f2a9c1" },
]);
const STASH = exact("lost-work", [
  "git",
  "-C",
  { ref: "/Users/sample/app" },
  "stash",
  "store",
  "-m",
  "recovered",
  { sha: "9e8d7c6" },
]);
const MEMORY_FIX = exact("skipped-checks", [{ ref: "/Users/sample/.claude/CLAUDE.md" }]);
/** An exact command for the secrets card, naming a real folder. */
const SECRETS_LOCAL = exact("secrets", [
  "ls",
  "-l",
  { ref: "/Users/sample/.claude/projects/-Users-sample-app" },
]);

const EXACT = [BRANCH.command, STASH.command] as const;
const MEMORY = MEMORY_FIX.command;
const SECRETS_FIX = SECRETS_LOCAL.command;

const FIXES = [BRANCH, MEMORY_FIX, STASH];

const AT = new Date("2026-10-01T09:00:00.000Z");

describe("the file's text", () => {
  it("is a short header, then each category's commands under its card's title, in card order", () => {
    expect(
      fixesFileText(FIXES, { version: "9.9.9", generatedAt: AT, reportName: REPORT_FILENAME }),
    ).toBe(
      [
        "AgentTrail Guard: fix commands for this machine",
        "",
        "Written by agenttrail-guard 9.9.9 on 1 Oct 2026, 09:00 UTC, with agenttrail-guard-report.html.",
        "",
        "These are the exact commands behind the redacted shapes in the report, with real",
        "branch names and paths. Keep this file on this machine: it is not part of the",
        "report, and only your user account can read it. Read each command before you run",
        "it. Nothing here has been run.",
        "",
        "Skipped safety checks",
        MEMORY,
        "",
        "Lost work",
        EXACT[0],
        EXACT[1],
        "",
      ].join("\n"),
    );
    expect(fixCategories(FIXES)).toEqual(["skipped-checks", "lost-work"]);
  });

  it("leaves out a command that spans lines, or is empty, and says how many", () => {
    const text = fixesFileText(
      [
        exact("lost-work", ["git", "branch", "a 1\ngit branch b 2"]),
        exact("lost-work", []),
        BRANCH,
      ],
      { version: "9.9.9", generatedAt: AT, reportName: REPORT_FILENAME },
    );
    expect(text).toContain("2 commands were left out because they do not fit on one line.");
    expect(text).not.toContain("a 1");
    expect(text).toContain(EXACT[0]);
    expect(fixCategories([exact("lost-work", ["x\ry"])])).toEqual([]);
  });
});

/** One real `scan --verify` over a synthetic corpus, in a fresh folder. */
async function scan(
  argv: readonly string[],
  options: {
    readonly fixes?: boolean;
    readonly answer?: string;
    readonly before?: string;
    /** Puts something in the work folder before the scan, such as a planted link. */
    readonly plant?: (work: string) => void;
  } = {},
): Promise<{ code: number; stdout: string; work: string }> {
  const { root } = await writeCorpus("claude", [
    [{ kind: "call", command: "rm -rf build", result: { text: "" } }],
  ]);
  const work = mkdtempSync(join(tmpdir(), "agenttrail-fixes-work-"));
  options.plant?.(work);
  if (options.before !== undefined) {
    writeFileSync(join(work, FIXES_FILENAME), options.before, { mode: 0o644 });
  }
  const out: string[] = [];
  const real = createRealScanIO();
  const io: ScanIO = {
    ...real,
    homedir: () => mkdtempSync(join(tmpdir(), "agenttrail-fixes-home-")),
    cwd: () => work,
    writeStdout: (text) => {
      out.push(text);
    },
    readLine: () => Promise.resolve(options.answer),
    openInBrowser: () => true,
    env: { CI: "1" },
    isTTY: () => false,
  };
  const code = await runScan(["--agent", "claude", "--dir", root, "--no-open", ...argv], io, {
    catalog: [RULE_RM_RF],
    now: AT,
    verify: async (input: VerifyInput) => {
      const outcome = await verifyScan(input);
      // Secrets is the one category with a check in this build, so its card names the file.
      return options.fixes === false
        ? outcome
        : { ...outcome, localFixes: [...FIXES, SECRETS_LOCAL] };
    },
  });
  return { code, stdout: out.join(""), work };
}

describe("scan writes the file next to the report", () => {
  it("at mode 0600, with the exact commands, and names it in the summary", async () => {
    const run = await scan(["--verify"]);
    expect(run.code).toBe(0);
    const path = join(run.work, FIXES_FILENAME);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const text = readFileSync(path, "utf8");
    for (const command of [...EXACT, MEMORY, SECRETS_FIX]) expect(text).toContain(command);
    expect(run.stdout).toContain(`Fix commands for this machine: ${path}`);
  });

  it("sets a file already there to 0600, and replaces what it held", async () => {
    const run = await scan(["--verify"], { before: "an older file\n" });
    const path = join(run.work, FIXES_FILENAME);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).not.toContain("an older file");
  });

  it("the report names the file on the cards with commands in it, and carries none of them", async () => {
    const run = await scan(["--verify"]);
    const html = readFileSync(join(run.work, REPORT_FILENAME), "utf8");
    expect(html).toContain(FIXES_FILENAME);
    for (const command of [...EXACT, MEMORY, SECRETS_FIX]) expect(html).not.toContain(command);
    expect(html).not.toContain("feature-login");
    expect(html).not.toContain("4f2a9c1");
    expect(statSync(join(run.work, REPORT_FILENAME)).mode & 0o777).toBe(0o600);
  });

  it("goes next to the report wherever --out puts it", async () => {
    const out = mkdtempSync(join(tmpdir(), "agenttrail-fixes-out-"));
    const run = await scan(["--verify", "--out", join(out, "mine.html")]);
    expect(run.code).toBe(0);
    expect(statSync(join(out, FIXES_FILENAME)).mode & 0o777).toBe(0o600);
    expect(() => statSync(join(run.work, FIXES_FILENAME))).toThrow();
  });

  it("is not written, or named, when no check made an exact command", async () => {
    const run = await scan(["--verify"], { fixes: false });
    expect(() => statSync(join(run.work, FIXES_FILENAME))).toThrow();
    expect(readFileSync(join(run.work, REPORT_FILENAME), "utf8")).not.toContain(FIXES_FILENAME);
    expect(run.stdout).not.toContain("Fix commands for this machine");
  });

  it("is not written by --json, which writes no file and carries no exact command", async () => {
    const run = await scan(["--verify", "--json"]);
    expect(() => statSync(join(run.work, FIXES_FILENAME))).toThrow();
    for (const command of [...EXACT, MEMORY, SECRETS_FIX])
      expect(run.stdout).not.toContain(command);
  });

  it("is not written when --review is declined, and the review shows no exact command", async () => {
    const run = await scan(["--verify", "--review"], { answer: "n" });
    expect(() => statSync(join(run.work, FIXES_FILENAME))).toThrow();
    for (const command of [...EXACT, MEMORY, SECRETS_FIX])
      expect(run.stdout).not.toContain(command);
  });
});

describe("a link planted where the files go cannot redirect them", () => {
  it.each([
    ["symbolic", FIXES_FILENAME],
    ["hard", FIXES_FILENAME],
    ["symbolic", REPORT_FILENAME],
    ["hard", REPORT_FILENAME],
  ] as const)("a %s link at %s is replaced, and the file it led to is untouched", async (kind, name) => {
    const elsewhere = mkdtempSync(join(tmpdir(), "agenttrail-fixes-elsewhere-"));
    const other = join(elsewhere, "profile");
    writeFileSync(other, "keep me\n", { mode: 0o644 });
    const run = await scan(["--verify"], {
      plant: (work) => {
        const path = join(work, name);
        if (kind === "symbolic") symlinkSync(other, path);
        else linkSync(other, path);
      },
    });
    expect(run.code).toBe(0);
    expect(readFileSync(other, "utf8")).toBe("keep me\n");
    expect(statSync(other).mode & 0o777).toBe(0o644);
    const path = join(run.work, name);
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(statSync(path).nlink).toBe(1);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
