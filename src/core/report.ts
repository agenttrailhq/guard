// cspell:words backticked hellip middot noopener noreferrer waitlist
/**
 * `agenttrail-guard-report.html` — one self-contained file.
 *
 * ── The constraint that shapes every line below ──────────────────────────────
 * "It must render from a `file://` URL with the wifi off, and it must not phone home
 * when someone opens it." So: inline `<style>`, no `<script>`, no `<img>`, no `<link>`,
 * no `@import`, no `url(…)`, no web font, and nothing that loads from outside the file.
 * `report.test.ts` asserts each of those over the generated string, each with a
 * negative control proving the assertion fires on a fixture that violates it. The
 * palette, stylesheet and logo live in `report-brand.ts` under the same rules.
 *
 * ── Two variants, one body ────────────────────────────────────────────────────
 * `document` is the standalone page. `artifact` is the same body as page content only —
 * no doctype, `<html>`, `<head>` or `<body>` — for publishing as a Claude artifact, whose
 * host supplies that skeleton. The two differ only where the page speaks about itself —
 * where it came from, and who can still check it — so a reviewed file and a published
 * file carry the same findings. `report.test.ts` compares the two bodies.
 *
 * ── One link, in Claude Code reports only ────────────────────────────────────
 * A Claude Code report carries one product note, `PRODUCT_NOTE`, after the last section
 * and before the footer: it names agenttrail, which works with Claude Code sessions, and
 * links to it once, `rel="noopener noreferrer"`. A link loads nothing until it is clicked,
 * so the file still renders offline and opening it still contacts nobody. A Cursor report
 * carries no note. The footer never carries one (`catalog-stamp.test.ts`), and the
 * repository URL in it stays text. The href set is pinned exactly in `report.test.ts`, so
 * a second link cannot arrive without a test change.
 *
 * ── No currency, anywhere ─────────────────────────────────────────────────────
 * Not in the hero, not in the findings table, not labelled "estimated". Counts are
 * counts; token totals come straight off the transcript and are exact. A dollar figure
 * is a count multiplied by an assumption: one rule firing on a test suite that deletes
 * its own scratch directories would multiply into a large and entirely false number.
 * Leaving prices out also removes any dependency on model pricing, which is unknown for
 * an unrecognized model.
 *
 * The rule is about what the GUARD claims. A report can still contain `$` inside
 * commands the user's own agent ran, such as `${DB}` or `$?`: `redactPaths` keeps a
 * shell variable deliberately — `rm -rf $DIR` is a documented miss of the rm rule and
 * hiding the variable would hide the coverage limit. So the ban is total on every word
 * this file writes, and the `<code>` spans are quoted input. `report.test.ts` splits
 * the assertion the same way.
 *
 * ── Nothing it cannot source ─────────────────────────────────────────────────
 * Where the catalog carries no version stamp the footer says "version not yet stamped"
 * rather than omitting the row — an absent row reads as "there is no catalog", which is
 * a different and wronger claim. Where no session reported a cache-write split, the
 * split row is withheld rather than printed as `0 / 0`, because those are two different
 * facts and only one of them is true.
 *
 * ── Every interpolation is escaped ───────────────────────────────────────────
 * `ScanResult` is redacted by construction (`scan-report.ts`), but redacted is not the
 * same as inert: a command containing `<` or `&` must not become markup. Everything
 * from the result goes through `escapeHtml`, including numbers, so there is no
 * "this one is safe" exception to copy.
 */

import { catalogStamp, formatCatalogStamp } from "./catalog-stamp.js";
import { LOGO_LOCKUP_SVG, LOGO_MARK_SVG, REPORT_STYLES } from "./report-brand.js";
import type { ScanFinding, ScanResult, ScanSkipped } from "./scan-report.js";
import { formatCount, formatTokens, totalTokens } from "./tokens.js";
import type { AgentSource, GuardAction } from "./types.js";

/** Where the source lives. Rendered as text; see the header. */
export const REPOSITORY_URL = "https://github.com/agenttrailhq/guard";

/** The report's filename, used by `commands/scan.ts`. */
export const REPORT_FILENAME = "agenttrail-guard-report.html";

/** The page-content variant's default filename, so it never overwrites the standalone page. */
export const ARTIFACT_FILENAME = "agenttrail-guard-artifact.html";

/** Which page to render. See "Two variants, one body" in the header. */
export type ReportVariant = "document" | "artifact";

/** How to render. The default is the standalone `document`. */
export interface RenderOptions {
  readonly variant?: ReportVariant;
}

/**
 * The one product note, in Claude Code reports only. Its wording and address live here so
 * they can change without touching the renderer.
 */
export const PRODUCT_NOTE = {
  eyebrow: "agenttrail",
  heading: "Catch the mistakes your agents repeat",
  body: "This report is one look at the transcripts on one machine. agenttrail watches every agent session, turns each repeated mistake into a guardrail, and proves the fix on your own history. It is a separate product; nothing in this report was sent to it.",
  action: "Join the waitlist",
  url: "https://www.agenttrail.sh",
  label: "www.agenttrail.sh",
} as const;

/** Severities from most to least serious. Anything else ranks after all of them. */
export const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"] as const;

/** Where a severity sorts: its index in `SEVERITY_ORDER`, or after every known one. */
export function severityRank(severity: string): number {
  const index = (SEVERITY_ORDER as readonly string[]).indexOf(severity);
  return index === -1 ? SEVERITY_ORDER.length : index;
}

/** Actions from strictest to mildest, the order the report and the summary list them in. */
const ACTION_ORDER: readonly GuardAction[] = ["block", "require_approval", "warn"];

/** Guardrail matches totalled by severity and by action. */
export interface MatchTally {
  readonly bySeverity: readonly { readonly severity: string; readonly count: number }[];
  readonly byAction: readonly { readonly action: GuardAction; readonly count: number }[];
}

/**
 * Every finding's matches, totalled by severity and by action — over ALL findings, not
 * the first `MAX_ROWS` the table lists. A tool call that matched two guardrails counts
 * under each, which is why the totals can exceed `riskyActions`. Shared by the report and
 * the terminal summary so both state the same numbers.
 */
export function matchTally(result: ScanResult): MatchTally {
  const bySeverity = new Map<string, number>();
  const byAction = new Map<GuardAction, number>();
  for (const finding of result.findings) {
    bySeverity.set(finding.severity, (bySeverity.get(finding.severity) ?? 0) + finding.count);
    byAction.set(finding.action, (byAction.get(finding.action) ?? 0) + finding.count);
  }
  return {
    bySeverity: [...bySeverity]
      .map(([severity, count]) => ({ severity, count }))
      .sort(
        (a, b) =>
          severityRank(a.severity) - severityRank(b.severity) ||
          b.count - a.count ||
          a.severity.localeCompare(b.severity),
      ),
    byAction: ACTION_ORDER.flatMap((action) => {
      const count = byAction.get(action) ?? 0;
      return count > 0 ? [{ action, count }] : [];
    }),
  };
}

/** Findings ordered most serious first, then most frequent, then by id. A new array. */
export function bySeverityThenCount(findings: readonly ScanFinding[]): ScanFinding[] {
  return [...findings].sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      b.count - a.count ||
      a.ruleId.localeCompare(b.ruleId),
  );
}

/**
 * How many findings and repeats the HTML lists before it stops.
 *
 * Exported because `scan --review` enumerates exactly what this file writes, and a
 * second copy of the cap would drift: the review would promise "this is the whole file"
 * while showing a different set.
 */
export const MAX_ROWS = 50;
/** How many distinct shapes are shown under one finding. See {@link MAX_ROWS}. */
export const MAX_EXAMPLES = 3;

/**
 * What the renderers need that a `ScanResult` cannot know about itself.
 *
 * There is deliberately NO path on this type. The obvious field to add is "where the
 * transcripts were read from", and it is a leak: the default root is
 * `~/.claude/projects`, which on a real machine expands to `/Users/<their name>/…`.
 * The person running the scan already knows where they pointed it; a reader of the
 * shared file has no use for it and would be handed a username. The terminal summary
 * may print it — that is their own screen — but this file may not.
 */
export interface ReportMeta {
  /** The guard's own version. */
  readonly version: string;
  /** When the scan ran. */
  readonly generatedAt: Date;
}

/**
 * Escape text for HTML.
 *
 * Five characters, including both quote forms: the output is interpolated into text
 * nodes today, and an attribute tomorrow when someone adds a `title`. Escaping for the
 * stricter context always is cheaper than remembering which helper to use where.
 */
export function escapeHtml(value: string | number): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The app whose sessions a scan read, as the report and the summary name it. */
export function agentName(agent: AgentSource): string {
  return agent === "cursor" ? "Cursor" : "Claude Code";
}

/** A count and a noun phrase that agrees with it. */
function counted(n: number, one: string, many: string): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/**
 * What a Cursor scan read but could not use, as counted phrases. Empty when there is none.
 *
 * Shared by the report and the terminal summary, so both say the same thing. Tool calls
 * that are not actions, and turns that ended with an error, are not listed: every long
 * session has them, and neither leaves a tool call unread.
 */
export function skippedPhrases(skipped: ScanSkipped): readonly string[] {
  const unrecognized = skipped.unmappedTools.reduce((sum, tool) => sum + tool.count, 0);
  const kinds: readonly (readonly [number, string, string])[] = [
    [skipped.unreadableFiles, "file that could not be read", "files that could not be read"],
    [
      skipped.truncatedLastLines,
      "file whose last line was cut off",
      "files whose last line was cut off",
    ],
    [skipped.unparseableLines, "line that is not JSON", "lines that are not JSON"],
    [
      skipped.unknownRecords,
      "record of a kind this reader does not know",
      "records of a kind this reader does not know",
    ],
    [
      unrecognized,
      "tool call of a kind this reader does not recognize",
      "tool calls of a kind this reader does not recognize",
    ],
  ];
  return kinds.filter(([n]) => n > 0).map(([n, one, many]) => counted(n, one, many));
}

/** A severity's display class. Unknown severities fall to the neutral, dashed tone. */
function severityClass(severity: string): string {
  switch (severity) {
    case "critical":
      return "sev-critical";
    case "high":
      return "sev-high";
    case "medium":
      return "sev-medium";
    case "low":
      return "sev-low";
    case "info":
      return "sev-info";
    default:
      return "sev-unknown";
  }
}

/** What the guard would have done, in words rather than in the engine's vocabulary. */
export function actionLabel(action: string): string {
  switch (action) {
    case "block":
      return "would block";
    case "require_approval":
      return "would ask";
    default:
      return "would warn";
  }
}

/** An action's chip class. */
function actionClass(action: string): string {
  switch (action) {
    case "block":
      return "act-block";
    case "require_approval":
      return "act-ask";
    default:
      return "act-warn";
  }
}

/** A severity pill. The text is the rule's own severity, whatever it is. */
function severityBadge(severity: string): string {
  return `<span class="badge ${severityClass(severity)}">${escapeHtml(severity)}</span>`;
}

/** An action chip. */
function actionChip(action: string): string {
  return `<span class="chip ${actionClass(action)}">${escapeHtml(actionLabel(action))}</span>`;
}

/**
 * A guardrail title, with its `backticked` spans shown as code.
 *
 * Escaped FIRST, so whatever sits between the backticks is already inert text; the swap
 * only adds `<code>` tags around it. An unpaired backtick stays a literal backtick.
 */
function inlineTitle(title: string): string {
  return escapeHtml(title).replace(/`([^`\n]+)`/g, "<code>$1</code>");
}

/** One `<div class="stat">`. The class names are part of what the tests read. */
function stat(value: string, label: string, note?: string): string {
  const noteHtml = note === undefined ? "" : `<div class="stat-note">${escapeHtml(note)}</div>`;
  return `<div class="stat"><div class="stat-value">${escapeHtml(value)}</div><div class="stat-label">${escapeHtml(label)}</div>${noteHtml}</div>`;
}

/** The hero strip. No token cell when the sessions record no token counts (Cursor's). */
function heroSection(result: ScanResult): string {
  const t = result.tokens;
  const cells = [
    stat(formatCount(result.sessions), result.sessions === 1 ? "session" : "sessions"),
    stat(formatCount(result.toolCalls), "tool calls"),
    stat(formatCount(result.riskyActions), "risky actions"),
    stat(formatCount(result.recurring.length), "recurring mistakes"),
  ];
  if (t !== null) {
    cells.push(
      stat(
        formatTokens(totalTokens(t)),
        "tokens",
        `${formatTokens(t.cacheRead)} cache reads (cumulative)`,
      ),
    );
  }
  return `<section class="stats" aria-label="Summary">\n${cells.join("\n")}\n</section>`;
}

/**
 * Matches by severity and by action, over every finding. Absent when nothing matched —
 * the Findings section already says so, and a strip of zeroes would say it twice.
 */
function tallySection(result: ScanResult): string {
  if (result.findings.length === 0) return "";
  const { bySeverity, byAction } = matchTally(result);
  const item = (label: string, count: number): string =>
    `<li>${label}<span class="tally-count">${escapeHtml(formatCount(count))}</span></li>`;
  const severities = bySeverity.map((s) => item(severityBadge(s.severity), s.count)).join("\n");
  const actions = byAction.map((a) => item(actionChip(a.action), a.count)).join("\n");
  return `<section class="tally" aria-label="Guardrail matches">
<div class="tally-group"><p class="tally-label">Matches by severity</p><ul class="pills">
${severities}
</ul></div>
<div class="tally-group"><p class="tally-label">What the guard would have done</p><ul class="pills">
${actions}
</ul></div>
<p class="note">Each guardrail counts its own matches, so a tool call that matched two guardrails is counted under both, and these totals can be larger than the number of risky actions.</p>
</section>`;
}

/**
 * The token detail table.
 *
 * The cache-write split is a SEPARATE row from the aggregate and is withheld entirely
 * when no turn reported one — see the module header, and `tokens.ts` on why the two
 * are never derived from each other.
 *
 * Omitted entirely for sessions that record no token counts (Cursor's): a table of zeroes
 * would state a count nobody measured.
 */
function tokensSection(result: ScanResult): string {
  const t = result.tokens;
  if (t === null) return "";
  const rows = [
    ["Input", formatCount(t.input)],
    ["Output", formatCount(t.output)],
    ["Read from cache (cumulative)", formatCount(t.cacheRead)],
    ["Written to cache", formatCount(t.cacheCreation)],
  ];
  if (t.turnsWithSplit > 0) {
    rows.push([
      "…of which 5-minute / 1-hour",
      `${formatCount(t.cacheCreation5m)} / ${formatCount(t.cacheCreation1h)}`,
    ]);
  }
  const body = rows
    .map(
      ([label, value]) =>
        `<tr><th scope="row">${escapeHtml(label ?? "")}</th><td class="num">${escapeHtml(value ?? "")}</td></tr>`,
    )
    .join("\n");

  const splitNote =
    t.turnsWithSplit > 0
      ? `<p class="note">The 5-minute / 1-hour split is reported separately by the model and is not derived from the total above; on real sessions the two do not always agree, so both are shown as reported.</p>`
      : `<p class="note">None of these sessions reported a 5-minute / 1-hour cache-write split, so that row is omitted rather than shown as zero.</p>`;

  // "Read from cache" is a cumulative figure: the cached prefix is re-read, and re-charged,
  // on every turn, so a long session's total dwarfs its distinct input. Said plainly so the
  // large number is not misread as fresh consumption.
  const cacheReadNote =
    t.cacheRead > 0
      ? `<p class="note">"Read from cache" is cumulative — the cached prefix is re-read and re-charged every turn, so this counts the same tokens many times over a session. It is a total of what the model billed for, not of distinct input.</p>`
      : "";

  return `<section><h2>Tokens</h2>
<p class="note">Read straight from the transcripts, so these are exact counts and not estimates.</p>
<div class="table-wrap"><table class="kv">
${body}
</table></div>
${cacheReadNote}${splitNote}</section>`;
}

/** The findings table. Rows stack into cards on a narrow screen, with CSS alone. */
function findingsSection(result: ScanResult): string {
  if (result.findings.length === 0) {
    return `<section><h2>Findings</h2><p class="empty">No guardrail matched anything in these sessions.</p></section>`;
  }

  const rows = result.findings
    .slice(0, MAX_ROWS)
    .map((finding) => {
      const examples = finding.examples
        .slice(0, MAX_EXAMPLES)
        .map(
          (example) =>
            `<li><code>${escapeHtml(example.text)}</code><span class="times">${escapeHtml(formatCount(example.count))}&times;</span></li>`,
        )
        .join("\n");
      const more =
        finding.examples.length > MAX_EXAMPLES
          ? `\n<li class="more">and ${escapeHtml(formatCount(finding.examples.length - MAX_EXAMPLES))} more shapes</li>`
          : "";
      return `<tr role="row">
<td class="rule" role="cell">
<div class="guardrail-title">${inlineTitle(finding.title)}</div>
<div class="guardrail-id"><code>${escapeHtml(finding.ruleId)}</code></div>
<ul class="shapes">
${examples}${more}
</ul>
</td>
<td class="sev" role="cell">${severityBadge(finding.severity)}</td>
<td class="act" role="cell">${actionChip(finding.action)}</td>
<td class="num" role="cell" data-label="Matches">${escapeHtml(formatCount(finding.count))}</td>
</tr>`;
    })
    .join("\n");

  const truncated =
    result.findings.length > MAX_ROWS
      ? `\n<p class="note">${escapeHtml(formatCount(result.findings.length - MAX_ROWS))} further guardrails matched and are not listed here.</p>`
      : "";

  const matched = counted(result.findings.length, "guardrail matched", "guardrails matched");
  return `<section>
<div class="section-head"><h2>Findings</h2><p class="section-meta">${escapeHtml(matched)}</p></div>
<div class="table-wrap"><table class="findings" role="table">
<thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Guardrail</th><th scope="col" role="columnheader">Severity</th><th scope="col" role="columnheader">Action</th><th scope="col" class="num" role="columnheader">Matches</th></tr></thead>
<tbody role="rowgroup">
${rows}
</tbody>
</table></div>${truncated}
</section>`;
}

/** The recurring-issues table. */
function recurringSection(result: ScanResult): string {
  if (result.recurring.length === 0) {
    return `<section><h2>Recurring issues</h2><p class="empty">Nothing matched more than once.</p></section>`;
  }
  const rows = result.recurring
    .slice(0, MAX_ROWS)
    .map(
      (item) =>
        `<tr role="row"><td class="shape" role="cell"><code>${escapeHtml(item.text)}</code></td><td class="num" role="cell">${escapeHtml(formatCount(item.count))}&times;</td><td class="rule-name" role="cell">${inlineTitle(item.title)}</td></tr>`,
    )
    .join("\n");
  return `<section><h2>Recurring issues</h2>
<p class="note">The same shape, seen more than once. Paths are redacted before counting, so many different paths under one command become one repeat.</p>
<div class="table-wrap"><table class="recurring" role="table">
<thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Command shape</th><th scope="col" class="num" role="columnheader">Times</th><th scope="col" role="columnheader">Guardrail</th></tr></thead>
<tbody role="rowgroup">
${rows}
</tbody>
</table></div>
</section>`;
}

/** What was read, and what could not be. */
function corpusSection(result: ScanResult): string {
  const lines: string[] = [];
  lines.push(
    `Read ${escapeHtml(formatCount(result.sessions))} session${result.sessions === 1 ? "" : "s"} across ${escapeHtml(formatCount(result.projects))} project${result.projects === 1 ? "" : "s"}.`,
  );
  if (result.quarantined > 0) {
    lines.push(
      `${escapeHtml(formatCount(result.quarantined))} file${result.quarantined === 1 ? "" : "s"} yielded no session and ${result.quarantined === 1 ? "was" : "were"} skipped &mdash; a transcript holding no messages, such as a session started and abandoned, has nothing to report.`,
    );
  }
  // A Cursor result lists its skipped lines by kind in its own section instead.
  if (result.skippedLines > 0 && result.skipped === undefined) {
    lines.push(
      `${escapeHtml(formatCount(result.skippedLines))} individual line${result.skippedLines === 1 ? "" : "s"} could not be parsed and ${result.skippedLines === 1 ? "was" : "were"} skipped.`,
    );
  }
  if (result.tokens === null) {
    lines.push(
      `${escapeHtml(agentName(result.agent))}&#39;s session files record no token counts, so this report shows none.`,
    );
  }

  // The reader's own coverage limit, stated rather than left to be discovered. A
  // report that silently covers a quarter of the corpus is the same class of failure
  // as one that over-claims, pointed the other way — and this one reads as good news.
  const notRead = `${escapeHtml(formatCount(result.notRead))} further transcript file${result.notRead === 1 ? "" : "s"}`;
  let coverage = "";
  if (result.notRead > 0 && result.agent === "cursor") {
    coverage = `<p class="note"><strong>Coverage limit.</strong> This reader opens each session&#39;s file, and the files of the sub-agents that session started, in each project&#39;s <code>agent-transcripts</code> folder. ${notRead} in those folders ${result.notRead === 1 ? "was" : "were"} not read. Every count above is of what was read, not of everything that exists.</p>`;
  } else if (result.notRead > 0) {
    coverage = `<p class="note"><strong>Coverage limit.</strong> This reader opens each session&#39;s transcript and the sub-agent transcripts in its <code>subagents</code> folder, folding a sub-agent&#39;s actions into the session that started it. ${notRead} elsewhere under the projects root &mdash; a stray file, or one nested somewhere it does not walk &mdash; ${result.notRead === 1 ? "was" : "were"} not read. Every count above is of what was read, not of everything that exists.</p>`;
  }

  // ── Two claims, stated separately ──────────────────────────────────────────
  //   - paths and working directories: redacted structurally, so "appear nowhere" holds;
  //   - identifying names: `core/redact-identifiers.ts` removes them for a fixed list of
  //     commands, and the paragraph says so, because the pass is a deny-list and cannot
  //     be proved complete. A project's name can survive, for example, as a container
  //     name in a command that list does not cover.
  //
  // The posture is the one two sections up ("thorough but not a guarantee. Read the
  // findings before posting this anywhere public"), repeated here because a reader who
  // has scrolled this far cannot see that sentence any more.
  return `<section><h2>What was scanned</h2>
<p class="note">${lines.join(" ")}</p>${coverage === "" ? "" : `\n${coverage}`}
<p class="note">Working directories and file paths appear nowhere in this file, and the projects these sessions came from are carried as a count and never as names.</p>
<p class="note"><strong>Identifying names are a weaker claim than paths, and the difference is worth knowing.</strong> Shell commands go through an identifier redactor keyed to a fixed list of tools &mdash; container runtimes, <code>kubectl</code> (including resource names), the database clients (host, database, and the SQL handed to <code>-c</code> / <code>-e</code>), <code>ssh</code>, <code>git</code> commit messages and identity settings, 1Password&#39;s <code>op</code> (item and vault names), and <code>gh</code> titles and bodies &mdash; plus, in any command, a secret passed as a flag value (<code>--token</code>, <code>--password</code>, <code>--key</code>), a UUID, the body of a heredoc, and the text of a <code>#</code> comment. That list is a deny-list and will miss the tool nobody thought of, so a bare operand naming a resource for a tool not on it can survive.</p>
<p class="note"><strong>MCP tool calls are handled the other way round:</strong> a call to an MCP server arrives as a structured payload, and rather than deny-listing known-sensitive fields, every value in it is redacted to <code>&lt;value&gt;</code> by default and only the field names and the shape are kept.</p>
<p class="note">Guardrail ids and titles are shown as their author wrote them &mdash; which for any guardrail you added yourself means your own words, unredacted. Redaction is thorough but not a guarantee. Read the commands and guardrail names above before posting this anywhere public.</p>
</section>`;
}

/**
 * What a Cursor scan read but did not evaluate. Absent from a Claude Code report.
 *
 * Every kind is listed with its count, and each tool name the reader does not recognize is
 * shown, so a reader can tell a quiet report from a report over files it could not read.
 */
function skippedSection(result: ScanResult): string {
  const skipped = result.skipped;
  if (skipped === undefined) return "";

  const phrases = skippedPhrases(skipped);
  const kinds =
    phrases.length === 0
      ? `<p class="empty">Every line of every session file that was opened was read.</p>`
      : `<ul class="list">\n${phrases.map((phrase) => `<li>${escapeHtml(phrase)}</li>`).join("\n")}\n</ul>`;

  const tools =
    skipped.unmappedTools.length === 0
      ? ""
      : `\n<p class="note">Tool calls this reader does not recognize, by name:</p>\n<ul class="shapes">\n${skipped.unmappedTools
          .map(
            (tool) =>
              `<li><code>${escapeHtml(tool.name)}</code><span class="times">${escapeHtml(formatCount(tool.count))}&times;</span></li>`,
          )
          .join("\n")}\n</ul>`;

  const notes: string[] = [];
  if (skipped.notActions > 0) {
    notes.push(
      `${counted(skipped.notActions, "tool call was", "tool calls were")} not evaluated because no guardrail checks that kind of call: plans, to-do lists, questions, and starting a sub-agent, whose own tool calls are read from its file.`,
    );
  }
  if (skipped.turnsEndedWithError > 0) {
    notes.push(
      `${counted(skipped.turnsEndedWithError, "turn", "turns")} ended with an error; the tool calls made before it were read.`,
    );
  }

  return `<section><h2>What was not evaluated</h2>
<p class="note">None of this stopped the scan. Each line of a session file is read on its own, and whatever could not be used is counted here.</p>
${kinds}${tools}${notes.map((note) => `\n<p class="note">${escapeHtml(note)}</p>`).join("")}
</section>`;
}

/**
 * Where this page came from — the one paragraph the two variants do not share.
 *
 * The standalone file was produced on the reader's own machine. A published copy was
 * produced on the PUBLISHER's machine and then put on claude.ai by them, so "nothing
 * uploaded" would be false there and it says what happened instead. Both keep the
 * qualified claim about the scan itself: it made no network call, crash reporting being
 * the one exception in this tool.
 */
function provenance(result: ScanResult, meta: ReportMeta, variant: ReportVariant): string {
  const stamp = `Generated ${escapeHtml(meta.generatedAt.toISOString())} by agenttrail-guard ${escapeHtml(meta.version)}`;
  if (variant === "artifact") {
    return `${stamp} on the publisher&#39;s own machine, from their own ${escapeHtml(agentName(result.agent))} transcripts. The scan itself made no network call &mdash; crash reporting is the one exception anywhere in this tool, off unless turned on, and a scan never uses it. This copy was published to claude.ai by the person who ran it, through Claude Code.`;
  }
  return `${stamp}. Produced entirely on this machine from transcripts already on disk &mdash; no account, nothing uploaded, and no network call: the one exception anywhere in this tool is crash reporting, which is off unless you turn it on and which a scan never uses.`;
}

/** "Before you share this": what the placeholders stand for, and the limit of redaction. */
function shareSection(result: ScanResult, variant: ReportVariant): string {
  const review = `<code>agenttrail-guard scan --agent ${escapeHtml(result.agent)} --review</code>`;
  const check =
    variant === "artifact"
      ? `Redaction is thorough but not a guarantee. Read the findings before passing this page on; the person who published it can check every line with ${review} before the file is written.`
      : `Redaction is thorough but not a guarantee. Read the findings before posting this anywhere public, and run ${review} to see every line before the file is written.`;
  return `<section class="callout">
<h2>Before you share this</h2>
<p class="note">Every command below has been through a secret scrubber, a path redactor and an identifier redactor, and every MCP tool call has had its payload values structurally redacted. Redaction runs before anything is written, so this file has never held the original text.</p>
<dl class="legend">
<div><dt><code>&lt;path&gt;</code></dt><dd>stands for a redacted filesystem path or URL</dd></div>
<div><dt><code>&lt;name&gt;</code> <code>&lt;host&gt;</code> <code>&lt;user&gt;</code> <code>&lt;message&gt;</code> <code>&lt;comment&gt;</code></dt><dd>stand for an identifying operand of a command &mdash; a container, a namespace, a machine, a login, a commit message or heredoc body, a shell comment</dd></div>
<div><dt><code>&lt;value&gt;</code></dt><dd>stands for a redacted MCP payload value</dd></div>
<div><dt><code>[REDACTED:&hellip;]</code></dt><dd>stands for a redacted secret</dd></div>
</dl>
<p class="warning">${check}</p>
</section>`;
}

/** The product note. Claude Code reports only; see the header. */
function productNoteSection(result: ScanResult): string {
  if (result.agent !== "claude") return "";
  return `<aside class="product-note" aria-label="About agenttrail">
<p class="eyebrow">${escapeHtml(PRODUCT_NOTE.eyebrow)}</p>
<h2>${escapeHtml(PRODUCT_NOTE.heading)}</h2>
<p>${escapeHtml(PRODUCT_NOTE.body)}</p>
<p class="product-note-action"><a class="button" href="${escapeHtml(PRODUCT_NOTE.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(PRODUCT_NOTE.action)}</a><span class="url">${escapeHtml(PRODUCT_NOTE.label)}</span></p>
</aside>`;
}

/** The page title: the tool, whose sessions, and the day — distinct in a list of reports. */
function pageTitle(result: ScanResult, meta: ReportMeta): string {
  return `agenttrail guard scan report · ${agentName(result.agent)} · ${meta.generatedAt.toISOString().slice(0, 10)}`;
}

/**
 * Render the whole report.
 *
 * Pure: the same result, the same `generatedAt` and the same variant produce the same
 * bytes, which is what lets the suite assert over the string instead of over a file on
 * disk. Every element sits on its own line, so no line of the file is longer than a
 * capped command shape plus its markup.
 */
export function renderReport(
  result: ScanResult,
  meta: ReportMeta,
  options: RenderOptions = {},
): string {
  const variant = options.variant ?? "document";
  // Through the SEAM, not a hard-coded `undefined`: `catalogStamp()` returns nothing
  // when the bundled catalog carries no stamp, and the footer says so. Once
  // it does, this line starts printing a real version with no edit here.
  const catalogLine = formatCatalogStamp(catalogStamp(), meta.generatedAt);
  const head = `<title>${escapeHtml(pageTitle(result, meta))}</title>
<style>${REPORT_STYLES}</style>`;
  const body = `<main class="page" lang="en">
<header class="masthead">
<div class="brand" role="img" aria-label="agenttrail">${LOGO_LOCKUP_SVG}</div>
<span class="product-tag">guard</span>
</header>
<section class="intro">
<p class="agent">Agent: ${escapeHtml(agentName(result.agent))}</p>
<h1>Scan report</h1>
<p class="lead">What your coding agent actually did, and which guardrails would have fired.</p>
<p class="provenance">${provenance(result, meta, variant)}</p>
</section>
${heroSection(result)}
${tallySection(result)}
${shareSection(result, variant)}
${findingsSection(result)}
${recurringSection(result)}
${tokensSection(result)}
${skippedSection(result)}
${corpusSection(result)}
${productNoteSection(result)}
<footer>
<p class="footer-brand">${LOGO_MARK_SVG}<span>agenttrail-guard ${escapeHtml(meta.version)} &middot; ${escapeHtml(catalogLine)}</span></p>
<p>Source: ${escapeHtml(REPOSITORY_URL)}</p>
<p>A finding is a guardrail that matched. It is not proof that anything went wrong, and the guardrails state their own coverage limits.</p>
</footer>
</main>`;

  if (variant === "artifact") return `${head}\n${body}\n`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
${head}
</head>
<body>
${body}
</body>
</html>
`;
}

/** One group of strings in the pre-flight review, with where they come from. */
export interface ReviewGroup {
  readonly label: string;
  readonly lines: readonly string[];
}

/**
 * Every distinct free-text string the report will contain — the `--review` payload.
 *
 * ── Why this lives beside the renderer and not beside the command ───────────
 * It reads the same `MAX_ROWS` / `MAX_EXAMPLES` the renderer slices by, from the same
 * file. A review computed anywhere else would have its own copy of the caps, and the
 * first change to either one would leave `--review` promising "this is everything" over
 * a different set. `report.test.ts` asserts the two agree over a real result rather than
 * trusting the shared constant.
 *
 * ── What it does NOT list, and why that is not a hole ───────────────────────
 * Counts, token totals and the corpus numbers are omitted. They are numbers, and the
 * file states its own rule for them: counts are counts and tokens come straight off the
 * transcript. An integer cannot carry a name, and listing 20 of them would
 * bury the three lines a reader has to actually look at. Everything the report renders
 * that a HUMAN wrote — a guardrail id, a guardrail title, a command shape — is here.
 *
 * De-duplicated, first appearance wins, so a shape that is both a finding example and a
 * recurring row is one line to read rather than two.
 */
export function reviewStrings(result: ScanResult): readonly ReviewGroup[] {
  const seen = new Set<string>();
  const take = (value: string): string[] => {
    if (seen.has(value)) return [];
    seen.add(value);
    return [value];
  };

  const guardrails: string[] = [];
  const commands: string[] = [];

  for (const finding of result.findings.slice(0, MAX_ROWS)) {
    guardrails.push(...take(`${finding.ruleId}  ${finding.title}`));
    for (const example of finding.examples.slice(0, MAX_EXAMPLES)) {
      commands.push(...take(example.text));
    }
  }
  for (const item of result.recurring.slice(0, MAX_ROWS)) {
    guardrails.push(...take(`${item.ruleId}  ${item.title}`));
    commands.push(...take(item.text));
  }
  // A tool name comes off disk too, so a Cursor report's unrecognized names are listed.
  const tools = (result.skipped?.unmappedTools ?? []).flatMap((tool) => take(tool.name));

  const groups: ReviewGroup[] = [];
  if (guardrails.length > 0)
    groups.push({ label: "Guardrails named in the report", lines: guardrails });
  if (commands.length > 0) groups.push({ label: "Command shapes in the report", lines: commands });
  if (tools.length > 0) groups.push({ label: "Tool names in the report", lines: tools });
  return groups;
}

/**
 * The `--json` payload.
 *
 * The same redacted `ScanResult`, plus the metadata the HTML footer carries, so a
 * pipeline consumer gets exactly what a reader of the report gets and nothing more.
 * Deliberately NOT a second shape: if the two could diverge, one of them would.
 */
export function renderJson(result: ScanResult, meta: ReportMeta): string {
  return `${JSON.stringify(
    {
      tool: "agenttrail-guard",
      version: meta.version,
      generatedAt: meta.generatedAt.toISOString(),
      catalog: formatCatalogStamp(catalogStamp(), meta.generatedAt),
      result,
    },
    null,
    2,
  )}\n`;
}
