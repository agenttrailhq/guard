/**
 * `agenttrail-guard scan` — read the transcripts already on disk, and say what the
 * agent has been doing.
 *
 * Read from `~/.claude/projects/**` with no account, no credentials and no network —
 * opt-in crash reporting is the one exception anywhere in this tool, it is off by
 * default, and nothing on this path can reach it (`no-network.test.ts` proves that over
 * the import graph). Every tool call is replayed through the SAME mapper and evaluator
 * the live hook uses, and there are two outputs: a terminal summary that needs nothing
 * opened, and one self-contained `agenttrail-guard-report.html`.
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
 * failed `--open` never changes the exit code: the report was written, and a headless
 * box with no opener is not a failure of the scan.
 */

import { join } from "node:path";
import { SHIPPED_CATALOG } from "../core/catalog.js";
import { createColors, shouldUseColor } from "../core/color.js";
import { parseConfig } from "../core/config.js";
import { compileAllowlist } from "../core/evaluate.js";
import { configPath, userRulesPath } from "../core/paths.js";
import {
  MAX_EXAMPLES,
  MAX_ROWS,
  REPORT_FILENAME,
  type ReportMeta,
  renderJson,
  renderReport,
  reviewStrings,
} from "../core/report.js";
import { compileCatalog } from "../core/rules.js";
import { aggregateScan, type ScanResult } from "../core/scan-report.js";
import { formatCount, formatTokens, totalTokens } from "../core/tokens.js";
import { parseSession } from "../core/transcript/parse.js";
import { defaultProjectsRoot, scanTranscripts } from "../core/transcript/scan.js";
import type { ParsedSession } from "../core/transcript/transcript-types.js";
import type { GuardRule } from "../core/types.js";
import { parseUserRulesData } from "../core/user-rules-data.js";
import { VERSION } from "../core/version.js";
import type { ScanIO } from "../scan-io.js";

/** How many repeats the terminal summary lists. The report carries the rest. */
const TOP_REPEATS = 5;

export const SCAN_USAGE = `agenttrail-guard scan — what your agent has been doing

Usage:
  agenttrail-guard scan [--dir <root>] [--json] [--open] [--review]

  --dir <root>   Read transcripts from this directory instead of ~/.claude/projects
  --json         Print the result as JSON and write no report file
  --open         Open the report when it has been written
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
  readonly dir?: string | undefined;
  readonly json: boolean;
  readonly open: boolean;
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
 */
export function parseScanFlags(argv: readonly string[]): ScanFlags {
  let dir: string | undefined;
  let json = false;
  let open = false;
  let help = false;
  let review = false;
  let unknown: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--json") json = true;
    else if (arg === "--open") open = true;
    else if (arg === "--review") review = true;
    else if (arg === "--help" || arg === "-h") help = true;
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

  return { dir, json, open, help, review, unknown };
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
 * Exists to make the reader's coverage gap VISIBLE. The reader opens
 * `<project>/<session>.jsonl`. Claude Code also writes sub-agent transcripts to
 * `<project>/<session>/subagents/*.jsonl`, and those belong to a session file that IS
 * read, so the files this count adds are normally the tool calls sub-agents made inside
 * sessions already counted, not sessions that were missed. `core/report.ts` states the
 * gap that way: "N files were not read" alone would suggest whole sessions are missing.
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

  for (const project of inventory.projects) {
    for (const item of project.sessions) {
      try {
        sessions.push(
          await parseSession(item.file, item.sessionId, { readLines: (p) => io.readLines(p) }),
        );
      } catch {
        // Two classes arrive here and are counted the same: `QuarantineError` — a file
        // with no coherent message spine — and anything else, such as a file that
        // vanished or lost its permissions mid-walk. Distinguishing them would put a
        // number in the report that nobody can act on differently, while dropping
        // either one silently is the failure this count exists to prevent.
        quarantined++;
      }
    }
  }

  // What the reader OPENED, against what is actually on disk. Never negative: a file
  // the tally missed (a race, a permission change) must not turn into a negative count
  // in a report.
  const opened = inventory.totalSessions;
  const notRead = Math.max(0, countTranscriptFiles(io, root) - opened);

  return { sessions, quarantined, projects: inventory.projects.length, notRead };
}

/**
 * The terminal summary — the immediate payoff, requiring nothing to be opened.
 *
 * Shape: headline counts, tokens with the cache split, the top repeats with what each
 * one means, then where the report is.
 */
export function renderSummary(
  result: ScanResult,
  colorsEnabled: boolean,
  reportPath: string | undefined,
): string {
  const c = createColors(colorsEnabled);
  const out: string[] = [];
  const t = result.tokens;

  const plural = (n: number, word: string) => `${formatCount(n)} ${word}${n === 1 ? "" : "s"}`;
  // The verb has to agree too. Caught by a test rather than by review: the first
  // version read "1 further transcript file were not read", in the one line of the
  // summary whose whole job is to be believed.
  const was = (n: number) => (n === 1 ? "was" : "were");

  out.push(
    [
      c.bold(plural(result.sessions, "session")),
      c.bold(plural(result.riskyActions, "risky action")),
      c.bold(plural(result.recurring.length, "recurring mistake")),
    ].join(" · "),
  );
  out.push(
    c.dim(`${formatTokens(totalTokens(t))} tokens (${formatTokens(t.cacheRead)} read from cache)`),
  );

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

  if (result.recurring.length > 0) {
    out.push("");
    out.push(c.bold("Top repeats"));
    const shown = result.recurring.slice(0, TOP_REPEATS);
    // Pad to the widest shape SHOWN, not the widest overall, so one long command in
    // row nine does not indent the whole table.
    const width = Math.min(44, Math.max(...shown.map((r) => r.text.length)));
    for (const item of shown) {
      const shape = item.text.padEnd(width);
      out.push(`  ${shape}  ${c.dim(`${item.count}x`)}  ${c.dim(item.title)}`);
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
    out.push(`Full report: ${reportPath}`);
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
): string {
  const c = createColors(colorsEnabled);
  const groups = reviewStrings(result);
  const out: string[] = [];

  out.push(c.bold("Review — everything this report will contain."));
  out.push(
    c.dim(
      "Commands are already redacted: <path>, <name>, <host>, <user>, <message> and [REDACTED:…]",
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

  const home = io.homedir();
  const root = flags.dir ?? defaultProjectsRoot(home);
  const now = deps.now ?? new Date();

  // The same three inputs the hook reads, so the report describes THIS machine's
  // enforcement rather than the shipped defaults.
  const config = parseConfig(io.readFile(configPath(home)));
  const userRules = parseUserRulesData(io.readFile(userRulesPath(home)));
  const catalog = compileCatalog([...(deps.catalog ?? SHIPPED_CATALOG), ...userRules], config);
  const allowlist = compileAllowlist(config.allowlist);

  const corpus = await readCorpus(io, root);
  const result = aggregateScan(corpus, catalog, allowlist);
  const meta: ReportMeta = { version: VERSION, generatedAt: now };

  if (flags.json) {
    // JSON replaces BOTH outputs: no summary, no file. `scan --json > x.json` has to
    // produce a parseable file, and a human summary on the same stream would not be.
    io.writeStdout(renderJson(result, meta));
    return 0;
  }

  const reportPath = join(io.cwd(), REPORT_FILENAME);
  const colors = createColors(shouldUseColor({ env: io.env, isTTY: io.isTTY() }));

  if (flags.review) {
    io.writeStdout(renderReview(result, colors.enabled, reportPath));
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

  const written = io.writeFile(reportPath, renderReport(result, meta));

  // The summary is printed whether or not the file was written — it is the payoff, and
  // it must not depend on a writable working directory.
  io.writeStdout(renderSummary(result, colors.enabled, written ? reportPath : undefined));

  if (!written) {
    io.writeStdout(colors.yellow(`\nCould not write the report to ${reportPath}\n`));
    return 1;
  }

  if (flags.open && !io.openInBrowser(reportPath)) {
    io.writeStdout(colors.dim("Could not open the report; the path above still works.\n"));
  }

  return 0;
}
