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
 * ── Claude Code and Cursor ───────────────────────────────────────────────────
 * A Claude Code tool call maps to one call through `mapper.ts`, as the hook maps it. A
 * Cursor tool call maps through `cursor-transcript/scan.ts`, to two calls for a `Grep` or
 * `Glob` with a folder and a glob. Every call is evaluated and the stricter verdict is
 * kept, as the hook keeps it, so one tool call counts as one risky action at most. Cursor's
 * session files record no token counts, so a Cursor result has `tokens: null`, and
 * `skipped` counts what the reader could not use.
 *
 * ── No currency, and no field that could carry one ───────────────────────────
 * There is no price, no rate, no risk figure and no "estimated" anything on any type
 * in this file. Counts are counts and tokens come straight off the transcript. A
 * dollar figure is a count multiplied by an assumption; see `core/report.ts`.
 */

import { type EvaluatedCandidate, strictestCandidate } from "./cursor-emit.js";
import type { CursorCandidates } from "./cursor-mapper.js";
import type { CursorLineCounts } from "./cursor-transcript/parse.js";
import { cursorSessionCalls } from "./cursor-transcript/scan.js";
import type { CompiledAllowlist } from "./evaluate.js";
import { evaluateCall } from "./evaluate.js";
import { mapToolCall, TRUNCATION_MARKER } from "./mapper.js";
import { buildGuardSpanContext } from "./normalize.js";
import { redactIdentifiers } from "./redact-identifiers.js";
import { redactMcpPayload } from "./redact-mcp.js";
import { redactPaths } from "./redact-path.js";
import type { CompiledRule } from "./rules.js";
import { scrubText } from "./scrub.js";
import { addUsage, EMPTY_TOKEN_TOTALS, type TokenTotals } from "./tokens.js";
import type { ParsedSession } from "./transcript/transcript-types.js";
import { toolCallsOf } from "./transcripts.js";
import type { AgentSource, GuardAction, MappedCall } from "./types.js";

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
 * shipped library's 74 titles:
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
 * 74, and `scan-report.test.ts` asserts that over the real catalog rather than a fixture.
 */
export function redactTitle(text: string): string {
  // `kubeResourceOperands: false` for the same reason the path pass is skipped: a title
  // is prose, and "kubectl delete / drain removes running workloads" is a sentence whose
  // words are not resource names. The container-name redaction is KEPT — a title such as
  // "Audit docker exec acme-prod-db" carries a real name — and `scan-report.test.ts`
  // asserts both directions over the shipped catalog.
  return redactIdentifiers(scrubText(text).text, { kubeResourceOperands: false });
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
  if (command !== undefined) {
    // An `mcp__*` command channel is a serialized JSON payload, not shell text: its
    // values are structurally redacted FIRST (`redactMcpPayload`), leaving only keys and
    // placeholders, and then the three command passes run as a second layer. Every other
    // channel is shell text and goes straight through the composition.
    const redacted = mapped.tool.startsWith("mcp__")
      ? redactForReport(redactMcpPayload(command))
      : redactForReport(command);
    return capDisplay(flatten(redacted));
  }
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

/** What a reader could not use, by kind. Cursor's reader counts these. */
export interface ReaderSkips extends CursorLineCounts {
  /** Session files that could not be opened or read to the end. */
  readonly unreadableFiles: number;
}

/** A tool name the reader does not recognize, and how many calls used it. */
export interface UnmappedTool {
  /** Redacted, and `<other>` for a name that is not a plain identifier. */
  readonly name: string;
  readonly count: number;
}

/** What a Cursor scan read but did not evaluate. */
export interface ScanSkipped extends ReaderSkips {
  /** Tool calls that are not actions a guardrail checks, such as a to-do list. */
  readonly notActions: number;
  /** Tool calls with a name the reader does not recognize, most frequent first. */
  readonly unmappedTools: readonly UnmappedTool[];
}

/** One tool call from a session, as what it is evaluated as. */
export type SessionToolCall =
  | { readonly kind: "action"; readonly candidates: CursorCandidates }
  | { readonly kind: "not-action" }
  | { readonly kind: "unmapped"; readonly name: string };

/** What a scan found. Every string on it is redacted; see the module header. */
export interface ScanResult {
  /** Whose sessions were read. */
  readonly agent: AgentSource;
  /** Sessions successfully parsed. */
  readonly sessions: number;
  /** Files that could not be folded into a session at all, and were skipped. */
  readonly quarantined: number;
  /**
   * Transcript files under the root that the reader never opened.
   *
   * **A count of FILES, and it must not be rendered as a count of sessions.** The reader
   * opens each `<root>/<project>/<session>.jsonl` AND the sub-agent transcripts beside it
   * in `<root>/<project>/<session>/subagents/*.jsonl`, folding a sub-agent's tool calls into
   * the session that started it. So what this counts is the `.jsonl` files ELSEWHERE — a
   * stray file, or one nested somewhere the reader does not walk — never a whole session
   * that was silently skipped, and the report says so: overstating a gap misleads as much
   * as hiding one.
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
  /** `null` for Cursor, whose session files record no token counts. */
  readonly tokens: TokenTotals | null;
  /** Cursor only: what was read but not evaluated, by kind. */
  readonly skipped?: ScanSkipped;
}

/** Counts of what the walk found on disk, which the aggregator cannot see for itself. */
export interface ScanCorpus {
  /** Whose sessions these are. Omitted means Claude Code. */
  readonly agent?: AgentSource;
  readonly sessions: readonly ParsedSession[];
  /** Files the parser refused. Counted so one corrupt file is visible, not silent. */
  readonly quarantined: number;
  /** Transcript files under the root the reader never opened. See `ScanResult`. */
  readonly notRead: number;
  /** How many distinct projects the sessions came from. A COUNT, never a name. */
  readonly projects: number;
  /** What the reader could not use. Cursor's reader sets it. */
  readonly skipped?: ReaderSkips;
}

/** Nothing skipped. */
const NO_READER_SKIPS: ReaderSkips = {
  unparseableLines: 0,
  truncatedLastLines: 0,
  unknownRecords: 0,
  turnsEndedWithError: 0,
  unreadableFiles: 0,
};

/**
 * Evaluate one tool call's candidates and keep the strictest, as the hook does.
 *
 * Exported so a test can check that a session file's tool call and the same call as a hook
 * payload get one verdict.
 */
export function evaluateAction(
  catalog: readonly CompiledRule[],
  allowlist: CompiledAllowlist,
  candidates: CursorCandidates,
): EvaluatedCandidate {
  const evaluate = (mapped: MappedCall): EvaluatedCandidate => ({
    mapped,
    decision: evaluateCall(catalog, buildGuardSpanContext(mapped), mapped, allowlist),
  });
  const [first, ...rest] = candidates;
  return strictestCandidate([evaluate(first), ...rest.map(evaluate)]);
}

/** Every tool call in a Claude Code session, each mapped as the hook maps it. */
function* claudeSessionCalls(session: ParsedSession): Iterable<SessionToolCall> {
  for (const payload of toolCallsOf(session)) {
    yield { kind: "action", candidates: [mapToolCall(payload)] };
  }
}

/** A plain tool name, like Cursor's own (`Shell`, `CallMcpTool`). */
const PLAIN_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * An unrecognized tool name, as the report may show it.
 *
 * A name is Cursor's vocabulary, not the user's text, but it comes off disk, so it is held
 * to a plain identifier and still redacted: anything else is `<other>`.
 */
function unmappedToolName(raw: string): string {
  if (raw === "") return "<unnamed>";
  return PLAIN_TOOL_NAME.test(raw) ? redactTitle(raw) : "<other>";
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
 * zero: a table of 74 rules with 71 zeroes buries the three that fired, and "this rule
 * never matched" is not a finding.
 */
export function aggregateScan(
  corpus: ScanCorpus,
  catalog: readonly CompiledRule[],
  allowlist: CompiledAllowlist,
): ScanResult {
  const agent: AgentSource = corpus.agent ?? "claude";
  const byRule = new Map<string, FindingAccumulator>();
  const ruleOf = new Map<string, CompiledRule>();
  for (const entry of catalog) ruleOf.set(entry.rule.id, entry);

  let toolCalls = 0;
  let riskyActions = 0;
  let skippedLines = 0;
  let notActions = 0;
  const unmapped = new Map<string, number>();
  let tokens = EMPTY_TOKEN_TOTALS;

  for (const session of corpus.sessions) {
    skippedLines += session.skippedLines;
    for (const turn of session.turns) tokens = addUsage(tokens, turn.usage);

    const calls = agent === "cursor" ? cursorSessionCalls(session) : claudeSessionCalls(session);
    for (const call of calls) {
      if (call.kind === "not-action") {
        notActions++;
        continue;
      }
      if (call.kind === "unmapped") {
        const name = unmappedToolName(call.name);
        unmapped.set(name, (unmapped.get(name) ?? 0) + 1);
        continue;
      }
      toolCalls++;
      const { mapped, decision } = evaluateAction(catalog, allowlist, call.candidates);
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

  const result: ScanResult = {
    agent,
    sessions: corpus.sessions.length,
    quarantined: corpus.quarantined,
    notRead: corpus.notRead,
    skippedLines,
    projects: corpus.projects,
    toolCalls,
    riskyActions,
    findings,
    recurring,
    tokens: agent === "cursor" ? null : tokens,
  };
  if (agent !== "cursor") return result;

  const unmappedTools: UnmappedTool[] = [...unmapped]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return {
    ...result,
    skipped: { ...(corpus.skipped ?? NO_READER_SKIPS), notActions, unmappedTools },
  };
}

/** Cap on the MCP payloads `--review` discloses, so the local check stays bounded. */
const MAX_MCP_DISCLOSURES = 50;

/**
 * The raw MCP payloads `--review` shows the operator — secrets scrubbed, identifiers kept.
 *
 * The report redacts every MCP value to `<value>` (`displayTextOf`), which is right for a
 * file meant to be shared and useless for deciding whether it is safe to share: the
 * reviewer can no longer see WHAT is being removed. `--review` runs on the operator's own
 * machine, so it discloses the real values here — with `scrubText` applied so an actual
 * secret is never printed to a terminal, but identifiers left visible so the human can
 * judge them. Bounded and de-duplicated; only calls that MATCHED a rule — the ones the
 * report will carry — are disclosed, and only for an `mcp__*` payload, since every other
 * channel is already shown verbatim in the review's command list.
 *
 * The calls are derived exactly as `aggregateScan` derives them — through the Cursor path
 * for a Cursor corpus and the Claude path otherwise — so a Cursor MCP call (`CallMcpTool`
 * / `CallDynamicTool`, mapped to `mcp__<server>__<tool>`) is recognized and disclosed here
 * just as a Claude `mcp__*` call is. The report itself stays `<value>`-redacted for both.
 */
export function mcpReviewDisclosures(
  corpus: ScanCorpus,
  catalog: readonly CompiledRule[],
  allowlist: CompiledAllowlist,
): readonly string[] {
  const agent: AgentSource = corpus.agent ?? "claude";
  const seen = new Set<string>();
  const out: string[] = [];

  for (const session of corpus.sessions) {
    const calls = agent === "cursor" ? cursorSessionCalls(session) : claudeSessionCalls(session);
    for (const call of calls) {
      if (call.kind !== "action") continue;
      const { mapped, decision } = evaluateAction(catalog, allowlist, call.candidates);
      if (!mapped.tool.startsWith("mcp__")) continue;
      const command = mapped.args.full_command;
      if (command === undefined) continue;
      if (decision.matches.length === 0) continue;

      const disclosure = `${mapped.tool}  ${scrubText(command).text}`;
      if (seen.has(disclosure)) continue;
      seen.add(disclosure);
      out.push(disclosure);
      if (out.length >= MAX_MCP_DISCLOSURES) return out;
    }
  }

  return out;
}
