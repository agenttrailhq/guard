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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { agentChoiceMessage } from "../commands/agent-choice.js";
import { parseScanFlags, renderSummary, runScan, shouldOpen } from "../commands/scan.js";
import { ARTIFACT_FILENAME, escapeHtml, REPORT_FILENAME } from "../core/report.js";
import type { ScanResult } from "../core/scan-report.js";
import type { GuardAction } from "../core/types.js";
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
    [
      "no flags",
      [],
      { dir: undefined, json: false, noOpen: false, artifact: false, out: undefined },
    ],
    ["--json", ["--json"], { json: true }],
    ["--no-open", ["--no-open"], { noOpen: true }],
    ["--artifact", ["--artifact"], { artifact: true }],
    ["--dir with a space", ["--dir", "/tmp/x"], { dir: "/tmp/x" }],
    ["--dir with an equals", ["--dir=/tmp/x"], { dir: "/tmp/x" }],
    ["--out with a space", ["--out", "/tmp/r.html"], { out: "/tmp/r.html" }],
    ["--out with an equals", ["--out=/tmp/r.html"], { out: "/tmp/r.html" }],
    [
      "all three",
      ["--dir", "/tmp/x", "--json", "--no-open"],
      { dir: "/tmp/x", json: true, noOpen: true },
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

  it.each([
    ["nothing after it", ["--out"]],
    ["a flag after it", ["--out", "--json"]],
    ["an empty value", ["--out="]],
  ])("refuses an --out with %s, rather than writing a file named after a flag", (_l, argv) => {
    expect(parseScanFlags(argv).unknown).toContain("--out");
    expect(parseScanFlags(argv).out).toBeUndefined();
  });

  it("--open is gone: the report opens by default, so it is an unknown argument", () => {
    expect(parseScanFlags(["--open"]).unknown).toBe("--open");
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

  it.each([
    ["--agent claude", ["--agent", "claude"], "claude"],
    ["--agent cursor", ["--agent", "cursor"], "cursor"],
    ["--agent=cursor", ["--agent=cursor"], "cursor"],
    ["--agent codex", ["--agent", "codex"], "codex"],
    ["--agent=codex", ["--agent=codex"], "codex"],
    ["the same app twice", ["--agent", "cursor", "--agent=cursor"], "cursor"],
    ["no --agent", [], undefined],
    ["a lone --agent", ["--agent"], undefined],
    ["--agent followed by a flag", ["--agent", "--json"], undefined],
    ["an unknown app", ["--agent", "windsurf"], undefined],
    ["a capitalized app", ["--agent", "Claude"], undefined],
    ["an empty value", ["--agent="], undefined],
    ["two different apps", ["--agent", "claude", "--agent", "cursor"], undefined],
    ["an unknown app after a valid one", ["--agent", "claude", "--agent=x"], undefined],
  ])("--agent: %s", (_label, argv, expected) => {
    expect(parseScanFlags(argv).agent).toBe(expected);
  });

  it("--agent never swallows the flag after it, nor leaves its value as an unknown argument", () => {
    expect(parseScanFlags(["--agent", "--json"])).toMatchObject({ json: true, unknown: undefined });
    expect(parseScanFlags(["--agent", "windsurf", "--no-open"])).toMatchObject({
      noOpen: true,
      unknown: undefined,
    });
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
    expect(await runScan(["--agent", "claude", "--review"], io, DEPS)).toBe(0);

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
    await runScan(["--agent", "claude", "--review"], io, DEPS);

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
    expect(await runScan(["--agent", "claude", "--review"], io, DEPS)).toBe(0);
    expect([...recorded.written.keys()]).toEqual([]);
    expect(recorded.stdout.join("")).toContain("Nothing was written.");
  });

  it.each([["y"], ["Y"], ["yes"], ["YES"], [" yes "]])("accepts %o", async (answer) => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT), { readLine: answers(answer) });
    expect(await runScan(["--agent", "claude", "--review"], io, DEPS)).toBe(0);
    expect([...recorded.written.keys()]).toHaveLength(1);
  });

  it("end of input is not a no — it says so and exits 1", async () => {
    // An unattended run that exited 0 having written nothing would be the same silent
    // failure this is about, pointed the other way.
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT), { readLine: answers() });
    expect(await runScan(["--agent", "claude", "--review"], io, DEPS)).toBe(1);
    expect([...recorded.written.keys()]).toEqual([]);
    expect(recorded.stdout.join("")).toContain("needs an answer on stdin");
  });

  it("is refused with --json, which writes no file at all", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT), { readLine: answers("y") });
    expect(await runScan(["--agent", "claude", "--review", "--json"], io, DEPS)).toBe(1);
    expect(recorded.stdout.join("")).toContain("cannot be combined");
    expect(recorded.stdout.join("")).not.toContain("<!doctype");
    expect([...recorded.written.keys()]).toEqual([]);
  });

  it("says so when there is nothing to review", async () => {
    const { io, recorded } = fakeIO({ dirs: {}, files: {} }, { readLine: answers("y") });
    expect(await runScan(["--agent", "claude", "--review"], io, DEPS)).toBe(0);
    expect(recorded.stdout.join("")).toContain("no commands and no guardrail names");
  });

  it("the default run asks nothing and writes — --review is opt-in", async () => {
    // The negative control for the whole block: if the prompt fired unconditionally,
    // every assertion above would pass for the wrong reason.
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT), { readLine: answers() });
    expect(await runScan(["--agent", "claude"], io, DEPS)).toBe(0);
    expect(recorded.stdout.join("")).not.toContain("Review —");
    expect([...recorded.written.keys()]).toHaveLength(1);
  });
});

describe("--review discloses MCP payload values the file redacts", () => {
  // The report shows an MCP payload as `<value>`; `--review`, which runs locally, shows
  // the operator the actual values so they can judge them before the file is written.
  const MCP_RULE = {
    id: "t.mcp-review",
    category: "prod-infra",
    severity: "high",
    defaultAction: "warn" as const,
    title: "An MCP create call",
    description: "Matches the planted MCP call.",
    match: {
      any_of: [{ kind: "execute_tool", label: "mcp__tracker__create", detail_contains: ["team"] }],
    },
  };
  const MCP_DEPS = { catalog: [...TEST_CATALOG, MCP_RULE], now: DEPS.now };
  const MCP_TRANSCRIPT = [
    userLine("file the issue"),
    assistantLine([toolUse("mcp__tracker__create", { team: "secret-team-value" }, "m1")]),
  ];

  it("shows the raw value in the review, and writes only the redacted form to the file", async () => {
    const { io, recorded } = fakeIO(diskWith(MCP_TRANSCRIPT), { readLine: answers("y") });
    expect(await runScan(["--agent", "claude", "--review"], io, MCP_DEPS)).toBe(0);

    const out = recorded.stdout.join("");
    // The operator sees the value for inspection…
    expect(out).toContain("MCP payload values");
    expect(out).toContain("secret-team-value");

    // …but the file that gets written never holds it — only `<value>`.
    const html = recorded.written.get(join("/work", REPORT_FILENAME)) ?? "";
    expect(html).not.toContain("secret-team-value");
    expect(html).toContain("&lt;value&gt;");
  });

  it("discloses nothing when there is no MCP call to disclose", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT), { readLine: answers("y") });
    await runScan(["--agent", "claude", "--review"], io, DEPS);
    expect(recorded.stdout.join("")).not.toContain("MCP payload values");
  });

  it("--agent cursor discloses a Cursor MCP call's raw value, and the file redacts it", async () => {
    // A Cursor `CallMcpTool` is mapped to `mcp__tracker__create` — the same shape the
    // Claude case above produces. The disclosure derives calls through the Cursor path
    // (as `aggregateScan` does), so a Cursor operator sees the raw value locally too;
    // if it re-derived through the Claude mapper, `CallMcpTool` would never become an
    // `mcp__*` tool and nothing would be disclosed.
    const session = [
      ...CURSOR_SESSION,
      cursorLine("CallMcpTool", {
        server: "tracker",
        toolName: "create",
        arguments: { team: "secret-team-value" },
      }),
    ];
    const { io, recorded } = fakeIO(cursorDisk(undefined, session), { readLine: answers("y") });
    expect(await runScan(["--agent", "cursor", "--review"], io, MCP_DEPS)).toBe(0);

    const out = recorded.stdout.join("");
    // The operator sees the value for inspection, under the Cursor MCP tool name…
    expect(out).toContain("MCP payload values");
    expect(out).toContain("mcp__tracker__create");
    expect(out).toContain("secret-team-value");

    // …but the file that gets written never holds it — only `<value>`.
    const html = recorded.written.get(join("/work", REPORT_FILENAME)) ?? "";
    expect(html).not.toContain("secret-team-value");
    expect(html).toContain("&lt;value&gt;");
  });
});

describe("the default run", () => {
  it("reads the transcripts, writes the report and prints a summary", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT));
    expect(await runScan(["--agent", "claude"], io, DEPS)).toBe(0);

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
    await runScan(["--agent", "claude"], io, DEPS);
    const summary = recorded.stdout.join("");
    expect(summary).toContain("Top repeats");
    expect(summary).toContain("rm -rf <path>");
    expect(summary).toContain("2x");
  });

  it("emits no ANSI escape when stdout is not a terminal", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT));
    await runScan(["--agent", "claude"], io, DEPS);
    expect(recorded.stdout.join("")).not.toMatch(new RegExp(String.fromCharCode(0x1b)));
  });

  it("does colour when stdout IS a terminal — the control for the test above", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT), { isTTY: () => true });
    await runScan(["--agent", "claude"], io, DEPS);
    expect(recorded.stdout.join("")).toMatch(new RegExp(String.fromCharCode(0x1b)));
  });

  it("--dir points the walk somewhere else entirely", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT, "/elsewhere"));
    // The default root has nothing on this disk, so a walk that ignored `--dir` would
    // report zero sessions rather than one.
    expect(await runScan(["--agent", "claude", "--dir", "/elsewhere"], io, DEPS)).toBe(0);
    expect(recorded.stdout.join("")).toContain("1 session");
  });

  it.each([
    "claude",
    "cursor",
  ])("--agent %s opens the written report by default, exactly once", async (agent) => {
    const disk = agent === "cursor" ? cursorDisk() : diskWith(TRANSCRIPT);
    const { io, recorded } = fakeIO(disk);
    expect(await runScan(["--agent", agent], io, DEPS)).toBe(0);
    expect(recorded.opened).toEqual([join("/work", REPORT_FILENAME)]);
    expect(recorded.stdout.join("")).toContain("Opening it in your browser.");
  });

  it("opens with no terminal attached, because Cursor's agent runs commands without one", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT), { isTTY: () => false });
    await runScan(["--agent", "claude"], io, DEPS);
    expect(recorded.opened).toHaveLength(1);
  });

  it("--no-open leaves it closed", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT));
    expect(await runScan(["--agent", "claude", "--no-open"], io, DEPS)).toBe(0);
    expect(recorded.opened).toEqual([]);
    expect([...recorded.written.keys()]).toHaveLength(1);
    expect(recorded.stdout.join("")).not.toContain("Opening it");
  });

  it("CI leaves it closed — nobody is there to look", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT), { env: { CI: "true" } });
    await runScan(["--agent", "claude"], io, DEPS);
    expect(recorded.opened).toEqual([]);
  });

  it("--json opens nothing, because it writes nothing", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT));
    await runScan(["--agent", "claude", "--json"], io, DEPS);
    expect(recorded.opened).toEqual([]);
  });
});

describe("shouldOpen", () => {
  it.each([
    [{ noOpen: false, artifact: false }, {}, true],
    [{ noOpen: false, artifact: false }, { CI: "" }, true],
    [{ noOpen: true, artifact: false }, {}, false],
    [{ noOpen: false, artifact: true }, {}, false],
    [{ noOpen: false, artifact: false }, { CI: "1" }, false],
    [{ noOpen: true, artifact: true }, { CI: "1" }, false],
  ])("%o with env %o → %s", (flags, env, expected) => {
    expect(shouldOpen(flags, env)).toBe(expected);
  });
});

describe("--out and --artifact", () => {
  it("--out writes to that file, resolved against the working directory", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT));
    expect(await runScan(["--agent", "claude", "--out", "reports/x.html"], io, DEPS)).toBe(0);
    expect([...recorded.written.keys()]).toEqual([resolve("/work", "reports/x.html")]);
    expect(recorded.opened).toEqual([resolve("/work", "reports/x.html")]);
    expect(recorded.stdout.join("")).toContain(
      `Full report: ${resolve("/work", "reports/x.html")}`,
    );
  });

  it("--out takes an absolute path as it is", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT));
    await runScan(["--agent", "claude", "--out=/tmp/scratch/r.html", "--no-open"], io, DEPS);
    expect([...recorded.written.keys()]).toEqual([resolve("/tmp/scratch/r.html")]);
  });

  it("--out given a directory writes the default name inside it", async () => {
    const disk = diskWith(TRANSCRIPT);
    const outDir = resolve("/tmp/reports");
    const { io, recorded } = fakeIO({ ...disk, dirs: { ...disk.dirs, [outDir]: [] } });
    await runScan(["--agent", "claude", "--out", outDir, "--no-open"], io, DEPS);
    expect([...recorded.written.keys()]).toEqual([join(outDir, REPORT_FILENAME)]);
  });

  it("--artifact writes page content under its own name, and does not open it", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT));
    expect(await runScan(["--agent", "claude", "--artifact"], io, DEPS)).toBe(0);
    const path = join("/work", ARTIFACT_FILENAME);
    expect([...recorded.written.keys()]).toEqual([path]);
    const page = recorded.written.get(path) ?? "";
    expect(page.startsWith("<title>")).toBe(true);
    expect(page).not.toContain("<!doctype");
    expect(page).toContain("published to claude.ai by the person who ran it");
    expect(recorded.opened).toEqual([]);
  });

  it("--artifact --out --review writes exactly the reviewed file on a yes", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT), { readLine: answers("y") });
    const argv = ["--agent", "claude", "--review", "--artifact", "--out", "/tmp/a.html"];
    expect(await runScan(argv, io, DEPS)).toBe(0);
    expect(recorded.stdout.join("")).toContain(`Write ${resolve("/tmp/a.html")}?`);
    expect([...recorded.written.keys()]).toEqual([resolve("/tmp/a.html")]);
    expect(recorded.written.get(resolve("/tmp/a.html"))?.startsWith("<title>")).toBe(true);
  });

  it.each([
    ["--out", ["--json", "--out", "/tmp/x.html"]],
    ["--artifact", ["--json", "--artifact"]],
  ])("--json refuses %s, which names a file it will not write", async (_l, flags) => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT));
    expect(await runScan(["--agent", "claude", ...flags], io, DEPS)).toBe(1);
    expect(recorded.stdout.join("")).toContain("cannot be combined with --out or --artifact");
    expect(recorded.written.size).toBe(0);
  });
});

describe("the terminal summary", () => {
  const ESC = String.fromCharCode(0x1b);
  const summaryOf = (
    result: ScanResult,
    colors = false,
    path: string | undefined = "/work/r.html",
  ) => renderSummary(result, colors, path);
  const finding = (ruleId: string, severity: string, action: GuardAction, count: number) => ({
    ruleId,
    title: `Title of ${ruleId}`,
    severity,
    action,
    count,
    examples: [],
  });
  const RESULT: ScanResult = {
    agent: "claude",
    sessions: 3,
    quarantined: 0,
    notRead: 0,
    skippedLines: 0,
    projects: 1,
    toolCalls: 40,
    riskyActions: 20,
    findings: [
      finding("t.low", "low", "warn", 30),
      finding("t.crit", "critical", "block", 2),
      finding("t.high-a", "high", "require_approval", 9),
      finding("t.med", "medium", "warn", 4),
      finding("t.high-b", "high", "block", 11),
      finding("t.info", "info", "warn", 1),
      finding("t.odd", "zany", "warn", 50),
    ],
    recurring: [],
    tokens: null,
  };

  it("totals the matches by severity and by action", () => {
    const out = summaryOf(RESULT);
    expect(out).toContain("Matches  2 critical · 20 high · 4 medium · 30 low · 1 info · 50 zany");
    expect(out).toContain("13 would block · 9 would ask · 85 would warn");
  });

  it("lists the five most serious findings, then says how many more", () => {
    const out = summaryOf(RESULT);
    const block = out.slice(out.indexOf("Top findings"));
    const order = ["t.crit", "t.high-b", "t.high-a", "t.med", "t.low"].map((id) =>
      block.indexOf(id),
    );
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(block).not.toContain("t.info");
    expect(block).toContain("and 2 more in the report");
    expect(block).toMatch(/critical\s+would block\s+2x\s+Title of t\.crit/);
  });

  it("says nothing about findings when nothing matched", () => {
    const out = summaryOf({ ...RESULT, findings: [] });
    expect(out).not.toContain("Top findings");
    expect(out).not.toContain("Matches ");
  });

  it("strips control characters from a title before printing it", () => {
    const hostile = {
      ...finding("t.x", "high", "block", 1),
      title: `A${ESC}[2J title\nwith\u0007bell`,
    };
    const out = summaryOf({ ...RESULT, findings: [hostile] });
    expect(out).not.toContain(ESC);
    expect(out).toContain("A [2J title with bell");
  });

  it("links the report path on a terminal, and prints it plain otherwise", () => {
    expect(summaryOf(RESULT, true, "/work/a b.html")).toContain(
      `${ESC}]8;;file:///work/a%20b.html${ESC}\\/work/a b.html${ESC}]8;;${ESC}\\`,
    );
    const plain = summaryOf(RESULT, false, "/work/a b.html");
    expect(plain).toContain("Full report: /work/a b.html");
    expect(plain).not.toContain(ESC);
  });
});

describe("--json", () => {
  it("prints parseable JSON and writes no file", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT));
    expect(await runScan(["--agent", "claude", "--json"], io, DEPS)).toBe(0);
    expect(recorded.written.size).toBe(0);

    const payload = JSON.parse(recorded.stdout.join(""));
    expect(payload.tool).toBe("agenttrail-guard");
    expect(payload.result.sessions).toBe(1);
    expect(payload.result.riskyActions).toBe(3);
  });

  it("prints the JSON and nothing else, so a pipe stays parseable", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT));
    await runScan(["--agent", "claude", "--json"], io, DEPS);
    expect(recorded.stdout.join("")).not.toContain("Top repeats");
  });

  it("carries no secret, no path and no project name", async () => {
    const withSecret = [
      ...TRANSCRIPT,
      assistantLine([bash("rm -rf /tmp/x && export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE", "t5")]),
    ];
    const { io, recorded } = fakeIO(diskWith(withSecret));
    await runScan(["--agent", "claude", "--json"], io, DEPS);
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
    expect(await runScan(["--agent", "claude"], io, DEPS)).toBe(0);
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
    expect(await runScan(["--agent", "claude"], io, DEPS)).toBe(0);
    const summary = recorded.stdout.join("");
    expect(summary).toContain("1 session");
    expect(summary).toContain("1 file yielded no session and was skipped");
  });

  it("reads sub-agent transcripts and folds them into the session that started them", async () => {
    // Sub-agent transcripts sit at `<project>/<session>/subagents/*.jsonl`. Their tool
    // calls ran inside a session that WAS read, so the reader folds them in rather than
    // leaving them unread — the plain TRANSCRIPT scan finds 3 risky actions, and the
    // sub-agent's rm -rf makes 4.
    const root = "/home/test/.claude/projects";
    const project = `${root}/-p`;
    const nested = `${project}/session-1/subagents`;
    const SUBAGENT = [
      userLine("do the cleanup"),
      assistantLine([bash("rm -rf /tmp/sub-agent-scratch", "s1")]),
    ];
    const { io, recorded } = fakeIO({
      dirs: {
        [root]: ["-p"],
        [project]: ["session-1.jsonl", "session-1"],
        [`${project}/session-1`]: ["subagents"],
        [nested]: ["agent-a.jsonl", "notes.md"],
      },
      files: {
        [`${project}/session-1.jsonl`]: TRANSCRIPT.join("\n"),
        [`${nested}/agent-a.jsonl`]: SUBAGENT.join("\n"),
        [`${nested}/notes.md`]: "not a transcript",
      },
    });
    expect(await runScan(["--agent", "claude", "--json"], io, DEPS)).toBe(0);
    const payload = JSON.parse(recorded.stdout.join(""));
    expect(payload.result.sessions).toBe(1);
    // The sub-agent's `.jsonl` was read (folded in), so nothing is unread; `notes.md` is
    // not a transcript and is not counted.
    expect(payload.result.notRead).toBe(0);
    // Its rm -rf is counted alongside the session's two.
    expect(payload.result.riskyActions).toBe(4);
    const rmRf = payload.result.findings.find((f: { ruleId: string }) => f.ruleId === "t.rm-rf");
    expect(rmRf.count).toBe(3);
  });

  it("de-duplicates a call that a sub-agent transcript repeats from the main one", async () => {
    // If a sub-agent file carries the same turns as the main transcript, one call must
    // still count once — tool_use_id and message uuid fold the repeat away.
    const root = "/home/test/.claude/projects";
    const project = `${root}/-p`;
    const nested = `${project}/session-1/subagents`;
    const { io, recorded } = fakeIO({
      dirs: {
        [root]: ["-p"],
        [project]: ["session-1.jsonl", "session-1"],
        [`${project}/session-1`]: ["subagents"],
        [nested]: ["agent-a.jsonl"],
      },
      files: {
        [`${project}/session-1.jsonl`]: TRANSCRIPT.join("\n"),
        [`${nested}/agent-a.jsonl`]: TRANSCRIPT.join("\n"),
      },
    });
    expect(await runScan(["--agent", "claude", "--json"], io, DEPS)).toBe(0);
    const payload = JSON.parse(recorded.stdout.join(""));
    expect(payload.result.notRead).toBe(0);
    // The identical sub-agent file adds nothing: the count matches a plain single scan.
    expect(payload.result.riskyActions).toBe(3);
  });

  it("reports nothing about coverage when the whole root was read", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT));
    await runScan(["--agent", "claude", "--json"], io, DEPS);
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
    await runScan(["--agent", "claude"], io, DEPS);
    expect(recorded.stdout.join("")).toContain("1 further transcript file was not read");
  });

  it("a report that cannot be written still prints the summary, names it, and exits 1", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT), { writeFile: () => false });
    expect(await runScan(["--agent", "claude"], io, DEPS)).toBe(1);
    const summary = recorded.stdout.join("");
    // The summary is the immediate payoff and must not depend on a writable directory.
    expect(summary).toContain("risky action");
    expect(summary).toContain("Could not write the report");
    // …and it must not claim a path that does not exist.
    expect(summary).not.toContain(`Full report: ${join("/work", REPORT_FILENAME)}`);
  });

  it("a failing opener leaves the exit code at 0 and says so", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT), { openInBrowser: () => false });
    expect(await runScan(["--agent", "claude"], io, DEPS)).toBe(0);
    expect(recorded.stdout.join("")).toContain("Could not open the report");
  });

  it("an unknown argument prints usage and exits 1", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT));
    expect(await runScan(["--agent", "claude", "--nope"], io, DEPS)).toBe(1);
    expect(recorded.stdout.join("")).toContain("unknown argument");
    expect(recorded.written.size).toBe(0);
  });

  it("--help prints usage and exits 0 without scanning", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT));
    expect(await runScan(["--agent", "claude", "--help"], io, DEPS)).toBe(0);
    expect(recorded.written.size).toBe(0);
    expect(recorded.stdout.join("")).toContain("--dir <root>");
  });

  it("--help needs no --agent, and names the flag", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT));
    expect(await runScan(["--help"], io, DEPS)).toBe(0);
    expect(recorded.written.size).toBe(0);
    expect(recorded.stdout.join("")).toContain("scan --agent <claude|cursor|codex>");
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
    await runScan(["--agent", "claude", "--json"], io, DEPS);
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
    await runScan(["--agent", "claude", "--json"], io, DEPS);
    const payload = JSON.parse(recorded.stdout.join(""));
    expect(payload.result.findings.map((f: { ruleId: string }) => f.ruleId)).toEqual([
      "t.env-file",
    ]);
  });

  it("a corrupt config file falls back to defaults rather than failing", async () => {
    const { io, recorded } = fakeIO(diskWith(TRANSCRIPT), {
      readFile: (path) => (path.endsWith("config.json") ? "{not json" : undefined),
    });
    expect(await runScan(["--agent", "claude"], io, DEPS)).toBe(0);
    expect(recorded.stdout.join("")).toContain("3 risky actions");
  });
});

// ── --agent ─────────────────────────────────────────────────────────────────

/** One Cursor session-file line: an assistant record holding one tool call. */
function cursorLine(name: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    role: "assistant",
    message: { content: [{ type: "tool_use", name, input }] },
  });
}

/** A Cursor session: a delete, a `.env` read, a to-do list and a tool this reader does not know. */
const CURSOR_SESSION = [
  JSON.stringify({
    role: "user",
    message: { content: [{ type: "text", text: "please clean up" }] },
  }),
  cursorLine("Shell", { command: "rm -rf /Users/priya/clients/acme/build", description: "clean" }),
  cursorLine("Read", { path: "/Users/priya/clients/acme/.env" }),
  cursorLine("TodoWrite", { merge: false, todos: [] }),
  cursorLine("FutureTool", { anything: true }),
  JSON.stringify({ type: "turn_ended", status: "success" }),
];

/** The sub-agent that session started: one more delete. */
const CURSOR_SUBAGENT = [
  cursorLine("Shell", { command: "rm -rf /Users/priya/clients/beta/dist", description: "clean" }),
];

/** A Cursor projects root holding that session and its sub-agent. */
function cursorDisk(root = "/home/test/.cursor/projects", session = CURSOR_SESSION): FakeDisk {
  const project = `${root}/Users-priya-clients-acme`;
  const folder = `${project}/agent-transcripts`;
  const id = "00000000-0000-4000-8000-000000000051";
  return {
    dirs: {
      [root]: ["Users-priya-clients-acme"],
      [project]: ["agent-transcripts", "terminals"],
      [`${project}/terminals`]: [],
      [folder]: [id],
      [`${folder}/${id}`]: [`${id}.jsonl`, "subagents"],
      [`${folder}/${id}/subagents`]: ["sub-1.jsonl"],
    },
    files: {
      [`${folder}/${id}/${id}.jsonl`]: session.join("\n"),
      [`${folder}/${id}/subagents/sub-1.jsonl`]: CURSOR_SUBAGENT.join("\n"),
    },
  };
}

/**
 * One Codex shim fragment: the JavaScript Codex records in place of the command itself.
 */
function codexExec(command: string, cwd = "/home/user/project"): string {
  return (
    `const r = await tools.exec_command({cmd:${JSON.stringify(command)},` +
    `workdir:${JSON.stringify(cwd)},yield_time_ms:10000,max_output_tokens:1000});` +
    " text(r.output);\n"
  );
}

/** One Codex session-file line. */
function codexLine(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: "2026-09-21T09:44:38.000Z", ordinal: 0, type, payload });
}

/** A Codex session: a delete, a patch, and a shim function this reader does not know. */
const CODEX_SESSION = [
  codexLine("session_meta", {
    session_id: "00000000-0000-4000-8000-000000000061",
    cwd: "/home/user/project",
    cli_version: "0.154.0",
  }),
  codexLine("response_item", { type: "message", role: "user", content: [] }),
  codexLine("response_item", {
    type: "custom_tool_call",
    name: "exec",
    call_id: "call_1",
    input: codexExec("rm -rf /Users/priya/clients/acme/build"),
  }),
  codexLine("token_usage_record", {
    usage: {
      input_tokens: 1200,
      cached_input_tokens: 900,
      cache_write_input_tokens: 0,
      output_tokens: 50,
    },
  }),
  codexLine("response_item", {
    type: "custom_tool_call",
    name: "exec",
    call_id: "call_2",
    input:
      'await tools.apply_patch("*** Begin Patch\\n*** Add File: /home/user/a.txt\\n+hi\\n*** End Patch");',
  }),
  codexLine("response_item", {
    type: "custom_tool_call",
    name: "exec",
    call_id: "call_3",
    input: "const r = await tools.unknown_tool({});",
  }),
];

/** A Codex sessions root holding that session, filed by date as Codex files it. */
function codexDisk(root = "/home/test/.codex/sessions", session = CODEX_SESSION): FakeDisk {
  const day = `${root}/2026/09/21`;
  const name = "rollout-2026-09-21T09-44-38-00000000-0000-4000-8000-000000000061.jsonl";
  return {
    dirs: {
      [root]: ["2026"],
      [`${root}/2026`]: ["09"],
      [`${root}/2026/09`]: ["21"],
      [day]: [name],
    },
    files: { [`${day}/${name}`]: session.join("\n") },
  };
}

/** One disk holding every directory and file of each. */
function mergeDisks(...disks: readonly FakeDisk[]): FakeDisk {
  return {
    dirs: Object.assign({}, ...disks.map((d) => d.dirs)),
    files: Object.assign({}, ...disks.map((d) => d.files)),
  };
}

/**
 * All three apps' histories on one disk.
 *
 * Every `--agent` case below runs against it, so "reads the right one" is a real
 * assertion: a reader pointed at another app's root would find that app's sessions
 * sitting there and report them.
 */
const ALL_THREE = mergeDisks(diskWith(TRANSCRIPT), cursorDisk(), codexDisk());

describe("--agent is required, and names whose sessions are read", () => {
  it.each([
    ["no --agent", []],
    ["a lone --agent", ["--agent"]],
    ["--agent followed by another flag", ["--agent", "--json"]],
    ["an unknown app", ["--agent", "windsurf"]],
    ["an unknown app after an equals sign", ["--agent=windsurf"]],
    ["an empty value", ["--agent="]],
    ["a capitalized app", ["--agent", "Claude"]],
    ["two different apps", ["--agent", "claude", "--agent", "cursor"]],
    ["other flags but no --agent", ["--dir", "/elsewhere", "--json"]],
    ["--review with no --agent", ["--review"]],
  ])("refuses %s before reading anything, and exits 1", async (_label, argv) => {
    const touched: string[] = [];
    const { io, recorded } = fakeIO(mergeDisks(diskWith(TRANSCRIPT), cursorDisk()), {
      readdir: (path) => {
        touched.push(`readdir ${path}`);
        return [];
      },
      stat: (path) => {
        touched.push(`stat ${path}`);
        throw new Error(`ENOENT: ${path}`);
      },
      readLines: async function* (path) {
        touched.push(`readLines ${path}`);
        yield* [];
      },
      readFile: (path) => {
        touched.push(`readFile ${path}`);
        return undefined;
      },
      readLine: () => {
        touched.push("readLine");
        return Promise.resolve("y");
      },
    });
    expect(await runScan(argv, io, DEPS)).toBe(1);
    expect(recorded.stdout.join("")).toBe(agentChoiceMessage("scan"));
    expect(touched).toEqual([]);
    expect(recorded.written.size).toBe(0);
    expect(recorded.opened).toEqual([]);
  });

  it("--agent claude reads Claude Code's transcripts and nobody else's", async () => {
    const { io, recorded } = fakeIO(ALL_THREE);
    expect(await runScan(["--agent", "claude", "--json"], io, DEPS)).toBe(0);
    const { result } = JSON.parse(recorded.stdout.join(""));
    expect(result.agent).toBe("claude");
    expect(result.sessions).toBe(1);
    expect(result.toolCalls).toBe(4);
    expect(result.tokens.cacheRead).toBe(5000);
    expect(result).not.toHaveProperty("skipped");
  });

  it("--agent codex reads Codex CLI's session files and nobody else's", async () => {
    const { io, recorded } = fakeIO(ALL_THREE);
    expect(await runScan(["--agent", "codex", "--json"], io, DEPS)).toBe(0);
    const { result } = JSON.parse(recorded.stdout.join(""));
    expect(result.agent).toBe("codex");
    expect(result.sessions).toBe(1);
    // One working directory, so one project — Codex files its sessions by date.
    expect(result.projects).toBe(1);
    // The delete and the patch; the shim function this reader does not know is neither.
    expect(result.toolCalls).toBe(2);
    expect(result.riskyActions).toBe(1);
    // Codex's session files record token counts, so the total is real, not withheld.
    expect(result.tokens).toMatchObject({ input: 300, output: 50, cacheRead: 900 });
    expect(result.skipped).toEqual({
      unparseableLines: 0,
      truncatedLastLines: 0,
      unknownRecords: 0,
      turnsEndedWithError: 0,
      unreadableFiles: 0,
      notActions: 0,
      unmappedTools: [{ name: "unknown_tool", count: 1 }],
    });
  });

  it("--agent cursor reads Cursor's session files and nobody else's", async () => {
    const { io, recorded } = fakeIO(ALL_THREE);
    expect(await runScan(["--agent", "cursor", "--json"], io, DEPS)).toBe(0);
    const { result } = JSON.parse(recorded.stdout.join(""));
    expect(result.agent).toBe("cursor");
    expect(result.sessions).toBe(1);
    expect(result.projects).toBe(1);
    // Two deletes (one by the sub-agent) and the `.env` read; the to-do list is not an action.
    expect(result.toolCalls).toBe(3);
    expect(result.riskyActions).toBe(3);
    expect(result.tokens).toBeNull();
    expect(result.skipped).toEqual({
      unparseableLines: 0,
      truncatedLastLines: 0,
      unknownRecords: 0,
      turnsEndedWithError: 0,
      unreadableFiles: 0,
      notActions: 1,
      unmappedTools: [{ name: "FutureTool", count: 1 }],
    });
  });

  it("--agent=cursor is the same flag", async () => {
    const { io, recorded } = fakeIO(cursorDisk());
    expect(await runScan(["--agent=cursor", "--json"], io, DEPS)).toBe(0);
    expect(JSON.parse(recorded.stdout.join("")).result.sessions).toBe(1);
  });

  it("--agent cursor --dir reads that root instead of ~/.cursor/projects", async () => {
    const { io, recorded } = fakeIO(cursorDisk("/elsewhere"));
    expect(await runScan(["--agent", "cursor", "--dir", "/elsewhere", "--json"], io, DEPS)).toBe(0);
    expect(JSON.parse(recorded.stdout.join("")).result.sessions).toBe(1);

    // The control: the same disk without `--dir` holds no Cursor session at the default root.
    const other = fakeIO(cursorDisk("/elsewhere"));
    expect(await runScan(["--agent", "cursor"], other.io, DEPS)).toBe(0);
    expect(other.recorded.stdout.join("")).toContain("No sessions found");
  });

  it("--agent cursor --json carries no secret, no path and no project name", async () => {
    const session = [
      ...CURSOR_SESSION,
      cursorLine("Shell", {
        command: "rm -rf /tmp/x && export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
      }),
    ];
    const { io, recorded } = fakeIO(cursorDisk(undefined, session));
    expect(await runScan(["--agent", "cursor", "--json"], io, DEPS)).toBe(0);
    const out = recorded.stdout.join("");
    for (const leak of ["AKIAIOSFODNN7EXAMPLE", "priya", "acme", "/Users/"]) {
      expect(out).not.toContain(leak);
    }
    expect(out).toContain("[REDACTED:");
  });

  it("--agent cursor writes a report that names Cursor, and a summary without tokens", async () => {
    const { io, recorded } = fakeIO(cursorDisk());
    expect(await runScan(["--agent", "cursor"], io, DEPS)).toBe(0);

    const html = recorded.written.get(join("/work", REPORT_FILENAME)) ?? "";
    expect(html).toContain("Agent: Cursor");
    expect(html).toContain("agenttrail-guard scan --agent cursor --review");
    expect(html).not.toContain("<h2>Tokens</h2>");
    expect(html).toContain("What was not evaluated");

    const summary = recorded.stdout.join("");
    expect(summary).toContain("Cursor · 1 session · 3 risky actions");
    expect(summary).not.toContain("tokens (");
    expect(summary).toContain(
      "Not evaluated: 1 tool call of a kind this reader does not recognize.",
    );
  });

  it("--agent cursor --review shows the tool names too, then writes on a yes", async () => {
    const { io, recorded } = fakeIO(cursorDisk(), { readLine: answers("y") });
    expect(await runScan(["--agent", "cursor", "--review"], io, DEPS)).toBe(0);

    const out = recorded.stdout.join("");
    const review = out.slice(0, out.indexOf("Write "));
    expect(review).toContain("Command shapes in the report");
    expect(review).toContain("Tool names in the report");
    expect(review).toContain("  FutureTool");
    const html = recorded.written.get(join("/work", REPORT_FILENAME)) ?? "";
    expect(html).toContain("<code>FutureTool</code>");
  });

  it("--agent cursor --review --json is refused, as it is for Claude Code", async () => {
    const { io, recorded } = fakeIO(cursorDisk(), { readLine: answers("y") });
    expect(await runScan(["--agent", "cursor", "--review", "--json"], io, DEPS)).toBe(1);
    expect(recorded.stdout.join("")).toContain("cannot be combined");
    expect(recorded.written.size).toBe(0);
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
