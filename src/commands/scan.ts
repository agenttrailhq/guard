/**
 * `agenttrail-guard scan` — read the transcripts already on disk, and say what the
 * agent has been doing.
 *
 * `--agent claude` reads Claude Code's transcripts under `~/.claude/projects`, and
 * `--agent cursor` reads Cursor's session files under `~/.cursor/projects` (see
 * `core/cursor-transcript/scan.ts`). The flag is required, as it is on `init` and
 * `uninstall`, and only the exact names `claude` and `cursor` count.
 *
 * Read with no account, no credentials and no network —
 * opt-in crash reporting is the one exception anywhere in this tool, it is off by
 * default, and nothing on this path can reach it (`no-network.test.ts` proves that over
 * the import graph). Every tool call is replayed through the SAME mapper and evaluator
 * the live hook uses, and there are two outputs: a terminal summary that needs nothing
 * opened, and one self-contained `agenttrail-guard-report.html` — written to the working
 * directory or to `--out`, and opened in the browser unless `--no-open`. `--artifact`
 * writes the same report as page content only, for publishing as a Claude artifact.
 *
 * ── Arguments are parsed HERE, from raw argv ─────────────────────────────────
 * `cli.ts`'s `parseArgs` runs in non-strict mode with only three options declared, and
 * an undeclared flag there becomes a boolean that EATS ITS VALUE: `scan --dir /tmp/x`
 * comes back as `{dir: true}` with `/tmp/x` fallen into the positionals. `rules` hit
 * exactly this and took the same exception (see `cli.ts`'s docblock); `scan` is
 * dispatched before that parser for the same reason.
 *
 * ── It honours the user's config, because the report claims it would ────────
 * Disabled rules, per-rule action overrides and the allowlist are all loaded, and the
 * user's own `guardrails.json` is appended to the catalog — the same inputs `hook.ts` reads.
 * A scan run against the shipped catalog alone would report findings for rules this
 * machine has switched off, which is a claim about enforcement that is not true here.
 *
 * ── Failure directions ───────────────────────────────────────────────────────
 * A missing projects directory is a NORMAL state — someone who has not run Claude Code
 * — so it produces an empty report and exit 0, never an error. A transcript that
 * cannot be parsed is skipped and COUNTED, so one corrupt file cannot lose the other
 * 940 and cannot do it silently. A report path that cannot be written still prints the
 * summary and names the failure, because the summary is the payoff and must not depend on
 * the file; that one exits 1, since the artifact the command promised does not exist. A
 * browser that fails to open never changes the exit code: the report was written, and a
 * headless box with no opener is not a failure of the scan.
 */

import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SHIPPED_CATALOG } from "../core/catalog.js";
import { createColors, hyperlink, shouldUseColor } from "../core/color.js";
import { parseConfig } from "../core/config.js";
import { defaultCursorProjectsRoot, readCursorCorpus } from "../core/cursor-transcript/scan.js";
import { compileAllowlist } from "../core/evaluate.js";
import { configPath, userRulesPath } from "../core/paths.js";
import {
  ARTIFACT_FILENAME,
  actionLabel,
  agentName,
  bySeverityThenCount,
  MAX_EXAMPLES,
  MAX_ROWS,
  matchTally,
  REPORT_FILENAME,
  type ReportMeta,
  renderJson,
  renderReport,
  reviewStrings,
  skippedPhrases,
} from "../core/report.js";
import { compileCatalog } from "../core/rules.js";
import {
  aggregateScan,
  mcpReviewDisclosures,
  type ScanCorpus,
  type ScanResult,
} from "../core/scan-report.js";
import { formatCount, formatTokens, totalTokens } from "../core/tokens.js";
import { parseSession } from "../core/transcript/parse.js";
import { defaultProjectsRoot, scanTranscripts } from "../core/transcript/scan.js";
import type { ParsedSession } from "../core/transcript/transcript-types.js";
import type { AgentSource, GuardRule } from "../core/types.js";
import { parseUserRulesData } from "../core/user-rules-data.js";
import { VERSION } from "../core/version.js";
import type { ScanIO } from "../scan-io.js";
import { agentChoiceMessage, chosenAgent } from "./agent-choice.js";

/** How many repeats the terminal summary lists. The report carries the rest. */
const TOP_REPEATS = 5;

/** How many findings the terminal summary lists, most serious first. */
const TOP_FINDINGS = 5;

export const SCAN_USAGE = `agenttrail-guard scan — what your agent has been doing

Usage:
  agenttrail-guard scan --agent <claude|cursor> [--dir <root>] [--out <file>]
                        [--artifact] [--no-open] [--review] [--json]

  --agent <app>  Whose sessions to read, and it is required: claude reads Claude Code's
                 transcripts in ~/.claude/projects, cursor reads Cursor's session files
                 in ~/.cursor/projects
  --dir <root>   Read from this directory instead of the one --agent names
  --out <file>   Write the report to this file instead of the working directory. Given
                 a directory, the report is written inside it
  --artifact     Write the page content only, with no <html>, <head> or <body>, for
                 publishing as a Claude artifact (agenttrail-guard-artifact.html)
  --no-open      Do not open the report in your browser. It opens by default, except
                 with --artifact or when CI is set
  --json         Print the result as JSON and write no report file
  --review       Print every command and guardrail the report will contain, and ask
                 before writing it. Redaction is thorough but not a guarantee; this
                 is how you check it yourself before the file exists.

Reads transcripts already on your disk. No account, nothing uploaded, and no network
call: the one exception anywhere in this tool is crash reporting, which is off unless
you turn it on and which a scan never uses.
Commands and paths are redacted before anything is displayed or written.
`;

/** Parsed `scan` flags. */
export interface ScanFlags {
  /**
   * The app named by `--agent`, when every `--agent` names the same one of `claude` and
   * `cursor`. `undefined` for a missing flag, a lone `--agent`, any other value, or two
   * different apps.
   */
  readonly agent?: AgentSource | undefined;
  readonly dir?: string | undefined;
  readonly json: boolean;
  /** `--no-open`: leave the report closed. It opens by default; see `shouldOpen`. */
  readonly noOpen: boolean;
  /** `--artifact`: write page content only, for publishing as a Claude artifact. */
  readonly artifact: boolean;
  /** `--out <file>`: where to write the report. A directory gets the default name inside. */
  readonly out?: string | undefined;
  readonly help: boolean;
  /** Show everything the report will contain and ask before writing it. */
  readonly review: boolean;
  /** The first unrecognized argument, if any. Named back to the user. */
  readonly unknown?: string | undefined;
}

/**
 * Parse `scan`'s own arguments.
 *
 * Both `--dir <root>` and `--dir=<root>` are accepted because both are what people
 * type. An unknown flag is REPORTED rather than ignored: silently dropping `--jsn`
 * would print a human summary to something expecting JSON.
 *
 * `--agent <app>` and `--agent=<app>` are read the same way. A value that starts with `-`
 * is not taken as the app, so `--agent --json` is a lone `--agent` followed by `--json`.
 */
export function parseScanFlags(argv: readonly string[]): ScanFlags {
  let agent: AgentSource | undefined;
  let agentRefused = false;
  let dir: string | undefined;
  let json = false;
  let noOpen = false;
  let artifact = false;
  let out: string | undefined;
  let help = false;
  let review = false;
  let unknown: string | undefined;

  /** One `--agent` value. Refused unless it names the same app as any earlier one. */
  const takeAgent = (value: string | undefined): void => {
    const app = chosenAgent(value);
    if (app === undefined || (agent !== undefined && agent !== app)) agentRefused = true;
    else agent = app;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--agent") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) takeAgent(undefined);
      else {
        takeAgent(next);
        i++;
      }
    } else if (arg.startsWith("--agent=")) takeAgent(arg.slice("--agent=".length));
    else if (arg === "--json") json = true;
    else if (arg === "--no-open") noOpen = true;
    else if (arg === "--artifact") artifact = true;
    else if (arg === "--review") review = true;
    else if (arg === "--out") {
      const next = argv[i + 1];
      // Same rule as `--dir`: a flag after it is a typo, not a file named `--json`.
      if (next === undefined || next === "" || next.startsWith("-")) {
        unknown ??= "--out (missing a file)";
      } else {
        out = next;
        i++;
      }
    } else if (arg.startsWith("--out=")) {
      const value = arg.slice("--out=".length);
      if (value === "") unknown ??= "--out (missing a file)";
      else out = value;
    } else if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--dir") {
      const next = argv[i + 1];
      // A `--dir` with nothing after it, or followed by another flag, is a typo and
      // not a request to scan a directory named `--json`.
      if (next === undefined || next.startsWith("-")) unknown ??= "--dir (missing a directory)";
      else {
        dir = next;
        i++;
      }
    } else if (arg.startsWith("--dir=")) dir = arg.slice("--dir=".length);
    else unknown ??= arg;
  }

  return {
    agent: agentRefused ? undefined : agent,
    dir,
    json,
    noOpen,
    artifact,
    out,
    help,
    review,
    unknown,
  };
}

/**
 * Should the written report be opened in a browser?
 *
 * Yes by default, for both apps. NOT gated on a terminal: Cursor's agent runs commands
 * without one, and a scan it runs is exactly the case that should open. No for
 * `--no-open`; no for `--artifact`, whose page content is for publishing and has no
 * document around it; and no when `CI` is set, where nobody is there to look.
 */
export function shouldOpen(
  flags: Pick<ScanFlags, "noOpen" | "artifact">,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  if (flags.noOpen || flags.artifact) return false;
  return (env.CI ?? "") === "";
}

/**
 * Where the report is written: `--out` resolved against the working directory, with the
 * default name inside it when it is a directory; otherwise the working directory itself.
 */
function reportPathFor(out: string | undefined, filename: string, io: ScanIO): string {
  if (out === undefined) return join(io.cwd(), filename);
  const target = resolve(io.cwd(), out);
  try {
    if (io.stat(target).isDirectory()) return join(target, filename);
  } catch {
    // Nothing there yet, so `--out` names the file to create.
  }
  return target;
}

/** Overrides for tests. Production passes nothing and gets the shipped catalog. */
export interface ScanDeps {
  /** The rule catalog. `@agenttrail/guardrails` arrives through here. */
  readonly catalog?: readonly GuardRule[];
  /** Frozen clock, so a rendered report is byte-stable in a test. */
  readonly now?: Date;
}

/** Deepest directory nesting the file tally will descend. */
const MAX_WALK_DEPTH = 8;

/**
 * Count every `.jsonl` file under `root`, at any depth.
 *
 * Exists to make the reader's coverage gap VISIBLE. The reader opens each session's
 * `<project>/<session>.jsonl` AND the sub-agent transcripts beside it in
 * `<project>/<session>/subagents/*.jsonl`, so what this count exceeds `opened` by is the
 * `.jsonl` files elsewhere under the root — a stray file, or one nested somewhere the
 * reader does not walk. `core/report.ts` states it that way, so a non-zero count reads as
 * "some other files exist", not "whole sessions are missing".
 *
 * Total: unreadable directories are skipped, and the depth cap bounds a symlink loop
 * rather than trusting the filesystem not to have one. A tally that fails must never
 * take down a scan that has already succeeded.
 */
function countTranscriptFiles(io: ScanIO, dir: string, depth = 0): number {
  if (depth > MAX_WALK_DEPTH) return 0;
  let entries: string[];
  try {
    entries = io.readdir(dir);
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const path = `${dir}/${entry}`;
    try {
      if (io.stat(path).isDirectory()) total += countTranscriptFiles(io, path, depth + 1);
      else if (entry.endsWith(".jsonl")) total++;
    } catch {
      // Vanished or unreadable between the listing and the stat. Not a scan failure.
    }
  }
  return total;
}

/**
 * Read one session file and fold in its sub-agents' transcripts.
 *
 * A sub-agent's tool calls ran on this machine inside this session, written to
 * `<project>/<session>/subagents/*.jsonl`, so they are read into the same session — exactly
 * as the Cursor reader folds a session's sub-agents. `opened` counts every file this
 * actually read (the main file plus each sub-agent file), so the coverage tally is honest.
 * `session` is absent when the main file could not be folded into a session (quarantined);
 * its sub-agents are then left to the not-read count.
 */
async function readClaudeSession(
  io: ScanIO,
  item: { readonly file: string; readonly sessionId: string },
): Promise<{ session?: ParsedSession; opened: number }> {
  const source = { readLines: (p: string) => io.readLines(p) };

  let session: ParsedSession;
  try {
    session = await parseSession(item.file, item.sessionId, source);
  } catch {
    // QuarantineError or any other read failure: the main file was attempted and yielded
    // no session. Count the one file; leave its sub-agents to the not-read count.
    return { opened: 1 };
  }
  let opened = 1;

  const subDir = join(dirname(item.file), basename(item.file, ".jsonl"), "subagents");
  let names: readonly string[];
  try {
    names = io.readdir(subDir);
  } catch {
    // No sub-agents folder (the common case) is not a failure.
    names = [];
  }

  const turns = [...session.turns];
  const userPrompts = [...session.userPrompts];
  const seenTurns = new Set(turns.map((t) => t.messageUuid).filter((u) => u !== ""));
  const seenPrompts = new Set(userPrompts.map((p) => p.messageUuid).filter((u) => u !== ""));
  let skippedLines = session.skippedLines;

  for (const name of [...names].sort()) {
    if (!name.endsWith(".jsonl")) continue;
    const subPath = join(subDir, name);
    try {
      if (io.stat(subPath).isDirectory()) continue;
    } catch {
      continue; // vanished or unreadable between listing and stat
    }
    opened += 1;
    let sub: ParsedSession;
    try {
      sub = await parseSession(subPath, name, source);
    } catch {
      continue; // a sub-agent file that yields no session adds nothing; it was still opened
    }
    skippedLines += sub.skippedLines;
    // De-dup by message uuid so one turn's tokens and tool calls count once even if a main
    // transcript inlined the sub-agent, or a file is somehow read twice. A turn with no
    // uuid is always kept — there is no id to fold on.
    for (const turn of sub.turns) {
      if (turn.messageUuid !== "" && seenTurns.has(turn.messageUuid)) continue;
      if (turn.messageUuid !== "") seenTurns.add(turn.messageUuid);
      turns.push(turn);
    }
    for (const prompt of sub.userPrompts) {
      if (prompt.messageUuid !== "" && seenPrompts.has(prompt.messageUuid)) continue;
      if (prompt.messageUuid !== "") seenPrompts.add(prompt.messageUuid);
      userPrompts.push(prompt);
    }
  }

  return { session: { ...session, turns, userPrompts, skippedLines }, opened };
}

/** Read and parse every transcript under `root`, counting what could not be read. */
async function readCorpus(
  io: ScanIO,
  root: string,
): Promise<{
  sessions: ParsedSession[];
  quarantined: number;
  projects: number;
  notRead: number;
}> {
  const inventory = await scanTranscripts(root, undefined, {
    readdir: (p) => io.readdir(p),
    stat: (p) => io.stat(p),
    lineSource: { readLines: (p) => io.readLines(p) },
  });

  const sessions: ParsedSession[] = [];
  let quarantined = 0;
  // Every file the reader actually opened — main transcripts and the sub-agent files folded
  // into them — so the not-read tally below is against what was read, not just the sessions.
  let opened = 0;

  for (const project of inventory.projects) {
    for (const item of project.sessions) {
      const read = await readClaudeSession(io, item);
      opened += read.opened;
      if (read.session !== undefined) sessions.push(read.session);
      else quarantined++;
    }
  }

  // What the reader OPENED, against what is actually on disk. Never negative: a file
  // the tally missed (a race, a permission change) must not turn into a negative count
  // in a report.
  const notRead = Math.max(0, countTranscriptFiles(io, root) - opened);

  return { sessions, quarantined, projects: inventory.projects.length, notRead };
}

/**
 * C0 and C1 control characters. Built at runtime because Biome rejects them in a regex
 * literal, the same way `color.test.ts` builds its escape matcher.
 */
const CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0x00)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}]+`,
  "g",
);

/** A rule title fit for one terminal line: control characters out, whitespace collapsed. */
function terminalText(text: string): string {
  return text.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
}

/**
 * The terminal summary — the immediate payoff, requiring nothing to be opened.
 *
 * Shape: the app and headline counts, tokens with the cache split (Claude Code only), the
 * matches by severity and by action, what was not evaluated (Cursor only), the most
 * serious findings, the top repeats with what each one means, then where the report is —
 * as a clickable link when the terminal renders one.
 */
export function renderSummary(
  result: ScanResult,
  colorsEnabled: boolean,
  reportPath: string | undefined,
): string {
  const c = createColors(colorsEnabled);
  const out: string[] = [];
  const t = result.tokens;
  const severityTone = (severity: string, text: string): string => {
    switch (severity) {
      case "critical":
        return c.bold(c.red(text));
      case "high":
        return c.red(text);
      case "medium":
        return c.yellow(text);
      case "low":
        return c.cyan(text);
      default:
        return c.dim(text);
    }
  };
  const actionTone = (action: string, text: string): string =>
    action === "block" ? c.red(text) : action === "require_approval" ? c.yellow(text) : c.dim(text);

  const plural = (n: number, word: string) => `${formatCount(n)} ${word}${n === 1 ? "" : "s"}`;
  // The verb has to agree too. Caught by a test rather than by review: the first
  // version read "1 further transcript file were not read", in the one line of the
  // summary whose whole job is to be believed.
  const was = (n: number) => (n === 1 ? "was" : "were");

  out.push(
    [
      agentName(result.agent),
      c.bold(plural(result.sessions, "session")),
      c.bold(plural(result.riskyActions, "risky action")),
      c.bold(plural(result.recurring.length, "recurring mistake")),
    ].join(" · "),
  );
  if (t !== null) {
    out.push(
      c.dim(
        `${formatTokens(totalTokens(t))} tokens (${formatTokens(t.cacheRead)} cache reads, cumulative — re-charged each turn)`,
      ),
    );
  }

  if (result.findings.length > 0) {
    const { bySeverity, byAction } = matchTally(result);
    out.push(
      `Matches  ${bySeverity
        .map((s) => severityTone(s.severity, `${formatCount(s.count)} ${s.severity}`))
        .join(" · ")}`,
    );
    out.push(
      `         ${byAction
        .map((a) => actionTone(a.action, `${formatCount(a.count)} ${actionLabel(a.action)}`))
        .join(" · ")}`,
    );
  }

  const skipped = result.skipped === undefined ? [] : skippedPhrases(result.skipped);
  if (skipped.length > 0) {
    out.push(c.yellow(`Not evaluated: ${skipped.join(", ")}. The report lists them.`));
  }

  if (result.quarantined > 0) {
    out.push(
      c.yellow(
        `${plural(result.quarantined, "file")} yielded no session and ${was(result.quarantined)} skipped.`,
      ),
    );
  }
  if (result.notRead > 0) {
    out.push(
      c.dim(
        `${plural(result.notRead, "further transcript file")} ${was(result.notRead)} not read; see the report for why.`,
      ),
    );
  }

  if (result.findings.length > 0) {
    out.push("");
    out.push(c.bold("Top findings"));
    const shown = bySeverityThenCount(result.findings).slice(0, TOP_FINDINGS);
    const severityWidth = Math.max(...shown.map((f) => f.severity.length));
    const countWidth = Math.max(...shown.map((f) => `${formatCount(f.count)}x`.length));
    for (const finding of shown) {
      const severity = severityTone(finding.severity, finding.severity.padEnd(severityWidth));
      const action = actionTone(finding.action, actionLabel(finding.action).padEnd(11));
      const count = `${formatCount(finding.count)}x`.padStart(countWidth);
      out.push(
        `  ${severity}  ${action}  ${count}  ${terminalText(finding.title)}  ${c.dim(finding.ruleId)}`,
      );
    }
    if (result.findings.length > shown.length) {
      out.push(
        c.dim(`  and ${formatCount(result.findings.length - shown.length)} more in the report`),
      );
    }
  }

  if (result.recurring.length > 0) {
    out.push("");
    out.push(c.bold("Top repeats"));
    const shown = result.recurring.slice(0, TOP_REPEATS);
    // Pad to the widest shape SHOWN, not the widest overall, so one long command in
    // row nine does not indent the whole table.
    const width = Math.min(44, Math.max(...shown.map((r) => r.text.length)));
    for (const item of shown) {
      const shape = item.text.padEnd(width);
      out.push(`  ${shape}  ${c.dim(`${item.count}x`)}  ${c.dim(terminalText(item.title))}`);
    }
    if (result.recurring.length > shown.length) {
      out.push(c.dim(`  and ${result.recurring.length - shown.length} more in the report`));
    }
  } else if (result.sessions === 0) {
    out.push("");
    out.push(c.dim("No sessions found. Nothing to report yet."));
  }

  if (reportPath !== undefined) {
    out.push("");
    out.push(
      `Full report: ${hyperlink(colorsEnabled, pathToFileURL(reportPath).href, reportPath)}`,
    );
  }

  return `${out.join("\n")}\n`;
}

/**
 * The `--review` block: everything the report will contain, before it exists.
 *
 * ── Why a review step at all ────────────────────────────────────────────────
 * `core/redact-identifiers.ts` is a DENY-LIST. It covers a fixed list of tools and it
 * will miss the tool nobody thought of, and no amount of pattern work
 * changes that — a redactor cannot be proved complete. What CAN be bounded is the
 * reading: the report writes at most `MAX_ROWS` findings, `MAX_EXAMPLES` shapes under
 * each, and `MAX_ROWS` repeats, so the whole surface is tens of lines. This converts an
 * unbounded redaction problem into a bounded review problem, which is what the report
 * already promises: "redaction is thorough but not a
 * guarantee — read the findings before posting this anywhere public."
 *
 * It shows what is WRITTEN, not a summary of it. The point is to be the same strings.
 */
export function renderReview(
  result: ScanResult,
  colorsEnabled: boolean,
  reportPath: string,
  mcpDisclosures: readonly string[] = [],
): string {
  const c = createColors(colorsEnabled);
  const groups = reviewStrings(result);
  const out: string[] = [];

  out.push(c.bold("Review — everything this report will contain."));
  out.push(
    c.dim(
      "Commands are already redacted: <path>, <name>, <host>, <user>, <message>, <value>, " +
        "<comment> and [REDACTED:…]",
    ),
  );
  out.push(c.dim("stand in for what was removed. Nothing else from your machine is in the file."));

  if (groups.length === 0) {
    out.push("");
    out.push(c.dim("Nothing matched, so the report carries no commands and no guardrail names."));
  }

  for (const group of groups) {
    out.push("");
    out.push(c.bold(group.label));
    for (const line of group.lines) out.push(`  ${line}`);
  }

  // The report reduces every MCP payload value to `<value>`, so the shapes above cannot
  // show what was in one. These lines disclose the actual values — secrets scrubbed,
  // identifiers left visible — so the operator can judge them before the file is written.
  // They are NOT in the file: the file carries the `<value>` form.
  if (mcpDisclosures.length > 0) {
    out.push("");
    out.push(c.bold("MCP payload values (redacted to <value> in the file; shown here to review)"));
    for (const line of mcpDisclosures) out.push(`  ${line}`);
  }

  out.push("");
  out.push(
    c.dim(
      "That is the whole file, not a sample: the report lists at most " +
        `${MAX_ROWS} rows and ${MAX_EXAMPLES} shapes per row.`,
    ),
  );
  out.push("");
  out.push(`Write ${reportPath}? [y/N] `);
  return out.join("\n");
}

/**
 * Did the user consent?
 *
 * Deliberately strict — `y` or `yes`, case-insensitive, nothing else. A file the user
 * has just been shown and has not clearly agreed to is not written, and the default on
 * a bare Enter is no. `undefined` (end of input) is NOT handled here: it is not an
 * answer at all, and `runScan` treats it differently.
 */
function isYes(answer: string): boolean {
  const trimmed = answer.trim().toLowerCase();
  return trimmed === "y" || trimmed === "yes";
}

/** Run `scan`. Returns an exit code; never throws, never calls `process.exit`. */
export async function runScan(
  argv: readonly string[],
  io: ScanIO,
  deps: ScanDeps = {},
): Promise<number> {
  const flags = parseScanFlags(argv);
  if (flags.help) {
    io.writeStdout(SCAN_USAGE);
    return 0;
  }
  if (flags.unknown !== undefined) {
    io.writeStdout(`agenttrail-guard scan: unknown argument "${flags.unknown}".\n\n${SCAN_USAGE}`);
    return 1;
  }
  // Required, and checked before anything is read: `cli.ts` hands `scan` its raw arguments,
  // so this is the only check on them.
  const agent = flags.agent;
  if (agent === undefined) {
    io.writeStdout(agentChoiceMessage("scan"));
    return 1;
  }
  if (flags.review && flags.json) {
    // Refused rather than silently ignored, and not "reviewed anyway": `--json` writes
    // no file, and printing a review onto the same stream would make `scan --json >
    // x.json` unparseable — the exact failure the `--json` branch below exists to
    // avoid. The JSON goes to the user's own terminal or pipe, where they can read it.
    io.writeStdout(
      "agenttrail-guard scan: --review and --json cannot be combined.\n" +
        "--review confirms what is written to the report file; --json writes no file.\n",
    );
    return 1;
  }
  if (flags.json && (flags.out !== undefined || flags.artifact)) {
    // Refused for the same reason: both flags describe a file, and `--json` writes none.
    io.writeStdout(
      "agenttrail-guard scan: --json writes no file, so it cannot be combined with --out or --artifact.\n",
    );
    return 1;
  }

  const home = io.homedir();
  const root =
    flags.dir ?? (agent === "cursor" ? defaultCursorProjectsRoot(home) : defaultProjectsRoot(home));
  const now = deps.now ?? new Date();

  // The same three inputs the hook reads, so the report describes THIS machine's
  // enforcement rather than the shipped defaults.
  const config = parseConfig(io.readFile(configPath(home)));
  const userRules = parseUserRulesData(io.readFile(userRulesPath(home)));
  const catalog = compileCatalog([...(deps.catalog ?? SHIPPED_CATALOG), ...userRules], config);
  const allowlist = compileAllowlist(config.allowlist);

  const corpus: ScanCorpus =
    agent === "cursor"
      ? await readCursorCorpus(root, io)
      : { agent: "claude", ...(await readCorpus(io, root)) };
  const result = aggregateScan(corpus, catalog, allowlist);
  const meta: ReportMeta = { version: VERSION, generatedAt: now };

  if (flags.json) {
    // JSON replaces BOTH outputs: no summary, no file. `scan --json > x.json` has to
    // produce a parseable file, and a human summary on the same stream would not be.
    io.writeStdout(renderJson(result, meta));
    return 0;
  }

  const reportPath = reportPathFor(
    flags.out,
    flags.artifact ? ARTIFACT_FILENAME : REPORT_FILENAME,
    io,
  );
  const colors = createColors(shouldUseColor({ env: io.env, isTTY: io.isTTY() }));

  if (flags.review) {
    const disclosures = mcpReviewDisclosures(corpus, catalog, allowlist);
    io.writeStdout(renderReview(result, colors.enabled, reportPath, disclosures));
    const answer = await io.readLine();
    if (answer === undefined) {
      // End of input, not a decision. An unattended `scan --review` that exited 0 having
      // written nothing would be a silent failure, so it is named, and it is a non-zero exit.
      io.writeStdout(
        colors.yellow("\n\n--review needs an answer on stdin. Nothing was written.\n"),
      );
      return 1;
    }
    if (!isYes(answer)) {
      // A deliberate no. The command did exactly what it promised — show, ask, obey —
      // so this is not a failure and does not exit non-zero.
      io.writeStdout("\nNothing was written.\n");
      return 0;
    }
    io.writeStdout("\n");
  }

  const written = io.writeFile(
    reportPath,
    renderReport(result, meta, { variant: flags.artifact ? "artifact" : "document" }),
  );

  // The summary is printed whether or not the file was written — it is the payoff, and
  // it must not depend on a writable working directory.
  io.writeStdout(renderSummary(result, colors.enabled, written ? reportPath : undefined));

  if (!written) {
    io.writeStdout(colors.yellow(`\nCould not write the report to ${reportPath}\n`));
    return 1;
  }

  if (shouldOpen(flags, io.env)) {
    io.writeStdout(
      colors.dim(
        io.openInBrowser(reportPath)
          ? "Opening it in your browser.\n"
          : "Could not open the report; the path above still works.\n",
      ),
    );
  }

  return 0;
}
