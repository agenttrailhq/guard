/**
 * The `scan` aggregator: parsed sessions + a compiled catalog → one `ScanResult`.
 *
 * Pure. No I/O, no formatting, no colour. `commands/scan.ts` holds the effects and
 * `core/report.ts` turns the result into HTML; this module is what the unit tests
 * drive, so correct counts, redaction and the absence of currency are tested over a
 * data structure rather than end to end on disk.
 *
 * ── `ScanResult` is REDACTED BY CONSTRUCTION, and that is the safety story ────
 * Redaction happens HERE, not in the renderers. Every string that reaches this
 * module's output has been through `redactForReport`, so no consumer — the HTML, the
 * `--json` payload, the terminal summary, or anything added later — can leak by
 * forgetting to scrub. The alternative (carry raw text and scrub at each render site)
 * has three sites today and would have four the first time someone adds a surface.
 * One of them forgetting is the whole failure mode, and it is silent.
 *
 * The invariant is: **nothing in `ScanResult` is derived from an unredacted string.**
 * Repeat keys included — they are the redacted text, which is also what makes the
 * counting mean anything (see `redact-path.ts`).
 *
 * ── Evaluation runs on the RAW call; only the display text is redacted ───────
 * The order is: map → evaluate → redact. Redacting first would change what the rules
 * see, so a scan would report different findings from the ones the hook produces on
 * the same command — the exact divergence `core/transcripts.ts` exists to prevent.
 *
 * ── No currency, and no field that could carry one ───────────────────────────
 * There is no price, no rate, no risk figure and no "estimated" anything on any type
 * in this file. Counts are counts and tokens come straight off the transcript. A
 * dollar figure is a count multiplied by an assumption; see `core/report.ts`.
 */

import type { SpanContext } from "../engine/evaluator.js";
import type { CompiledAllowlist } from "./evaluate.js";
import { evaluateCall } from "./evaluate.js";
import { mapToolCall, TRUNCATION_MARKER } from "./mapper.js";
import { buildGuardSpanContext } from "./normalize.js";
import { redactIdentifiers } from "./redact-identifiers.js";
import { redactPaths } from "./redact-path.js";
import type { CompiledRule } from "./rules.js";
import { scrubText } from "./scrub.js";
import { addUsage, EMPTY_TOKEN_TOTALS, type TokenTotals } from "./tokens.js";
import type { ParsedSession } from "./transcript/transcript-types.js";
import { toolCallsOf } from "./transcripts.js";
import type { GuardAction, MappedCall } from "./types.js";

/**
 * The three redactors, composed in the one order that is correct.
 *
 * `scrubText` first: it matches VALUE SHAPES, and a token replaced early would hide a
 * secret embedded in it and under-report the tally. `redactPaths` second: it matches
 * STRUCTURE, and is built so it cannot damage the placeholders the first pass just
 * inserted. `redactIdentifiers` last: it matches POSITION within a known command, so it
 * has to see a string whose paths are already `<path>` or it would read an image path as
 * an object name. Each one's header states its half of this; changing the order is a
 * correctness change, not a style one.
 *
 * Exported so tests can drive the composition directly rather than inferring it from
 * an aggregate result — and so a reviewer has one function to read instead of a
 * convention to trust.
 */
export function redactForReport(text: string): string {
  return redactIdentifiers(redactPaths(scrubText(text).text));
}

/**
 * The same composition for a guardrail TITLE, minus the path pass.
 *
 * A title is PROSE. `redactPaths` is calibrated for shell TOKENS, where a bare `/` is the
 * filesystem root and any token carrying a separator is a location — the right rule for a
 * command and the wrong one for a sentence, where `/` is the word "or". Run over the
 * shipped library's 56 titles:
 *
 *     damaged by redactPaths        6  (11%)
 *     damaged by redactIdentifiers  0
 *     damaged by scrubText          0
 *
 * and all six are the same shape:
 *
 *     "git stash drop / clear deletes stashed work"    -> "… drop <path> clear …"
 *     "Terraform apply/destroy without the prompt"     -> "Terraform <path> without …"
 *     "Approve curl/wget piped to a shell"             -> "Approve <path> piped …"
 *
 * A `<path>` in the middle of a guardrail's name, in every report, makes the title
 * unreadable. So the path pass is omitted HERE and
 * only here, and the residual is stated rather than hidden: an absolute path typed into a
 * title survives. That is a narrow gap — a path belongs in a guardrail's `match`, not its
 * name — and `scan --review` prints titles beside command shapes precisely so it is seen.
 *
 * What remains still earns its place: `scrubText` takes out a secret pasted into a title,
 * and `redactIdentifiers` takes the container name out of "Audit docker exec acme-prod-db",
 * which is a plausible thing for a user to call their own rule. Neither touches any of the
 * 56, and `scan-report.test.ts` asserts that over the real catalog rather than a fixture.
 */
export function redactTitle(text: string): string {
  return redactIdentifiers(scrubText(text).text);
}

/**
 * Longest command shape shown in a rendered row, before middle truncation.
 *
 * A SEPARATE concern from `mapper.ts`'s `MAX_DETAIL_LEN` (8192), not a second copy of
 * it: that cap bounds what the ENGINE reads, and it has already been applied by the
 * time anything reaches this module. This one bounds what a HUMAN reads in a table
 * cell. The marker is deliberately the same `TRUNCATION_MARKER`, so the report has one
 * truncation vocabulary rather than two spellings of the same idea.
 */
export const MAX_DISPLAY_LEN = 160;

/**
 * Flatten a command to one line.
 *
 * Found on real data: a heredoc or a `&&`-chained script is genuinely multi-line, and
 * printed verbatim it breaks the terminal summary's aligned table into a wall of
 * ragged text and turns one table row into five. Collapsing runs of whitespace also
 * makes the repeat key stable — the same script re-indented is the same mistake.
 */
function flatten(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Middle-truncate for display, keeping the head and the tail. */
function capDisplay(s: string): string {
  if (s.length <= MAX_DISPLAY_LEN) return s;
  const budget = MAX_DISPLAY_LEN - TRUNCATION_MARKER.length;
  const head = Math.ceil(budget / 2);
  const tail = budget - head;
  return `${s.slice(0, head)}${TRUNCATION_MARKER}${s.slice(s.length - tail)}`;
}

/**
 * The one-line, fully-redacted rendering of a tool call.
 *
 * A shell command reads best alone (`rm -rf <path>`). A file-tool call has no command,
 * so it is rendered as the tool plus
 * its redacted path, which is the only informative form available. A call with neither
 * channel — an unknown tool, `WebFetch`, a malformed payload — renders as the bare
 * tool name; it can never have matched a rule, so it only reaches here through the
 * total-calls count.
 */
export function displayTextOf(mapped: MappedCall): string {
  const command = mapped.args.full_command;
  if (command !== undefined) return capDisplay(flatten(redactForReport(command)));
  const filePath = mapped.args.file_path;
  if (filePath !== undefined) {
    return capDisplay(flatten(`${mapped.tool} ${redactForReport(filePath)}`));
  }
  return mapped.tool;
}

/** One example shape under a finding, with how many times it occurred. */
export interface ExampleShape {
  /** Redacted, capped command shape. */
  readonly text: string;
  readonly count: number;
}

/** Everything one rule did across the whole corpus. */
export interface ScanFinding {
  readonly ruleId: string;
  readonly title: string;
  readonly severity: string;
  readonly action: GuardAction;
  /** How many tool calls this rule matched. */
  readonly count: number;
  /** Distinct redacted shapes, most frequent first. */
  readonly examples: readonly ExampleShape[];
}

/** One command shape that happened more than once and matched a rule. */
export interface RecurringItem {
  readonly text: string;
  readonly count: number;
  readonly ruleId: string;
  /** The rule's title — what the repeat actually means, beside the shape. */
  readonly title: string;
}

/** What a scan found. Every string on it is redacted; see the module header. */
export interface ScanResult {
  /** Sessions successfully parsed. */
  readonly sessions: number;
  /** Files that could not be folded into a session at all, and were skipped. */
  readonly quarantined: number;
  /**
   * Transcript files under the root that the reader never opened.
   *
   * **A count of FILES, and it must not be rendered as a count of sessions.** The reader
   * walks exactly `<root>/<project>/<session>.jsonl`; Claude Code also writes
   * `<root>/<project>/<session>/subagents/*.jsonl`, and those normally belong to a
   * session file that WAS read. What is absent is the tool calls sub-agents made inside
   * sessions that were counted, not whole sessions, and the report says so: overstating
   * a gap misleads as much as hiding one.
   *
   * The reader does not descend into those directories, so this counts the gap and
   * states it.
   */
  readonly notRead: number;
  /** Individual transcript lines skipped as unparseable, across all sessions. */
  readonly skippedLines: number;
  /** COUNT of projects the sessions came from. Never their names — see `commands/scan.ts`. */
  readonly projects: number;
  /** Every tool call seen, matched or not. */
  readonly toolCalls: number;
  /** Tool calls that matched at least one rule. */
  readonly riskyActions: number;
  /** Per-rule totals, most frequent first. */
  readonly findings: readonly ScanFinding[];
  /** Shapes seen two or more times, most frequent first. */
  readonly recurring: readonly RecurringItem[];
  readonly tokens: TokenTotals;
}

/** Counts of what the walk found on disk, which the aggregator cannot see for itself. */
export interface ScanCorpus {
  readonly sessions: readonly ParsedSession[];
  /** Files the parser refused. Counted so one corrupt file is visible, not silent. */
  readonly quarantined: number;
  /** Transcript files under the root the reader never opened. See `ScanResult`. */
  readonly notRead: number;
  /** How many distinct projects the sessions came from. A COUNT, never a name. */
  readonly projects: number;
}

/** Mutable accumulator for one rule. */
interface FindingAccumulator {
  count: number;
  readonly shapes: Map<string, number>;
}

/** Most-frequent-first, then lexical — so two runs over one corpus render identically. */
function byCountThenText<T extends { count: number; text: string }>(a: T, b: T): number {
  return b.count - a.count || a.text.localeCompare(b.text);
}

/**
 * Aggregate a corpus into a `ScanResult`.
 *
 * A rule that matched nothing is absent from `findings` rather than present with a
 * zero: a table of 56 rules with 53 zeroes buries the three that fired, and "this rule
 * never matched" is not a finding.
 */
export function aggregateScan(
  corpus: ScanCorpus,
  catalog: readonly CompiledRule[],
  allowlist: CompiledAllowlist,
): ScanResult {
  const byRule = new Map<string, FindingAccumulator>();
  const ruleOf = new Map<string, CompiledRule>();
  for (const entry of catalog) ruleOf.set(entry.rule.id, entry);

  let toolCalls = 0;
  let riskyActions = 0;
  let skippedLines = 0;
  let tokens = EMPTY_TOKEN_TOTALS;

  for (const session of corpus.sessions) {
    skippedLines += session.skippedLines;
    for (const turn of session.turns) tokens = addUsage(tokens, turn.usage);

    for (const payload of toolCallsOf(session)) {
      toolCalls++;
      const mapped = mapToolCall(payload);
      const context: SpanContext = buildGuardSpanContext(mapped);
      const decision = evaluateCall(catalog, context, mapped, allowlist);
      if (decision.matches.length === 0) continue;

      riskyActions++;
      // Redacted ONCE per matched call, then shared by every rule that matched it.
      // Scrubbing is the most expensive thing in this loop and the result is identical
      // per rule, so doing it inside the inner loop would be a per-rule cost for a
      // per-call value.
      const text = displayTextOf(mapped);
      for (const match of decision.matches) {
        let acc = byRule.get(match.ruleId);
        if (acc === undefined) {
          acc = { count: 0, shapes: new Map() };
          byRule.set(match.ruleId, acc);
        }
        acc.count++;
        acc.shapes.set(text, (acc.shapes.get(text) ?? 0) + 1);
      }
    }
  }

  const findings: ScanFinding[] = [];
  const recurring: RecurringItem[] = [];

  for (const [ruleId, acc] of byRule) {
    const entry = ruleOf.get(ruleId);
    // A match whose rule is not in the catalog cannot happen — `evaluateCall` only
    // reports ids it was given — but the map lookup is still `| undefined`, and
    // inventing a title here would put a fabricated string in a shared report.
    //
    // REDACTED. `scan` appends the user's own `guardrails.json` to the catalog
    // (`commands/scan.ts`), so a title is author-written free text, and the module
    // header's invariant — "nothing in `ScanResult` is derived from an unredacted
    // string" — covers it too.
    //
    // Through `redactTitle`, NOT `redactForReport` — a title is prose and the path pass
    // mangles 11% of the shipped library. The measurement and the reasoning are on
    // `redactTitle` above; both residuals it leaves are named in the report's own copy.
    //
    // WHAT IT ACTUALLY CATCHES: "Audit docker
    // exec acme-prod-db" becomes "Audit docker exec <name>", and a secret pasted into a
    // title becomes a placeholder. "AcmeCorp internal audit" is UNCHANGED, and no redactor
    // can do better — those are the author's own words and nothing distinguishes a
    // client's name from a noun. That is why `scan --review` prints guardrail titles
    // beside the command shapes.
    //
    // `ruleId` is deliberately NOT redacted: it is the key a `--json` consumer matches
    // on, and a slug the user typed as a machine key falls under the same residual.
    const title = redactTitle(entry?.rule.title ?? ruleId);
    const severity = entry?.rule.severity ?? "unknown";
    const action: GuardAction = entry?.action ?? "warn";

    const examples: ExampleShape[] = [...acc.shapes]
      .map(([text, count]) => ({ text, count }))
      .sort(byCountThenText);

    findings.push({ ruleId, title, severity, action, count: acc.count, examples });

    for (const example of examples) {
      if (example.count >= 2) {
        recurring.push({ text: example.text, count: example.count, ruleId, title });
      }
    }
  }

  findings.sort((a, b) => b.count - a.count || a.ruleId.localeCompare(b.ruleId));
  recurring.sort(byCountThenText);

  return {
    sessions: corpus.sessions.length,
    quarantined: corpus.quarantined,
    notRead: corpus.notRead,
    skippedLines,
    projects: corpus.projects,
    toolCalls,
    riskyActions,
    findings,
    recurring,
    tokens,
  };
}
