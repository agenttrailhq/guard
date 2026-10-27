// cspell:words THROWNCHECKCANARY
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
  existsSync,
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
import { CHECKS_FAILED_LINE, runScan, samePath } from "../commands/scan.js";
import { fixCategories, fixesFileText } from "../core/fixes-file.js";
import { FIXES_FILENAME, REPORT_FILENAME } from "../core/report.js";
import {
  type CommandPart,
  isLocalFix,
  type LocalFix,
  localFixCommand,
  type UnsafeFix,
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
        "report, and it is written for your user account only (mode 0600, where the system",
        "honours it). Read each command before you run it. Nothing here has been run.",
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
    /** Fixes added to whatever the checks make, of either kind. */
    readonly extra?: readonly (LocalFix | UnsafeFix)[];
    /** Make the write of the fixes file fail. */
    readonly failFixes?: boolean;
    /** Make the checks throw, with this message. */
    readonly throws?: string;
    /** The platform the scan runs as. */
    readonly platform?: string;
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
    // A write of the fixes file can be made to fail, as on a full or read-only disk.
    writeFile: (path, text) =>
      options.failFixes === true && path.endsWith(FIXES_FILENAME)
        ? false
        : real.writeFile(path, text),
    openInBrowser: () => true,
    env: { CI: "1" },
    isTTY: () => false,
  };
  const code = await runScan(["--agent", "claude", "--dir", root, "--no-open", ...argv], io, {
    catalog: [RULE_RM_RF],
    now: AT,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    verify: async (input: VerifyInput) => {
      if (options.throws !== undefined) throw new Error(options.throws);
      const outcome = await verifyScan(input);
      // Fixed fixes of every kind beside what the real checks hand over, so each card that has
      // a command in the file names it.
      const base = options.fixes === false ? [] : [...FIXES, SECRETS_LOCAL];
      return {
        ...outcome,
        localFixes: [...outcome.localFixes, ...base, ...(options.extra ?? [])],
      };
    },
  });
  return { code, stdout: out.join(""), work };
}

describe("the report never takes the fixes file's place, whatever the case", () => {
  it("compares paths without case on macOS and Windows, and with it elsewhere", () => {
    expect(
      samePath("/a/AGENTTRAIL-GUARD-FIXES.TXT", "/a/agenttrail-guard-fixes.txt", "darwin"),
    ).toBe(true);
    expect(samePath("C:\\a\\Fixes.txt", "c:\\a\\fixes.txt", "win32")).toBe(true);
    expect(
      samePath("/a/AGENTTRAIL-GUARD-FIXES.TXT", "/a/agenttrail-guard-fixes.txt", "linux"),
    ).toBe(false);
  });

  it("on macOS, --out the fixes file's name in capitals writes no fixes file to be replaced", async () => {
    const upper = FIXES_FILENAME.toUpperCase();
    const run = await scan(["--verify", "--out", upper], { platform: "darwin" });
    expect(run.code).toBe(0);
    expect(run.stdout).not.toContain("Fix commands for this machine:");
  });
});

describe("a check that throws does not take the scan down", () => {
  const CANARY = "THROWNCHECKCANARY /Users/sample/secret-path";

  it("writes the page without verification, says the checks could not run, exits 0", async () => {
    const run = await scan(["--verify"], { throws: CANARY });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(CHECKS_FAILED_LINE);
    // Never the error's text or a stack trace.
    expect(run.stdout).not.toContain("THROWNCHECKCANARY");
    expect(run.stdout).not.toMatch(/\n\s+at /);
    const report = readFileSync(join(run.work, REPORT_FILENAME), "utf8");
    expect(report).not.toContain('id="what-happened"');
    expect(report).not.toContain("THROWNCHECKCANARY");
    expect(existsSync(join(run.work, FIXES_FILENAME))).toBe(false);
  });

  it("--json still prints a parseable result, with no verification and no error", async () => {
    const run = await scan(["--verify", "--json"], { throws: CANARY });
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout).result.verification).toBeUndefined();
    expect(run.stdout).not.toContain("THROWNCHECKCANARY");
  });

  it("negative control: checks that run say what they checked, not that they could not", async () => {
    const run = await scan(["--verify"]);
    expect(run.stdout).not.toContain(CHECKS_FAILED_LINE);
    expect(run.stdout).toContain("Checked on this machine (read-only, offline)");
  });
});

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

describe("--review says a yes also writes the fixes file", () => {
  it("names the file and how many exact commands it holds, before the question", async () => {
    const run = await scan(["--verify", "--review"], { answer: "n" });
    const line = run.stdout.split("\n").find((l) => l.startsWith("A yes also writes "));
    expect(line).toBe(
      `A yes also writes ${join(run.work, FIXES_FILENAME)}: 4 exact fix commands for this machine, with real names and paths, not shown here and not part of the report.`,
    );
    expect(run.stdout.indexOf("A yes also writes")).toBeLessThan(run.stdout.indexOf("? [y/N]"));
  });

  it("says nothing of it when there is no exact command", async () => {
    const run = await scan(["--verify", "--review"], { answer: "n", fixes: false });
    expect(run.stdout).not.toContain("A yes also writes");
  });
});

describe("a fix that could not be made safe", () => {
  // Built the way the checks build them: a value outside the safe set makes no command at all.
  const spaced = localFixCommand("lost-work", ["git", "branch", { branch: "two words" }]);
  const dashed = localFixCommand("unreviewed", ["git", "show", { ref: "-p" }]);

  it("is what localFixCommand makes from a value outside the safe set", () => {
    expect(isLocalFix(spaced)).toBe(false);
    expect(isLocalFix(dashed)).toBe(false);
  });

  it("is listed under its category as a note, never as a command, and nothing crashes", () => {
    const text = fixesFileText([BRANCH, spaced, dashed], {
      version: "9.9.9",
      generatedAt: AT,
      reportName: REPORT_FILENAME,
    });
    expect(text).toContain(
      [
        "Lost work",
        BRANCH.command,
        "(1 fix here: could not make a safe command, so none is written for it.)",
      ].join("\n"),
    );
    expect(text).toContain(
      [
        "Unreviewed code",
        "(1 fix here: could not make a safe command, so none is written for it.)",
      ].join("\n"),
    );
    expect(text).not.toContain("two words");
    expect(text).not.toContain("left out because");
  });

  it("names the file on a card only where the file holds an exact command", () => {
    expect(fixCategories([BRANCH, spaced, dashed])).toEqual(["lost-work"]);
    expect(fixCategories([dashed])).toEqual([]);
  });

  it("is written, and said in --review, even when it is the only fix", async () => {
    const run = await scan(["--verify", "--review"], {
      answer: "y",
      extra: [dashed],
      fixes: false,
    });
    const text = readFileSync(join(run.work, FIXES_FILENAME), "utf8");
    expect(text).toContain("Unreviewed code\n(1 fix here: could not make a safe command");
    expect(run.stdout).toContain(
      "0 exact fix commands for this machine, with real names and paths, and 1 fix it could not make a safe command for",
    );
    // No card names a file that holds no command for it.
    expect(readFileSync(join(run.work, REPORT_FILENAME), "utf8")).not.toContain(FIXES_FILENAME);
  });
});

describe("when the fixes file cannot be written", () => {
  it("the report does not name it, and the summary says it could not be written", async () => {
    const run = await scan(["--verify"], { failFixes: true });
    expect(run.code).toBe(0);
    const path = join(run.work, FIXES_FILENAME);
    expect(() => statSync(path)).toThrow();
    expect(readFileSync(join(run.work, REPORT_FILENAME), "utf8")).not.toContain(FIXES_FILENAME);
    expect(run.stdout).toContain(`Could not write the fix commands to ${path}`);
    expect(run.stdout).not.toContain("Fix commands for this machine");
  });

  it("--out naming the fixes file writes the report there, and no fixes file over it", async () => {
    const run = await scan(["--verify", "--out", FIXES_FILENAME]);
    expect(run.code).toBe(0);
    const html = readFileSync(join(run.work, FIXES_FILENAME), "utf8");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toContain(`in <code>${FIXES_FILENAME}</code>`);
    expect(run.stdout).not.toContain("Fix commands for this machine");
  });
});

describe("an older fixes file next to the report", () => {
  it("is said, and left as it was, when this scan made no fix command", async () => {
    const run = await scan(["--verify"], { fixes: false, before: "an older file\n" });
    const path = join(run.work, FIXES_FILENAME);
    expect(readFileSync(path, "utf8")).toBe("an older file\n");
    expect(run.stdout).toContain(
      `${path} is from an earlier scan; this one wrote no fix commands, so it is left as it was.`,
    );
  });

  it("is not mentioned when there is none", async () => {
    const run = await scan(["--verify"], { fixes: false });
    expect(run.stdout).not.toContain("is from an earlier scan");
  });
});

describe("the fixes file refuses characters that change how a command reads", () => {
  it.each([
    ["a C1 control", "\u0085"],
    ["a line separator", " "],
    ["a right-to-left override", "‮"],
    ["an isolate", "⁧"],
  ])("leaves out a command holding %s", (_name, char) => {
    const fix = exact("lost-work", ["git", "branch", `a${char}b`]);
    expect(fixCategories([fix])).toEqual([]);
  });
});
