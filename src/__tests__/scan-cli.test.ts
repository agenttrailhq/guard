/**
 * `commands/scan.ts` — flags, the walk, the two output modes, and the failure
 * directions.
 *
 * The IO seam is a fake here, so no test touches a real home directory, spawns a
 * process, or writes into the repository. The transcripts are synthetic JSONL strings
 * fed through the same `LineSource` shape the real reader uses, which means the
 * transcript parser is exercised end to end rather than stubbed out.
 *
 * There is also an IMPORT FENCE at the bottom: `scan`'s promise is "no account, no
 * network", enforced over the import graph rather than by reading the code.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { parseScanFlags, runScan } from "../commands/scan.js";
import { escapeHtml, REPORT_FILENAME } from "../core/report.js";
import type { ScanIO, ScanStat } from "../scan-io.js";
import { assistantLine, bash, TEST_CATALOG, toolUse, userLine } from "./scan-fixtures.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");

/** A fake filesystem: `dir → entries` and `file → contents`. */
interface FakeDisk {
  readonly dirs: Readonly<Record<string, readonly string[]>>;
  readonly files: Readonly<Record<string, string>>;
}

interface Recorded {
  readonly stdout: string[];
  readonly written: Map<string, string>;
  readonly opened: string[];
}

/**
 * Answers a `--review` prompt reads, in order, then end-of-input.
 *
 * The exhaustion case is the interesting one and is why this is a queue rather than a
 * constant: end of input is NOT "no", and `runScan` has to tell them apart.
 */
function answers(...lines: readonly string[]): () => Promise<string | undefined> {
  const queue = [...lines];
  return () => Promise.resolve(queue.shift());
}

/** Build a `ScanIO` over a fake disk, plus the record of what it was asked to do. */
function fakeIO(
  disk: FakeDisk,
  overrides: Partial<ScanIO> = {},
): { io: ScanIO; recorded: Recorded } {
  const recorded: Recorded = { stdout: [], written: new Map(), opened: [] };
  const io: ScanIO = {
    readdir(path: string): string[] {
      const entries = disk.dirs[path];
      // THROWS, like `readdirSync` — the transcript walker's own try/catch is what turns
      // a missing directory into an empty inventory, and a fake that returned `[]`
      // would leave that error handling untested.
      if (entries === undefined) throw new Error(`ENOENT: ${path}`);
      return [...entries];
    },
    stat(path: string): ScanStat {
      if (disk.dirs[path] !== undefined) {
        return { size: 0, mtimeMs: 0, isDirectory: () => true };
      }
      const file = disk.files[path];
      if (file === undefined) throw new Error(`ENOENT: ${path}`);
      return { size: file.length, mtimeMs: 1_757_000_000_000, isDirectory: () => false };
    },
    async *readLines(path: string): AsyncIterable<string> {
      const file = disk.files[path];
      if (file === undefined) throw new Error(`ENOENT: ${path}`);
      for (const line of file.split("\n")) yield line;
    },
    readFile: () => undefined,
    homedir: () => "/home/test",
    cwd: () => "/work",
    writeStdout: (text) => {
      recorded.stdout.push(text);
    },
    // Default: nobody is there. Only `--review` reads it, and the default is the
    // unattended case, so a test that forgets to supply an answer gets the safe
    // direction — nothing written — rather than an accidental confirmation.
    readLine: () => Promise.resolve(undefined),
    writeFile: (path, text) => {
      recorded.written.set(path, text);
      return true;
    },
    openInBrowser: (path) => {
      recorded.opened.push(path);
      return true;
    },
    env: {},
    isTTY: () => false,
    ...overrides,
  };
  return { io, recorded };
}

/** One project directory holding one transcript. */
function diskWith(lines: readonly string[], root = "/home/test/.claude/projects"): FakeDisk {
  const project = `${root}/-Users-priya-clients-acme`;
  return {
    dirs: { [root]: ["-Users-priya-clients-acme"], [project]: ["session-1.jsonl"] },
    files: { [`${project}/session-1.jsonl`]: lines.join("\n") },
  };
}

const DEPS = { catalog: TEST_CATALOG, now: new Date("2026-09-08T09:00:00.000Z") };

const TRANSCRIPT = [
  userLine("please clean up"),
  assistantLine([bash("rm -rf /Users/priya/clients/acme/build", "t1")], {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 5000,
  }),
  assistantLine([bash("rm -rf /Users/priya/clients/beta/dist", "t2")]),
  assistantLine([toolUse("Read", { file_path: "/Users/priya/clients/acme/.env" }, "t3")]),
  assistantLine([bash("ls -la", "t4")]),
];

describe("flag parsing", () => {
  it.each([
    ["no flags", [], { dir: undefined, json: false, open: false }],
    ["--json", ["--json"], { json: true }],
    ["--open", ["--open"], { open: true }],
    ["--dir with a space", ["--dir", "/tmp/x"], { dir: "/tmp/x" }],
    ["--dir with an equals", ["--dir=/tmp/x"], { dir: "/tmp/x" }],
    [
      "all three",
      ["--dir", "/tmp/x", "--json", "--open"],
      { dir: "/tmp/x", json: true, open: true },
    ],
  ])("%s", (_label, argv, expected) => {
    expect(parseScanFlags(argv)).toMatchObject(expected);
  });

  it("reports an unknown flag instead of ignoring it", () => {
    // Silently dropping `--jsn` would print a human summary into something waiting for
    // JSON, which is a worse failure than refusing.
    expect(parseScanFlags(["--jsn"]).unknown).toBe("--jsn");
  });

  it("refuses a --dir with nothing after it, rather than scanning a flag", () => {
    expect(parseScanFlags(["--dir"]).unknown).toContain("--dir");
    expect(parseScanFlags(["--dir", "--json"]).unknown).toContain("--dir");
    expect(parseScanFlags(["--dir", "--json"]).dir).toBeUndefined();
  });

  it("--help is a flag, not an unknown argument", () => {
    expect(parseScanFlags(["--help"]).help).toBe(true);
    expect(parseScanFlags(["-h"]).unknown).toBeUndefined();
  });

  it("--review parses, and is off by default", () => {
    expect(parseScanFlags([]).review).toBe(false);
    expect(parseScanFlags(["--review"]).review).toBe(true);
    expect(parseScanFlags(["--review"]).unknown).toBeUndefined();
  });
});

/**
 * `--review` — the bounded human check that `redact-identifiers.ts` says it needs.
 *
 * The module it backstops is a deny-list and will miss the tool nobody thought of. What
 * this asserts is not that redaction is complete — it is not — but that a user is shown
 * the exact strings before the file exists, and that nothing is written without a clear
 * yes.
 */
describe("--review", () => {
  it("prints every command the report will contain, then writes on a yes", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT), { readLine: answers("y") });
    expect(await runScan(["--review"], io, DEPS)).toBe(0);

    const out = recorded.stdout.join("");
    expect(out).toContain("Review — everything this report will contain.");
    expect(out).toContain("rm -rf <path>");
    expect(out).toContain("Command shapes in the report");
    expect(out).toContain(`Write ${join("/work", REPORT_FILENAME)}?`);
    expect([...recorded.written.keys()]).toEqual([join("/work", REPORT_FILENAME)]);
  });

  it("shows the same strings the file gets, not a summary of them", async () => {
    // The whole promise of the step. A review over a different set — a truncation, a
    // re-render, anything — would be a review of something the user is not shipping.
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT), { readLine: answers("y") });
    await runScan(["--review"], io, DEPS);

    const html = recorded.written.get(join("/work", REPORT_FILENAME)) ?? "";
    // Only the review block, which ends at the prompt — the terminal summary that
    // follows it prints a padded repeats table that is NOT a claim about the file.
    const out = recorded.stdout.join("");
    const reviewed = out
      .slice(0, out.indexOf("Write "))
      .split("\n")
      .filter((l) => l.startsWith("  "))
      .map((l) => l.trim());
    expect(reviewed.length).toBeGreaterThan(0);
    // A guardrail line shows an id and a title, which the HTML renders into two
    // separate elements — so the claim is checked per string, not per rendered line.
    const strings = reviewed.flatMap((line) => line.split("  ").filter(Boolean));
    expect(strings.length).toBeGreaterThan(0);
    for (const value of strings) {
      // Escaped, because that is the form the file carries — the review shows the
      // string, the renderer escapes it. Comparing the raw form would fail on every
      // `<path>` and prove nothing about whether the two sets agree.
      expect(html, `"${value}" was reviewed but is not in the file`).toContain(escapeHtml(value));
    }
  });

  it.each([
    ["n"],
    ["no"],
    [""],
    ["  "],
    ["yep"],
    ["Y E S"],
  ])("writes nothing on %o, and exits 0 because a no is not a failure", async (answer) => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT), { readLine: answers(answer) });
    expect(await runScan(["--review"], io, DEPS)).toBe(0);
    expect([...recorded.written.keys()]).toEqual([]);
    expect(recorded.stdout.join("")).toContain("Nothing was written.");
  });

  it.each([["y"], ["Y"], ["yes"], ["YES"], [" yes "]])("accepts %o", async (answer) => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT), { readLine: answers(answer) });
    expect(await runScan(["--review"], io, DEPS)).toBe(0);
    expect([...recorded.written.keys()]).toHaveLength(1);
  });

  it("end of input is not a no — it says so and exits 1", async () => {
    // An unattended run that exited 0 having written nothing would be the same silent
    // failure this is about, pointed the other way.
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT), { readLine: answers() });
    expect(await runScan(["--review"], io, DEPS)).toBe(1);
    expect([...recorded.written.keys()]).toEqual([]);
    expect(recorded.stdout.join("")).toContain("needs an answer on stdin");
  });

  it("is refused with --json, which writes no file at all", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT), { readLine: answers("y") });
    expect(await runScan(["--review", "--json"], io, DEPS)).toBe(1);
    expect(recorded.stdout.join("")).toContain("cannot be combined");
    expect(recorded.stdout.join("")).not.toContain("<!doctype");
    expect([...recorded.written.keys()]).toEqual([]);
  });

  it("says so when there is nothing to review", async () => {
    const { io, recorded } = fakeIO({ dirs: {}, files: {} }, { readLine: answers("y") });
    expect(await runScan(["--review"], io, DEPS)).toBe(0);
    expect(recorded.stdout.join("")).toContain("no commands and no guardrail names");
  });

  it("the default run asks nothing and writes — --review is opt-in", async () => {
    // The negative control for the whole block: if the prompt fired unconditionally,
    // every assertion above would pass for the wrong reason.
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT), { readLine: answers() });
    expect(await runScan([], io, DEPS)).toBe(0);
    expect(recorded.stdout.join("")).not.toContain("Review —");
    expect([...recorded.written.keys()]).toHaveLength(1);
  });
});

describe("the default run", () => {
  it("reads the transcripts, writes the report and prints a summary", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT));
    expect(await runScan([], io, DEPS)).toBe(0);

    const reportPath = join("/work", REPORT_FILENAME);
    expect([...recorded.written.keys()]).toEqual([reportPath]);
    expect(recorded.written.get(reportPath)?.startsWith("<!doctype html>")).toBe(true);

    const summary = recorded.stdout.join("");
    expect(summary).toContain("1 session");
    expect(summary).toContain("3 risky actions");
    expect(summary).toContain(reportPath);
  });

  it("counts the repeat, and shows it as one shape", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT));
    await runScan([], io, DEPS);
    const summary = recorded.stdout.join("");
    expect(summary).toContain("Top repeats");
    expect(summary).toContain("rm -rf <path>");
    expect(summary).toContain("2x");
  });

  it("emits no ANSI escape when stdout is not a terminal", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT));
    await runScan([], io, DEPS);
    expect(recorded.stdout.join("")).not.toMatch(new RegExp(String.fromCharCode(0x1b)));
  });

  it("does colour when stdout IS a terminal — the control for the test above", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT), { isTTY: () => true });
    await runScan([], io, DEPS);
    expect(recorded.stdout.join("")).toMatch(new RegExp(String.fromCharCode(0x1b)));
  });

  it("--dir points the walk somewhere else entirely", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT, "/elsewhere"));
    // The default root has nothing on this disk, so a walk that ignored `--dir` would
    // report zero sessions rather than one.
    expect(await runScan(["--dir", "/elsewhere"], io, DEPS)).toBe(0);
    expect(recorded.stdout.join("")).toContain("1 session");
  });

  it("--open hands the report path to the opener exactly once", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT));
    expect(await runScan(["--open"], io, DEPS)).toBe(0);
    expect(recorded.opened).toEqual([join("/work", REPORT_FILENAME)]);
  });

  it("does NOT open when --open was not asked for", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT));
    await runScan([], io, DEPS);
    expect(recorded.opened).toEqual([]);
  });
});

describe("--json", () => {
  it("prints parseable JSON and writes no file", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT));
    expect(await runScan(["--json"], io, DEPS)).toBe(0);
    expect(recorded.written.size).toBe(0);

    const payload = JSON.parse(recorded.stdout.join(""));
    expect(payload.tool).toBe("agenttrail-guard");
    expect(payload.result.sessions).toBe(1);
    expect(payload.result.riskyActions).toBe(3);
  });

  it("prints the JSON and nothing else, so a pipe stays parseable", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT));
    await runScan(["--json"], io, DEPS);
    expect(recorded.stdout.join("")).not.toContain("Top repeats");
  });

  it("carries no secret, no path and no project name", async () => {
    const withSecret = [
      ...TRANSCRIPT,
      assistantLine([bash("rm -rf /tmp/x && export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE", "t5")]),
    ];
    const { io, recorded } = fakeIO(diskWith(withSecret));
    await runScan(["--json"], io, DEPS);
    const out = recorded.stdout.join("");
    for (const leak of ["AKIAIOSFODNN7EXAMPLE", "priya", "acme", "/Users/"]) {
      expect(out).not.toContain(leak);
    }
    expect(out).toContain("[REDACTED:");
  });
});

describe("failure directions", () => {
  it("a missing projects directory is a normal state: empty report, exit 0", async () => {
    const { io, recorded } = fakeIO({ dirs: {}, files: {} });
    expect(await runScan([], io, DEPS)).toBe(0);
    expect(recorded.stdout.join("")).toContain("No sessions found");
    expect(recorded.written.size).toBe(1);
  });

  it("a transcript with no message spine is skipped and COUNTED, not fatal", async () => {
    const root = "/home/test/.claude/projects";
    const project = `${root}/-p`;
    const { io, recorded } = fakeIO({
      dirs: { [root]: ["-p"], [project]: ["good.jsonl", "bad.jsonl"] },
      files: {
        [`${project}/good.jsonl`]: TRANSCRIPT.join("\n"),
        // Valid JSON lines with no message spine at all — a `QuarantineError`.
        [`${project}/bad.jsonl`]: '{"type":"summary"}\nnot json at all\n',
      },
    });
    expect(await runScan([], io, DEPS)).toBe(0);
    const summary = recorded.stdout.join("");
    expect(summary).toContain("1 session");
    expect(summary).toContain("1 file yielded no session and was skipped");
  });

  it("counts transcript files nested BELOW the reader's walk, and says so", async () => {
    // Sub-agent transcripts sit at `<project>/<session>/subagents/*.jsonl`, and the
    // reader walks exactly `<project>/<session>.jsonl`. A scan that silently skipped them
    // would report a confident number over part of the corpus, so the reader counts the
    // gap and states it.
    const root = "/home/test/.claude/projects";
    const project = `${root}/-p`;
    const nested = `${project}/session-1/subagents`;
    const { io, recorded } = fakeIO({
      dirs: {
        [root]: ["-p"],
        [project]: ["session-1.jsonl", "session-1"],
        [`${project}/session-1`]: ["subagents"],
        [nested]: ["agent-a.jsonl", "agent-b.jsonl", "notes.md"],
      },
      files: {
        [`${project}/session-1.jsonl`]: TRANSCRIPT.join("\n"),
        [`${nested}/agent-a.jsonl`]: TRANSCRIPT.join("\n"),
        [`${nested}/agent-b.jsonl`]: TRANSCRIPT.join("\n"),
        [`${nested}/notes.md`]: "not a transcript",
      },
    });
    expect(await runScan(["--json"], io, DEPS)).toBe(0);
    const payload = JSON.parse(recorded.stdout.join(""));
    expect(payload.result.sessions).toBe(1);
    // Two nested `.jsonl` files; `notes.md` is not a transcript and is not counted.
    expect(payload.result.notRead).toBe(2);
  });

  it("reports nothing about coverage when the whole root was read", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT));
    await runScan(["--json"], io, DEPS);
    expect(JSON.parse(recorded.stdout.join("")).result.notRead).toBe(0);
  });

  it("the summary names the not-read files rather than leaving the count silent", async () => {
    const root = "/home/test/.claude/projects";
    const project = `${root}/-p`;
    const { io, recorded } = fakeIO({
      dirs: { [root]: ["-p"], [project]: ["s.jsonl", "deep"], [`${project}/deep`]: ["x.jsonl"] },
      files: {
        [`${project}/s.jsonl`]: TRANSCRIPT.join("\n"),
        [`${project}/deep/x.jsonl`]: TRANSCRIPT.join("\n"),
      },
    });
    await runScan([], io, DEPS);
    expect(recorded.stdout.join("")).toContain("1 further transcript file was not read");
  });

  it("a report that cannot be written still prints the summary, names it, and exits 1", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT), { writeFile: () => false });
    expect(await runScan([], io, DEPS)).toBe(1);
    const summary = recorded.stdout.join("");
    // The summary is the immediate payoff and must not depend on a writable directory.
    expect(summary).toContain("risky action");
    expect(summary).toContain("Could not write the report");
    // …and it must not claim a path that does not exist.
    expect(summary).not.toContain(`Full report: ${join("/work", REPORT_FILENAME)}`);
  });

  it("a failing opener leaves the exit code at 0 and says so", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT), { openInBrowser: () => false });
    expect(await runScan(["--open"], io, DEPS)).toBe(0);
    expect(recorded.stdout.join("")).toContain("Could not open the report");
  });

  it("an unknown argument prints usage and exits 1", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT));
    expect(await runScan(["--nope"], io, DEPS)).toBe(1);
    expect(recorded.stdout.join("")).toContain("unknown argument");
    expect(recorded.written.size).toBe(0);
  });

  it("--help prints usage and exits 0 without scanning", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT));
    expect(await runScan(["--help"], io, DEPS)).toBe(0);
    expect(recorded.written.size).toBe(0);
    expect(recorded.stdout.join("")).toContain("--dir <root>");
  });
});

describe("the user's own configuration is honoured", () => {
  it("a disabled guardrail does not appear in the report", async () => {
    // Otherwise the report claims a rule would have fired on a machine where the user
    // has switched it off — a statement about enforcement that is not true here.
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT), {
      readFile: (path) =>
        path.endsWith("config.json")
          ? JSON.stringify({ disabledGuardrails: ["t.rm-rf"] })
          : undefined,
    });
    await runScan(["--json"], io, DEPS);
    const payload = JSON.parse(recorded.stdout.join(""));
    expect(payload.result.findings.map((f: { ruleId: string }) => f.ruleId)).toEqual([
      "t.env-file",
    ]);
  });

  it("an allowlist entry suppresses that guardrail and leaves the others firing", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT), {
      readFile: (path) =>
        path.endsWith("config.json")
          ? JSON.stringify({ allowlist: [{ guardrail: "t.rm-rf", pattern: "rm -rf /Users/**" }] })
          : undefined,
    });
    await runScan(["--json"], io, DEPS);
    const payload = JSON.parse(recorded.stdout.join(""));
    expect(payload.result.findings.map((f: { ruleId: string }) => f.ruleId)).toEqual([
      "t.env-file",
    ]);
  });

  it("a corrupt config file falls back to defaults rather than failing", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT), {
      readFile: (path) => (path.endsWith("config.json") ? "{not json" : undefined),
    });
    expect(await runScan([], io, DEPS)).toBe(0);
    expect(recorded.stdout.join("")).toContain("3 risky actions");
  });
});

// ── Import fences ───────────────────────────────────────────────────────────

/** Parse import DECLARATIONS. Prose in a comment can never become one. */
function importsOf(source: string): string[] {
  const sf = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, false);
  const out: string[] = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      out.push(st.moduleSpecifier.text);
    }
  }
  return out;
}

/** Every module reachable from `entry` by relative import. */
function graphFrom(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    for (const spec of importsOf(readFileSync(file, "utf8"))) {
      if (!spec.startsWith(".")) continue;
      const candidate = join(dirname(file), spec.replace(/\.js$/, ".ts"));
      if (existsSync(candidate)) queue.push(candidate);
    }
  }
  return [...seen];
}

const SCAN_GRAPH = graphFrom(join(SRC, "commands", "scan.ts"));

describe("what scan is allowed to reach", () => {
  it("finds a non-trivial graph (a fence over nothing proves nothing)", () => {
    expect(SCAN_GRAPH.length).toBeGreaterThan(8);
    expect(SCAN_GRAPH).toContain(join(SRC, "core", "report.ts"));
  });

  it("negative control — the graph walk does find a real import", () => {
    // Without this, a fence over the graph could pass over an empty specifier list.
    const specifiers = SCAN_GRAPH.flatMap((f) => importsOf(readFileSync(f, "utf8")));
    expect(specifiers).toContain("../core/report.js");
  });

  it("touches no module outside src/", () => {
    expect(SCAN_GRAPH.every((f) => f.startsWith(SRC))).toBe(true);
  });

  it("core/transcript holds exactly the three modules scan needs", () => {
    expect(readdirSync(join(SRC, "core", "transcript")).sort()).toEqual([
      "parse.ts",
      "scan.ts",
      "transcript-types.ts",
    ]);
  });
});
