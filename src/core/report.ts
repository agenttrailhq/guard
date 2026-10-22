// cspell:words backticked hellip middot noopener noreferrer ldquo rdquo rsquo
/**
 * `agenttrail-guard-report.html` — one self-contained file.
 *
 * ── The constraint that shapes every line below ──────────────────────────────
 * "It must render from a `file://` URL with the wifi off, and it must not phone home
 * when someone opens it." So: inline `<style>`, no `<img>`, no `<link>`, no `@import`, no
 * `url(…)`, no web font, and nothing that loads from outside the file. Links go out only
 * when clicked. `report.test.ts` asserts each of those over the generated string, each with
 * a negative control proving the assertion fires on a fixture that violates it. The palette,
 * stylesheet and logo live in `report-brand.ts` under the same rules.
 *
 * ── One script, on the standalone page only ──────────────────────────────────
 * The standalone page carries one inline script (`report-script.ts`) for filters, sort,
 * copy, theme, print and export, pinned by hash in a `default-src 'none'` Content-Security-
 * Policy that is the first element of `<head>`. Its data comes from one
 * `<script type="application/json">` block holding `reportPayload`, with every `<` written
 * as the six-character JSON escape backslash-u003c, so no `</script>` or `<!--` can occur
 * inside it. Everything
 * works without the script too: rows are all listed, expanders are `<details>`, and the
 * controls that need it stay `hidden`.
 *
 * ── Two variants, one body ────────────────────────────────────────────────────
 * `document` is the standalone page. `artifact` is the same body as page content only — no
 * doctype, `<html>`, `<head>` or `<body>` — for publishing as a Claude artifact, whose host
 * supplies that skeleton. It carries no script and no data block: it has no `<head>` for the
 * policy, so it is static. The two differ only where the page speaks about itself — where it
 * came from, and who can still check it — so a reviewed file and a published file carry the
 * same findings. `report.test.ts` compares the two bodies.
 *
 * ── What the file carries is one capped projection ───────────────────────────
 * `reportPayload` copies, field by field, the first `MAX_ROWS` findings (most serious first),
 * the first `MAX_EXAMPLES` shapes of each, the first `MAX_ROWS` repeats, the counts and the
 * share text. The rows, the data block, the export and `scan --review` all read it, so the
 * review lists exactly what the file holds, and a field added to `ScanResult` reaches the file
 * only when it is added here. `--json` on stdout stays the whole result.
 *
 * ── Links ────────────────────────────────────────────────────────────────────
 * Every link to the site is built by `siteLink`, which adds `utm_source`, `utm_medium`,
 * `utm_campaign` (the agent) and `utm_content` (where on the page). A link loads nothing until
 * it is clicked. Library pages are linked for shipped guardrails only. The two OWASP lists
 * are the only links off the site, to where OWASP publishes them, and carry no tags.
 *
 * ── OWASP ────────────────────────────────────────────────────────────────────
 * Every OWASP id on the page is one the matched guardrail carries itself (`ScanFinding.owasp`),
 * and every count comes from `ScanResult.owasp`. Risk names come from `owaspTitle`; nothing
 * here maps a guardrail, a pack or a command to a risk.
 *
 * ── No currency, anywhere ─────────────────────────────────────────────────────
 * Not in the hero, not in the findings, not labelled "estimated", and no score. Counts are
 * counts; token totals come straight off the transcript and are exact. A report can still
 * contain `$` inside commands the user's own agent ran, such as `${DB}`: `redactPaths` keeps a
 * shell variable deliberately, because `rm -rf $DIR` is a documented miss of the rm rule. So
 * the ban is total on every word this file writes, and the `<code>` spans and the
 * `library-text` paragraphs (shipped guardrail descriptions, quoted) are quoted input.
 *
 * ── Every interpolation is escaped ───────────────────────────────────────────
 * `ScanResult` is redacted by construction (`scan-report.ts`), but redacted is not the same as
 * inert: a command containing `<` or `&` must not become markup. Everything from the result
 * goes through `escapeHtml`, including numbers and attribute values.
 */

import { createHash } from "node:crypto";
import { OWASP_SOURCES } from "@agenttrail/guardrails/guardrails";
import { agentDisplayName, unhandledAgent } from "./agent.js";
import { catalogStamp, formatCatalogStamp } from "./catalog-stamp.js";
import {
  isOwaspId,
  OWASP_AGENTIC,
  OWASP_LLM,
  OWASP_PAGE_URL,
  type OwaspId,
  type OwaspTally,
  owaspAnchorUrl,
  owaspTitle,
} from "./owasp.js";
import { LOGO_LOCKUP_SVG, LOGO_MARK_SVG, REPORT_STYLES } from "./report-brand.js";
import { POST_LIMIT, REPORT_SCRIPT } from "./report-script.js";
import type {
  ActionCounts,
  DecidedCalls,
  ExampleShape,
  RecurringItem,
  RuleSource,
  ScanFinding,
  ScanResult,
  ScanSkipped,
} from "./scan-report.js";
import { formatCount, formatTokens, type TokenTotals, totalTokens } from "./tokens.js";
import type { AgentSource, GuardAction } from "./types.js";

/** Where the source lives. Rendered as text. */
export const REPOSITORY_URL = "https://github.com/agenttrailhq/guard";

/** The site every outbound link points at, through `siteLink`. */
export const SITE_URL = "https://www.agenttrail.sh";

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

/** The AgentTrail OS block, in Claude Code reports only. Wording lives here, not in markup. */
export const PRODUCT_NOTE = {
  eyebrow: "AgentTrail OS",
  heading:
    "AgentTrail Guard stops the mistake. AgentTrail OS remembers it and turns it into a rule.",
  body: "This report is one look at the transcripts on one machine. AgentTrail OS watches every agent session, turns each repeated mistake into a guardrail, and proves the fix on your own history. It is a separate product, and nothing in this report was sent to it.",
  primary: { label: "Book a team demo", path: "/agenttrail-os", content: "os-demo" },
  secondary: { label: "Guard vs OS", path: "/guard-vs-os", content: "os-compare" },
} as const;

/** Severities from most to least serious. Anything else ranks after all of them. */
export const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"] as const;

/**
 * A severity as the file shows it: one of `SEVERITY_ORDER`, or `unknown`.
 *
 * A guardrail the user wrote can carry any string as its severity. The file never shows that
 * text: it is not redacted, and `--review` does not list it.
 */
export function knownSeverity(severity: string): string {
  return (SEVERITY_ORDER as readonly string[]).includes(severity) ? severity : "unknown";
}

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
 * Every finding's matches, totalled by severity and by action — over ALL findings, not the
 * first `MAX_ROWS` the page lists. A tool call that matched two guardrails counts under each,
 * which is why the totals can exceed `riskyActions`. Shared by the report and the terminal
 * summary so both state the same numbers.
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
export function bySeverityThenCount<T extends Pick<ScanFinding, "severity" | "count" | "ruleId">>(
  findings: readonly T[],
): T[] {
  return [...findings].sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      b.count - a.count ||
      a.ruleId.localeCompare(b.ruleId),
  );
}

/**
 * How many findings and repeats the file carries before it stops.
 *
 * Exported because `scan --review` enumerates exactly what this file writes, and a second
 * copy of the cap would drift.
 */
export const MAX_ROWS = 50;
/** How many distinct shapes are carried under one finding. See {@link MAX_ROWS}. */
export const MAX_EXAMPLES = 3;
/** How many cards "Fix these first" shows. */
export const FIX_FIRST_MAX = 6;
/** How many guardrails each "What AgentTrail Guard would have done" column names. */
const TOP_PER_ACTION = 3;
/** Longest line of a wrapped description. Keeps every line of the file short. */
const DESCRIPTION_LINE = 160;

/**
 * When to suggest turning a few "ask" guardrails down to "warn": when at most
 * `TUNING_MAX_GUARDRAILS` of them produce at least `TUNING_MIN_SHARE` of all ask matches,
 * and there are at least `TUNING_MIN_ASKS` of those.
 */
export const TUNING_MAX_GUARDRAILS = 3;
export const TUNING_MIN_SHARE = 0.6;
export const TUNING_MIN_ASKS = 5;

/**
 * What the renderers need that a `ScanResult` cannot know about itself.
 *
 * There is deliberately NO path on this type: the default transcript root expands to a home
 * folder, which names the user. The terminal summary may print it; this file may not.
 */
export interface ReportMeta {
  /** The guard's own version. */
  readonly version: string;
  /** When the scan ran. */
  readonly generatedAt: Date;
}

/** Escape text for HTML, both quote forms included, so it is safe in text and attributes. */
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
  return agentDisplayName(agent);
}

/** A count and a noun phrase that agrees with it. */
function counted(n: number, one: string, many: string): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/**
 * The URL segment for a guardrail id on the site: lowercased, each run of other characters
 * one hyphen (`wt.reset-hard` becomes `wt-reset-hard`).
 */
export function ruleSlug(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * A link to the site, tagged with where it came from. The only way this file builds one.
 * The tags go before a `#fragment`, so a link to a row of a page keeps its query.
 */
export function siteLink(path: string, agent: AgentSource, content: string): string {
  const tags = `utm_source=guard&utm_medium=scan-report&utm_campaign=${agent}&utm_content=${content}`;
  const hash = path.indexOf("#");
  const base = hash === -1 ? path : path.slice(0, hash);
  const fragment = hash === -1 ? "" : path.slice(hash);
  return `${SITE_URL}${base}${base.includes("?") ? "&" : "?"}${tags}${fragment}`;
}

/** A full site URL as a path for `siteLink`. Throws on a URL that is not on the site. */
function sitePath(url: string): string {
  if (!url.startsWith(`${SITE_URL}/`)) throw new Error(`Not a page on the site: ${url}`);
  return url.slice(SITE_URL.length);
}

/** The site's row for one OWASP risk, tagged. */
function owaspRiskLink(id: OwaspId, agent: AgentSource): string {
  return siteLink(sitePath(owaspAnchorUrl(id)), agent, "owasp-risk");
}

/** A shipped guardrail's library page. */
function libraryLink(category: string, ruleId: string, agent: AgentSource): string {
  return siteLink(
    `/guardrails/${encodeURIComponent(category)}/${encodeURIComponent(ruleSlug(ruleId))}`,
    agent,
    "guardrail",
  );
}

/** Display names for the shipped packs. An unknown pack shows its id. */
const PACK_LABELS: Readonly<Record<string, string>> = {
  "working-tree": "Working tree",
  "destructive-data": "Destructive data",
  "prod-infra": "Production infrastructure",
  "secret-exposure": "Secret exposure",
  "rce-supply-chain": "Remote code and supply chain",
  "safety-bypass": "Safety bypass",
  "privilege-supply-chain": "Privileges and supply chain",
  "file-scope": "File scope",
  "agent-context": "Agent context",
  "test-integrity": "Test integrity",
  exfiltration: "Data leaving the machine",
};

/** The group a finding is listed under. A user's own guardrails share one fixed group. */
export const YOUR_GUARDRAILS = "Your guardrails";

/** The heading of a "Fix these first" card for a guardrail the user wrote. */
export const OWN_CARD_HEADING = "A guardrail you added";

/** A pack's display name. */
export function packLabel(category: string): string {
  return PACK_LABELS[category] ?? category;
}

/** Wrap prose into lines no longer than `width`, at spaces. A longer word keeps its own line. */
function wrapLines(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

// ── The projection ────────────────────────────────────────────────────────────

/** One finding as the file carries it. */
export interface PayloadFinding {
  readonly ruleId: string;
  readonly title: string;
  readonly severity: string;
  readonly action: GuardAction;
  readonly count: number;
  readonly source: RuleSource;
  /** Shipped guardrails only. */
  readonly category?: string;
  /** The shipped description, wrapped into short lines. Shipped guardrails only. */
  readonly descriptionLines?: readonly string[];
  readonly examples: readonly ExampleShape[];
  /** Distinct shapes beyond `examples` that are not carried. */
  readonly moreShapes: number;
  /** The guardrail's own OWASP ids. Empty for a guardrail that carries none. */
  readonly owasp: readonly OwaspId[];
}

/** Everything the file carries: the page renders it, and the data block and export are it. */
export interface ReportPayload {
  readonly tool: "agenttrail-guard";
  readonly version: string;
  readonly generatedAt: string;
  readonly catalog: string;
  readonly agent: AgentSource;
  readonly sessions: number;
  readonly projects: number;
  readonly quarantined: number;
  readonly notRead: number;
  readonly skippedLines: number;
  readonly toolCalls: number;
  readonly riskyActions: number;
  readonly riskyByAction: ActionCounts;
  /** Most serious first, at most `MAX_ROWS`. */
  readonly findings: readonly PayloadFinding[];
  readonly moreFindings: number;
  /** Most frequent first, at most `MAX_ROWS`. */
  readonly recurring: readonly RecurringItem[];
  readonly moreRecurring: number;
  readonly tokens: TokenTotals | null;
  readonly skipped?: ScanSkipped;
  readonly shareText: string;
  /** Per OWASP risk, over every finding, not only the rows the file lists. */
  readonly owasp: readonly OwaspTally[];
}

/** Token totals, copied field by field. */
function tokenCopy(t: TokenTotals): TokenTotals {
  return {
    input: t.input,
    output: t.output,
    cacheRead: t.cacheRead,
    cacheCreation: t.cacheCreation,
    cacheCreation5m: t.cacheCreation5m,
    cacheCreation1h: t.cacheCreation1h,
    turnsWithSplit: t.turnsWithSplit,
    turns: t.turns,
  };
}

/** One finding, copied field by field. Library text only for a library finding. */
function payloadFinding(finding: ScanFinding): PayloadFinding {
  const base = {
    ruleId: finding.ruleId,
    title: finding.title,
    severity: knownSeverity(finding.severity),
    action: finding.action,
    count: finding.count,
    examples: finding.examples
      .slice(0, MAX_EXAMPLES)
      .map((e) => ({ text: e.text, count: e.count })),
    moreShapes: Math.max(0, finding.examples.length - MAX_EXAMPLES),
    owasp: finding.owasp.filter((id) => isOwaspId(id)),
  };
  if (finding.source !== "library") return { ...base, source: "yours" };
  return {
    ...base,
    source: "library",
    ...(finding.category === undefined ? {} : { category: finding.category }),
    ...(finding.description === undefined
      ? {}
      : { descriptionLines: wrapLines(finding.description, DESCRIPTION_LINE) }),
  };
}

/**
 * Everything the file carries, and nothing else. See "What the file carries" in the header.
 *
 * Fields are copied one by one, never spread from the result, so a field added to
 * `ScanResult` reaches the file only when it is added here.
 */
export function reportPayload(result: ScanResult, meta: ReportMeta): ReportPayload {
  const ordered = bySeverityThenCount(result.findings);
  const payload: ReportPayload = {
    tool: "agenttrail-guard",
    version: meta.version,
    generatedAt: meta.generatedAt.toISOString(),
    catalog: formatCatalogStamp(catalogStamp(), meta.generatedAt),
    agent: result.agent,
    sessions: result.sessions,
    projects: result.projects,
    quarantined: result.quarantined,
    notRead: result.notRead,
    skippedLines: result.skippedLines,
    toolCalls: result.toolCalls,
    riskyActions: result.riskyActions,
    riskyByAction: {
      block: result.riskyByAction.block,
      require_approval: result.riskyByAction.require_approval,
      warn: result.riskyByAction.warn,
    },
    findings: ordered.slice(0, MAX_ROWS).map(payloadFinding),
    moreFindings: Math.max(0, result.findings.length - MAX_ROWS),
    recurring: result.recurring.slice(0, MAX_ROWS).map((r) => ({
      text: r.text,
      count: r.count,
      ruleId: r.ruleId,
      title: r.title,
    })),
    moreRecurring: Math.max(0, result.recurring.length - MAX_ROWS),
    tokens: result.tokens === null ? null : tokenCopy(result.tokens),
    shareText: shareText(result),
    owasp: result.owasp
      .filter((t) => isOwaspId(t.id))
      .map((t) => ({
        id: t.id,
        callCount: t.callCount,
        ruleMatches: t.ruleMatches,
        guardrailCount: t.guardrailCount,
      })),
  };
  const skipped = result.skipped;
  if (skipped === undefined) return payload;
  return {
    ...payload,
    skipped: {
      unreadableFiles: skipped.unreadableFiles,
      truncatedLastLines: skipped.truncatedLastLines,
      unparseableLines: skipped.unparseableLines,
      unknownRecords: skipped.unknownRecords,
      turnsEndedWithError: skipped.turnsEndedWithError,
      notActions: skipped.notActions,
      unmappedTools: skipped.unmappedTools.map((t) => ({ name: t.name, count: t.count })),
    },
  };
}

// ── Share text ────────────────────────────────────────────────────────────────

/** How X weighs a post: most text one per character, a link 23, plus the hashtag. */
export function postLength(text: string): number {
  let n = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const light =
      code <= 0x10ff ||
      (code >= 0x2000 && code <= 0x200d) ||
      (code >= 0x2010 && code <= 0x201f) ||
      (code >= 0x2032 && code <= 0x2037);
    n += light ? 1 : 2;
  }
  return n + 1 + 23 + 1 + "#agenttrail".length;
}

/** The library "would block" guardrail with the most matches, if any. Never a user's own. */
function topLibraryBlocker(result: ScanResult): ScanFinding | undefined {
  return result.findings
    .filter((f) => f.action === "block" && f.source === "library")
    .sort(
      (a, b) =>
        b.count - a.count ||
        severityRank(a.severity) - severityRank(b.severity) ||
        a.ruleId.localeCompare(b.ruleId),
    )[0];
}

/**
 * The prefilled post: totals, and the top blocked LIBRARY guardrail's title.
 *
 * Built from counts, the agent's display name and one shipped title — never a command, a
 * path, a project name, or a guardrail the user wrote, whose title can name internal things.
 * The user can edit it before posting.
 */
export function shareText(result: ScanResult): string {
  const { block, require_approval: ask, warn } = result.riskyByAction;
  const calls = counted(result.toolCalls, "tool call", "tool calls");
  const head = `I scanned ${calls} from ${agentName(result.agent)} with AgentTrail Guard`;
  const tail = ". Checked locally, nothing uploaded.";
  const top = topLibraryBlocker(result);

  const compose = (withTitle: boolean): string => {
    const parts: string[] = [];
    if (block > 0) {
      const detail =
        withTitle && top !== undefined
          ? ` (${formatCount(top.count)} of those: ${top.title.replace(/`/g, "")})`
          : "";
      parts.push(`${formatCount(block)} would block${detail}`);
    }
    if (ask > 0) parts.push(`${formatCount(ask)} would ask`);
    if (warn > 0) parts.push(`${formatCount(warn)} would warn`);
    const body = parts.length === 0 ? ": nothing matched a guardrail" : `: ${parts.join(" · ")}`;
    return `${head}${body}${tail}`;
  };

  const full = compose(true);
  return postLength(full) <= POST_LIMIT ? full : compose(false);
}

/** The Post-on-X link for a text. User text only ever sits inside the encoded parameter. */
export function shareLink(text: string, agent: AgentSource): string {
  const url = siteLink("/agenttrail-guard", agent, "share");
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}&hashtags=agenttrail`;
}

// ── Small pieces ──────────────────────────────────────────────────────────────

/**
 * What a scan read but could not use, as counted phrases. Empty when there is none.
 *
 * Shared by the report and the terminal summary, so both say the same thing.
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

/** What AgentTrail Guard would have done, in words rather than in the engine's vocabulary. */
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

/** An outbound link: a new browsing context, no opener, no referrer. */
function outLink(url: string, text: string, className?: string): string {
  const cls = className === undefined ? "" : ` class="${className}"`;
  return `<a${cls} href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
}

/**
 * A command with a copy button. The button stays hidden until the page script runs. Its
 * visible text is "Copy"; `name` is its accessible name, fixed text that starts with "Copy"
 * and tells the buttons apart.
 */
function copyable(id: string, command: string, name: string): string {
  return `<div class="command"><code id="${escapeHtml(id)}">${escapeHtml(command)}</code><button type="button" class="copy js-only" data-copy="${escapeHtml(id)}" data-label="Copy" aria-label="${escapeHtml(name)}" hidden>Copy</button></div>`;
}

/** One `<div class="stat">`. The class names are part of what the tests read. */
function stat(value: string, label: string, note?: string): string {
  const noteHtml = note === undefined ? "" : `<div class="stat-note">${escapeHtml(note)}</div>`;
  return `<div class="stat"><div class="stat-value">${escapeHtml(value)}</div><div class="stat-label">${escapeHtml(label)}</div>${noteHtml}</div>`;
}

/** The first sentence of a description, for a card. */
function firstSentence(lines: readonly string[]): string {
  const text = lines.join(" ");
  const end = text.search(/\.(\s|$)/);
  return end === -1 ? text : text.slice(0, end + 1);
}

/**
 * Shipped library text, quoted as written: escaped, `backticked` spans as code, and wrapped at
 * spaces so no line of the file is long. Marked `library-text` because, like a command, it is
 * quoted rather than written by the report: a description may show a shell variable such as
 * `$DIR` to state what its guardrail misses.
 */
function libraryText(text: string, className = "library-text"): string {
  const html = wrapLines(inlineTitle(text), DESCRIPTION_LINE).join("\n");
  return `<p class="${className}">${html}</p>`;
}

// ── Sections ──────────────────────────────────────────────────────────────────

/**
 * The one-line headline, from tool calls by their strictest action.
 *
 * One function, so a later headline can be put in front of it with this as the fallback.
 */
export function headline(result: ScanResult): string {
  if (result.toolCalls === 0) {
    return result.sessions === 0 ? "No sessions found to scan" : "No tool calls found to scan";
  }
  const { block, require_approval: ask, warn } = result.riskyByAction;
  const actions = (n: number): string => counted(n, "action", "actions");
  if (block > 0 && ask > 0) {
    return `AgentTrail Guard would have stopped ${actions(block)} and asked you about ${formatCount(ask)} more`;
  }
  if (block > 0) return `AgentTrail Guard would have stopped ${actions(block)}`;
  if (ask > 0) return `AgentTrail Guard would have asked you about ${actions(ask)}`;
  if (warn > 0) return `AgentTrail Guard would have warned you about ${actions(warn)}`;
  return "Nothing in these sessions matched a guardrail";
}

/** The top bar: the mark, the section links, and the export and theme controls. */
function topBar(payload: ReportPayload): string {
  const scanned = payload.toolCalls > 0;
  const links: [string, string][] = [
    ["overview", "Overview"],
    ...(scanned ? [["fix-first", "Fix first"] as [string, string]] : []),
    ...(payload.owasp.length > 0 ? [["owasp", "OWASP"] as [string, string]] : []),
    ...(scanned ? [["findings", "All findings"] as [string, string]] : []),
    ["next-steps", "Next steps"],
    ["privacy", "Privacy"],
  ];
  const nav = links.map(([id, label]) => `<li><a href="#${id}">${label}</a></li>`).join("\n");
  // The controls need the page script. They are written into both variants so the two
  // bodies stay identical, and stay `hidden` where no script runs.
  const controls = `<div class="toolbar">
<button type="button" id="print-button" class="tool js-only" hidden>PDF</button>
<button type="button" id="export-button" class="tool js-only" hidden>JSON</button>
<button type="button" id="theme-toggle" class="tool js-only" hidden>Theme</button>
</div>`;
  return `<header class="masthead">
<div class="brand" role="img" aria-label="AgentTrail">${LOGO_LOCKUP_SVG}</div>
<span class="product-tag">Guard</span>
<nav class="sections" aria-label="Report sections"><ul>
${nav}
</ul></nav>
${controls}
</header>`;
}

/**
 * Where this page came from — the part the two variants do not share.
 *
 * The standalone file was produced on the reader's own machine. A published copy was produced
 * on the PUBLISHER's machine and put on claude.ai by them, so "nothing uploaded" would be
 * false there and it says what happened instead. Both keep the qualified claim about the scan
 * itself: it made no network call, crash reporting being the one exception in this tool.
 */
function provenance(result: ScanResult, meta: ReportMeta, variant: ReportVariant): string {
  const stamp = `Generated ${escapeHtml(meta.generatedAt.toISOString())} by agenttrail-guard ${escapeHtml(meta.version)}`;
  if (variant === "artifact") {
    return `${stamp} on the publisher&#39;s own machine, from their own ${escapeHtml(agentName(result.agent))} transcripts. The scan itself made no network call &mdash; crash reporting is the one exception anywhere in this tool, off unless turned on, and a scan never uses it. This copy was published to claude.ai by the person who ran it, through Claude Code.`;
  }
  return `${stamp}. Produced entirely on this machine from transcripts already on disk &mdash; no account, nothing uploaded, and no network call: the one exception anywhere in this tool is crash reporting, which is off unless you turn it on and which a scan never uses.`;
}

/** The most serious library match for the hero, or a neutral line for a user's own. */
function mostSerious(payload: ReportPayload): string | undefined {
  if (payload.findings.length === 0) return undefined;
  const library = payload.findings.find((f) => f.source === "library");
  if (library === undefined) {
    return `<p class="top-match">Most serious match: a guardrail you added</p>`;
  }
  return `<p class="top-match">Most serious match: ${severityBadge(library.severity)} <span class="top-title">${inlineTitle(library.title)}</span></p>`;
}

/** What a scan that read no tool calls says instead of a result. */
function emptyLead(result: ScanResult): string {
  const read =
    result.sessions === 0
      ? `The scan found no ${agentName(result.agent)} sessions to read`
      : `The scan read ${counted(result.sessions, "session", "sessions")} with no tool calls in them`;
  return `${read}, so nothing was checked. This is not a clean result: check that the folder and the agent are the ones you meant, then scan again.`;
}

/** The hero: where it came from, the headline, the numbers, and what to do next. */
function heroSection(
  result: ScanResult,
  payload: ReportPayload,
  meta: ReportMeta,
  variant: ReportVariant,
): string {
  const origin =
    variant === "artifact"
      ? "Scanned locally &middot; published by the person who ran it"
      : "Scanned locally &middot; nothing uploaded";
  const t = result.tokens;
  const cells = [
    stat(formatCount(result.sessions), result.sessions === 1 ? "session" : "sessions"),
    stat(formatCount(result.toolCalls), "tool calls"),
    stat(formatCount(result.riskyActions), "risky actions"),
    stat(formatCount(result.recurring.length), "recurring mistakes"),
  ];
  if (result.toolCalls > 0) {
    const clean = Math.floor(((result.toolCalls - result.riskyActions) / result.toolCalls) * 100);
    cells.push(stat(`${clean}%`, "matched no guardrail"));
  }
  // A scan that read no tool calls has no token count worth a tile.
  if (t !== null && result.toolCalls > 0) {
    cells.push(
      stat(
        formatTokens(totalTokens(t)),
        "tokens",
        `${formatTokens(t.cacheRead)} cache reads (cumulative)`,
      ),
    );
  }
  const fixTarget = payload.findings.some((f) => f.action === "block") ? "fix-first" : "findings";
  const top = mostSerious(payload);
  const next =
    result.toolCalls === 0
      ? `<p class="lead">${escapeHtml(emptyLead(result))}</p>
<p class="provenance">${provenance(result, meta, variant)}</p>
${copyable("cmd-scan-hero", `agenttrail-guard scan --agent ${result.agent} --dir <folder>`, "Copy the scan command")}
<p class="note">Leave out --dir to read the folder ${escapeHtml(agentName(result.agent))} uses by default.</p>`
      : `<p class="lead">What your coding agent actually did, and which guardrails would have fired.</p>
<p class="provenance">${provenance(result, meta, variant)}</p>${top === undefined ? "" : `\n${top}`}
<div class="actions">
<a class="button" href="#${fixTarget}">See what to fix first</a>
${outLink(shareLink(payload.shareText, result.agent), "Share on X", "button secondary")}
</div>
${copyable("cmd-init-hero", `agenttrail-guard init --agent ${result.agent}`, "Copy the init command")}`;
  return `<section class="intro" id="overview">
<p class="origin">${origin}</p>
<p class="agent">Agent: ${escapeHtml(agentName(result.agent))}</p>
<h1>${escapeHtml(headline(result))}</h1>
${next}
</section>
<section class="stats" aria-label="Summary">
${cells.join("\n")}
</section>`;
}

/** What each action means for the agent. */
const ACTION_MEANING: Readonly<Record<GuardAction, string>> = {
  block: "The command does not run, and the agent is told which guardrail stopped it.",
  require_approval: "The command waits until you allow or deny it.",
  warn: "The command runs, and the agent is shown which guardrail it matched.",
};

/**
 * What "would ask" meant on an app that cannot ask.
 *
 * The label names the guardrail's own action, so it stays "would ask" everywhere. On Codex a
 * hook has no way to reach a person, so the answer sent is a block. Only when a
 * require-approval guardrail actually matched.
 */
function askOnCodexNote(result: ScanResult, byAction: readonly { action: string }[]): string {
  if (result.agent !== "codex") return "";
  if (!byAction.some((a) => a.action === "require_approval")) return "";
  return `\n<p class="note"><strong>On Codex, &ldquo;would ask&rdquo; means the action would have been stopped.</strong> Codex gives a guardrail no way to ask you, so AgentTrail Guard sends those as a block. The label above is the guardrail&#39;s own decision, kept the same across apps so one guardrail reads the same way everywhere.</p>`;
}

/** The ask guardrails worth turning down, when a few of them produce most of the asks. */
export interface TuningHint {
  readonly ids: readonly string[];
  readonly share: number;
  readonly asks: number;
  readonly remaining: number;
}

/** Tool calls each guardrail decided at `action`: its count in that action's column. */
function decidedBy(decided: readonly DecidedCalls[], action: GuardAction): Map<string, number> {
  const out = new Map<string, number>();
  for (const group of decided) {
    if (group.action !== action) continue;
    for (const id of group.ruleIds) out.set(id, (out.get(id) ?? 0) + group.calls);
  }
  return out;
}

/**
 * Up to `TUNING_MAX_GUARDRAILS` ask guardrails that, set to warn, would remove at least
 * `TUNING_MIN_SHARE` of the asks, when there are at least `TUNING_MIN_ASKS`.
 *
 * Counted in tool calls whose strictest action was ask, the basis of the "Asked you first"
 * column. A call stops being an ask only when every guardrail that asked on it is set to
 * warn, so a guardrail whose asks were all on calls another guardrail blocked or asked
 * anyway removes nothing and is never offered. Only guardrails the file carries are
 * considered, so `--review` lists every id the hint names.
 */
export function tuningHint(
  decided: readonly DecidedCalls[],
  carried: readonly PayloadFinding[],
): TuningHint | undefined {
  const asks = decided.filter((group) => group.action === "require_approval");
  const total = asks.reduce((sum, group) => sum + group.calls, 0);
  if (total < TUNING_MIN_ASKS) return undefined;
  const askers = new Set(
    carried.filter((f) => f.action === "require_approval").map((f) => f.ruleId),
  );
  const own = new Map([...decidedBy(asks, "require_approval")].filter(([id]) => askers.has(id)));
  const removed = (ids: ReadonlySet<string>): number =>
    asks.reduce((sum, g) => (g.ruleIds.every((id) => ids.has(id)) ? sum + g.calls : sum), 0);

  // Greedily add the guardrail that removes the most asks with those already chosen.
  const chosen = new Set<string>();
  while (chosen.size < TUNING_MAX_GUARDRAILS && removed(chosen) / total < TUNING_MIN_SHARE) {
    let best: { id: string; gain: number; calls: number } | undefined;
    for (const [id, calls] of own) {
      if (chosen.has(id)) continue;
      const gain = removed(new Set([...chosen, id]));
      if (
        best === undefined ||
        gain > best.gain ||
        (gain === best.gain && (calls > best.calls || (calls === best.calls && id < best.id)))
      ) {
        best = { id, gain, calls };
      }
    }
    if (best === undefined) break;
    chosen.add(best.id);
  }
  const drop = removed(chosen);
  if (drop / total < TUNING_MIN_SHARE) return undefined;
  // Drop any choice the others make unnecessary, so every command offered removes asks.
  for (const id of [...chosen]) {
    const without = new Set([...chosen].filter((other) => other !== id));
    if (removed(without) === drop) chosen.delete(id);
  }
  return {
    ids: [...chosen].sort((a, b) => (own.get(b) ?? 0) - (own.get(a) ?? 0) || a.localeCompare(b)),
    share: drop / total,
    asks: total,
    remaining: total - drop,
  };
}

/** An id that a shell reads as one plain word. */
export const SHELL_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The tuning hint's markup. */
function tuningSection(result: ScanResult, payload: ReportPayload): string {
  const hint = tuningHint(result.decided, payload.findings);
  if (hint === undefined) return "";
  const n = hint.ids.length;
  const pct = Math.round(hint.share * 100);
  // A copyable command only for an id that is safe to paste into a shell. A user's own id is
  // any string, so one that is not gets named as text, with no command to copy.
  const commands = hint.ids
    .map((id, i) =>
      SHELL_SAFE_ID.test(id)
        ? copyable(
            `cmd-tune-${i}`,
            `agenttrail-guard guardrails set-action ${id} warn`,
            `Copy set-action command ${i + 1}`,
          )
        : `<p class="note">Set <code>${escapeHtml(id)}</code> to warn with <code>agenttrail-guard guardrails set-action</code>. Its id has characters a shell would read, so no command is offered to copy.</p>`,
    )
    .join("\n");
  return `<div class="hint">
<p><strong>${escapeHtml(counted(n, "guardrail accounts", "guardrails account"))} for ${pct}% of the asks.</strong> Setting ${n === 1 ? "it" : "them"} to warn would take the tool calls you are asked about from ${escapeHtml(formatCount(hint.asks))} to ${escapeHtml(formatCount(hint.remaining))}, and the agent would be shown a warning on those calls instead.</p>
${commands}
</div>`;
}

/** Three columns, one per action, then the severity tally. */
function wouldHaveDoneSection(result: ScanResult, payload: ReportPayload): string {
  if (result.findings.length === 0) return "";
  const columns = ACTION_ORDER.map((action) => {
    const count = result.riskyByAction[action];
    // Each guardrail's tool calls in this column: the calls it decided, as the count above
    // counts them. A guardrail whose matches all landed on stricter calls is not listed.
    const calls = decidedBy(result.decided, action);
    const top = payload.findings
      .filter((f) => f.action === action && (calls.get(f.ruleId) ?? 0) > 0)
      .map((f) => ({ f, n: calls.get(f.ruleId) ?? 0 }))
      .sort((a, b) => b.n - a.n || a.f.ruleId.localeCompare(b.f.ruleId))
      .slice(0, TOP_PER_ACTION)
      .map(
        ({ f, n }) =>
          `<li><span class="col-title">${inlineTitle(f.title)}</span><span class="times">${escapeHtml(formatCount(n))}&times;</span></li>`,
      )
      .join("\n");
    const label = { block: "Blocked", require_approval: "Asked you first", warn: "Warned" }[action];
    return `<div class="col ${actionClass(action)}-col">
<p class="col-label">${label}</p>
<p class="col-count">${escapeHtml(formatCount(count))}</p>
<p class="note">${escapeHtml(ACTION_MEANING[action])}</p>${top === "" ? "" : `\n<ul class="col-list">\n${top}\n</ul>`}
</div>`;
  }).join("\n");

  const { byAction } = matchTally(result);
  // Over every finding, as the summary counts them, with each severity shown as the file
  // shows it: a user's own severity text is folded into `unknown`.
  const severityCounts = new Map<string, number>();
  for (const s of matchTally(result).bySeverity) {
    const key = knownSeverity(s.severity);
    severityCounts.set(key, (severityCounts.get(key) ?? 0) + s.count);
  }
  const bySeverity = [...severityCounts].map(([severity, count]) => ({ severity, count }));
  const item = (label: string, count: number): string =>
    `<li>${label}<span class="tally-count">${escapeHtml(formatCount(count))}</span></li>`;
  const severities = bySeverity.map((s) => item(severityBadge(s.severity), s.count)).join("\n");
  const actions = byAction.map((a) => item(actionChip(a.action), a.count)).join("\n");

  return `<section id="would-do">
<h2>What AgentTrail Guard would have done</h2>
<p class="note">Tool calls, each counted once under the strictest guardrail it matched.</p>
<div class="columns">
${columns}
</div>${askOnCodexNote(result, byAction)}
${tuningSection(result, payload)}
<div class="tally" role="group" aria-label="Guardrail matches">
<div class="tally-group"><p class="tally-label">Matches by severity</p><ul class="pills">
${severities}
</ul></div>
<div class="tally-group"><p class="tally-label">Matches by action</p><ul class="pills">
${actions}
</ul></div>
<p class="note">Each guardrail counts its own matches, so a tool call that matched two guardrails is counted under both, and these totals can be larger than the number of risky actions.</p>
</div>
</section>`;
}

/** The guardrails that would block outright, most serious first. */
function fixFirstSection(payload: ReportPayload): string {
  const blocking = payload.findings.filter((f) => f.action === "block").slice(0, FIX_FIRST_MAX);
  if (blocking.length === 0) {
    return `<section id="fix-first"><h2>Fix these first</h2><p class="empty">No guardrail would have blocked anything in these sessions.</p></section>`;
  }
  const cards = blocking
    .map((f) => {
      const index = payload.findings.indexOf(f);
      // A guardrail the user wrote gets a fixed heading. Its own title follows as plain text
      // and its id in the meta line, so text the user wrote is never a heading.
      const yours = f.source !== "library";
      const heading = yours ? OWN_CARD_HEADING : inlineTitle(f.title);
      const why = yours
        ? `\n<p class="own-title">${inlineTitle(f.title)}</p>`
        : f.descriptionLines === undefined
          ? ""
          : `\n${libraryText(firstSentence(f.descriptionLines), "library-text note")}`;
      const example = f.examples[0];
      const exampleHtml =
        example === undefined
          ? ""
          : `\n<p class="example"><code>${escapeHtml(example.text)}</code></p>`;
      const group = f.category === undefined ? YOUR_GUARDRAILS : packLabel(f.category);
      const link =
        f.category === undefined
          ? ""
          : `\n<p>${outLink(libraryLink(f.category, f.ruleId, payload.agent), "How this guardrail works")}</p>`;
      return `<article class="card">
<div class="card-head">${severityBadge(f.severity)} ${actionChip(f.action)}<span class="times">${escapeHtml(formatCount(f.count))}&times;</span></div>
<h3><a href="#finding-${index}">${heading}</a></h3>${why}${exampleHtml}
<p class="card-meta">${escapeHtml(group)} &middot; <code>${escapeHtml(f.ruleId)}</code></p>${link}
</article>`;
    })
    .join("\n");
  return `<section id="fix-first">
<h2>Fix these first</h2>
<p class="note">The guardrails that would have stopped a command outright, most serious first.</p>
<div class="cards">
${cards}
</div>
</section>`;
}

/** An OWASP id and its name, as the page shows it. */
function riskLabel(id: OwaspId): string {
  return `<span class="risk-id">${escapeHtml(id)}</span> ${escapeHtml(owaspTitle(id))}`;
}

/** The OWASP risks the matched guardrails name, or nothing when no matched guardrail carries an id. */
function owaspSection(payload: ReportPayload): string {
  if (payload.owasp.length === 0) return "";
  const touched = (list: readonly { readonly id: string }[]): number =>
    payload.owasp.filter((t) => list.some((risk) => risk.id === t.id)).length;
  const summary = `These matches touched ${touched(OWASP_AGENTIC)} of ${OWASP_AGENTIC.length} agentic and ${touched(OWASP_LLM)} of ${OWASP_LLM.length} LLM risks.`;
  const risks = payload.owasp
    .map(
      (t) => `<li class="risk" id="risk-${escapeHtml(t.id.toLowerCase())}">
<p class="risk-name">${outLink(owaspRiskLink(t.id, payload.agent), riskLabel(t.id))}</p>
<p class="risk-counts">${escapeHtml(counted(t.callCount, "tool call", "tool calls"))} &middot; ${escapeHtml(counted(t.guardrailCount, "guardrail", "guardrails"))}</p>
<button type="button" class="tool js-only" data-risk="${escapeHtml(t.id)}" aria-label="Show its findings: ${escapeHtml(t.id)}" hidden>Show its findings</button>
</li>`,
    )
    .join("\n");
  return `<section id="owasp">
<h2>OWASP risks</h2>
<p class="lead">${escapeHtml(summary)}</p>
<ul class="risks">
${risks}
</ul>
<p class="note">A guardrail can name more than one risk, and a tool call can match more than one guardrail, so one tool call can count under several risks. These counts do not add up to the totals above.</p>
<p class="note">Covers coding-agent actions only, not full OWASP coverage. Each id names a risk where it becomes a command or a file change, and is never a claim that a guardrail covers the whole risk.</p>
<p class="risk-sources">${outLink(siteLink(sitePath(OWASP_PAGE_URL), payload.agent, "owasp"), "How the guardrails map to OWASP")} &middot; ${outLink(OWASP_SOURCES.agentic, "OWASP Top 10 for Agentic Applications")} &middot; ${outLink(OWASP_SOURCES.llm, "OWASP Top 10 for LLM Applications")}</p>
</section>`;
}

/** Rank maps for the sort control, computed here so the script reads numbers only. */
function ranks(findings: readonly PayloadFinding[]): {
  category: Map<PayloadFinding, number>;
  count: Map<PayloadFinding, number>;
  name: Map<PayloadFinding, number>;
} {
  const group = (f: PayloadFinding): string =>
    f.category === undefined ? `~${YOUR_GUARDRAILS}` : packLabel(f.category);
  const rankBy = (cmp: (a: PayloadFinding, b: PayloadFinding) => number) =>
    new Map([...findings].sort(cmp).map((f, i) => [f, i]));
  return {
    category: rankBy(
      (a, b) => group(a).localeCompare(group(b)) || findings.indexOf(a) - findings.indexOf(b),
    ),
    count: rankBy((a, b) => b.count - a.count || findings.indexOf(a) - findings.indexOf(b)),
    name: rankBy((a, b) => a.title.localeCompare(b.title) || a.ruleId.localeCompare(b.ruleId)),
  };
}

/** One row of All findings. */
function findingRow(
  f: PayloadFinding,
  index: number,
  r: ReturnType<typeof ranks>,
  agent: AgentSource,
): string {
  const group = f.category === undefined ? YOUR_GUARDRAILS : packLabel(f.category);
  const examples = f.examples
    .map(
      (example) =>
        `<li><code>${escapeHtml(example.text)}</code><span class="times">${escapeHtml(formatCount(example.count))}&times;</span></li>`,
    )
    .join("\n");
  const more =
    f.moreShapes > 0
      ? `\n<li class="more">and ${escapeHtml(formatCount(f.moreShapes))} more shapes</li>`
      : "";
  const shapes = counted(f.examples.length + f.moreShapes, "command shape", "command shapes");
  const how =
    f.descriptionLines === undefined
      ? ""
      : `\n<details class="how"><summary>How this guardrail decides, and what it misses</summary>
${libraryText(f.descriptionLines.join(" "))}
<p>${outLink(libraryLink(f.category ?? "", f.ruleId, agent), "Open it in the guardrail library")}</p>
</details>`;
  const risks =
    f.owasp.length === 0
      ? ""
      : `\n<ul class="owasp-ids" aria-label="OWASP risks">
${f.owasp.map((id) => `<li>${outLink(owaspRiskLink(id, agent), riskLabel(id))}</li>`).join("\n")}
</ul>`;
  const riskData = f.owasp.length === 0 ? "" : ` data-owasp="${escapeHtml(f.owasp.join(" "))}"`;
  return `<li class="finding" id="finding-${index}" data-action="${escapeHtml(f.action)}"${riskData} data-rank-serious="${index}" data-rank-category="${r.category.get(f) ?? index}" data-rank-count="${r.count.get(f) ?? index}" data-rank-name="${r.name.get(f) ?? index}">
<div class="finding-head">
<div class="guardrail-title">${inlineTitle(f.title)}</div>
<div class="finding-meta">${severityBadge(f.severity)} ${actionChip(f.action)}<span class="num" data-label="Matches">${escapeHtml(formatCount(f.count))}&times;</span></div>
</div>
<div class="guardrail-id"><code>${escapeHtml(f.ruleId)}</code> &middot; <span class="group">${escapeHtml(group)}</span></div>${risks}
<details class="commands"><summary>The ${escapeHtml(shapes)} behind it</summary>
<ul class="shapes">
${examples}${more}
</ul>
</details>${how}
</li>`;
}

/** The OWASP risk filter, with a leading line break, or nothing when no risk was touched. */
function riskFilter(payload: ReportPayload): string {
  if (payload.owasp.length === 0) return "";
  const options = payload.owasp
    .map(
      (t) =>
        `<option value="${escapeHtml(t.id)}">${escapeHtml(`${t.id} ${owaspTitle(t.id)}`)}</option>`,
    )
    .join("\n");
  return `
<label class="sort">OWASP risk <select id="risk-filter">
<option value="">Any risk</option>
${options}
</select></label>`;
}

/** All findings: one row per guardrail, most serious first, with filters and sort. */
function findingsSection(payload: ReportPayload, variant: ReportVariant): string {
  if (payload.findings.length === 0) {
    return `<section id="findings"><h2>All findings</h2><p class="empty">No guardrail matched anything in these sessions.</p></section>`;
  }
  const r = ranks(payload.findings);
  const rows = payload.findings.map((f, i) => findingRow(f, i, r, payload.agent)).join("\n");
  const truncated =
    payload.moreFindings > 0
      ? `\n<p class="note">${escapeHtml(formatCount(payload.moreFindings))} further guardrails matched and are not listed here.</p>`
      : "";
  const filters = [
    ["all", "All"],
    ["block", "Would block"],
    ["require_approval", "Would ask"],
    ["warn", "Would warn"],
  ]
    .map(
      ([value, label]) =>
        `<button type="button" class="filter" data-filter="${value}" aria-pressed="${value === "all" ? "true" : "false"}">${label}</button>`,
    )
    .join("\n");
  const matched = counted(
    payload.findings.length + payload.moreFindings,
    "guardrail matched",
    "guardrails matched",
  );
  return `<section id="findings" class="findings-section">
<div class="section-head"><h2>All findings</h2><p class="section-meta" id="findings-count">${escapeHtml(matched)}</p></div>${variant === "artifact" ? `\n<p class="note artifact-note">Open the downloaded file for filters, sort and export.</p>` : ""}
<div class="controls js-only" hidden>
<div class="filters" role="group" aria-label="Show findings">
${filters}
</div>
<label class="sort">Sort <select id="sort">
<option value="serious">Most serious</option>
<option value="category">Category</option>
<option value="count">Most matches</option>
<option value="name">Name</option>
</select></label>${riskFilter(payload)}
</div>
<p id="findings-status" class="sr-only" role="status" aria-live="polite"></p>
<ol class="finding-list">
${rows}
</ol>
<div class="filter-empty" id="findings-empty" hidden><p>No findings match these filters.</p><button type="button" class="tool" id="clear-filters">Show all findings</button></div>${truncated}
</section>`;
}

/** Repeat offenders: the same command shape more than once. */
function recurringSection(payload: ReportPayload): string {
  if (payload.recurring.length === 0) {
    return `<section id="repeats"><h2>Repeat offenders</h2><p class="empty">Nothing matched more than once.</p></section>`;
  }
  const rows = payload.recurring
    .map((item) => {
      const index = payload.findings.findIndex((f) => f.ruleId === item.ruleId);
      const title = inlineTitle(item.title);
      const named = index === -1 ? title : `<a href="#finding-${index}">${title}</a>`;
      return `<tr role="row"><td class="shape" role="cell"><code>${escapeHtml(item.text)}</code></td><td class="num" role="cell">${escapeHtml(formatCount(item.count))}&times;</td><td class="rule-name" role="cell">${named}</td></tr>`;
    })
    .join("\n");
  return `<section id="repeats"><h2>Repeat offenders</h2>
<p class="note">The same shape, seen more than once. Paths are redacted before counting, so many different paths under one command become one repeat.</p>
<div class="table-wrap"><table class="recurring" role="table">
<thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Command shape</th><th scope="col" class="num" role="columnheader">Times</th><th scope="col" role="columnheader">Guardrail</th></tr></thead>
<tbody role="rowgroup">
${rows}
</tbody>
</table></div>
</section>`;
}

/** Three steps, each with a command to copy, and where to read more. */
function nextStepsSection(result: ScanResult): string {
  const a = result.agent;
  return `<section id="next-steps">
<h2>Next steps</h2>
<ol class="steps">
<li><p><strong>Turn on AgentTrail Guard</strong> so these guardrails run before each command.</p>
${copyable("cmd-init", `agenttrail-guard init --agent ${a}`, "Copy the step 1 command")}</li>
<li><p><strong>See what it is doing</strong>: whether it is on, and what it decided recently.</p>
${copyable("cmd-status", "agenttrail-guard status", "Copy the step 2 command")}</li>
<li><p><strong>Scan again next week</strong>, and read every line before the report is written.</p>
${copyable("cmd-scan-again", `agenttrail-guard scan --agent ${a} --review`, "Copy the step 3 command")}</li>
</ol>
<ul class="links">
<li>${outLink(siteLink("/get-started/guard", a, "next-commands"), "Every command")}</li>
<li>${outLink(siteLink("/guardrails", a, "next-library"), "The guardrail library")}</li>
<li>${outLink(siteLink("/get-started/guard", a, "next-agents"), "Set up Cursor or Codex")}</li>
</ul>
</section>`;
}

/** The post preview: totals only, editable, with a count and a plain link to X. */
function shareSectionHtml(
  result: ScanResult,
  payload: ReportPayload,
  variant: ReportVariant,
): string {
  const length = postLength(payload.shareText);
  // A published copy runs no script, so an edit there would not reach the post: it is shown
  // read-only, and the downloaded file is where to edit it.
  const editable = variant === "document";
  const edit = editable
    ? "Edit it before posting."
    : "This copy cannot change the post: open the downloaded report to edit it.";
  return `<section id="share" class="share">
<h2>Share your result</h2>
<p class="note share-note">Totals and at most one library guardrail&#39;s name: no commands, paths, project names or guardrails you wrote. ${edit}</p>
<label class="share-label" for="share-text">Post preview</label>
<textarea id="share-text" rows="4"${editable ? "" : " readonly"}>${escapeHtml(payload.shareText)}</textarea>
<p class="share-actions"><span id="share-count" class="share-count" data-over="${length > POST_LIMIT ? "true" : "false"}">${escapeHtml(`${length} / ${POST_LIMIT}`)}</span>
<a id="share-link" class="button" href="${escapeHtml(shareLink(payload.shareText, result.agent))}" target="_blank" rel="noopener noreferrer">Post on X</a>
<button type="button" class="copy js-only" data-copy="share-text" data-label="Copy text" aria-label="Copy text of the post" hidden>Copy text</button></p>
</section>`;
}

/** "Before you share this": what the placeholders stand for, and the limit of redaction. */
function beforeYouShareSection(result: ScanResult, variant: ReportVariant): string {
  const review = `<code>agenttrail-guard scan --agent ${escapeHtml(result.agent)} --review</code>`;
  const check =
    variant === "artifact"
      ? `Redaction is thorough but not a guarantee. Read the findings before passing this page on; the person who published it can check every line with ${review} before the file is written.`
      : `Redaction is thorough but not a guarantee. Read the findings before posting this anywhere public, and run ${review} to see every line before the file is written.`;
  return `<section class="callout" id="privacy">
<h2>Before you share this</h2>
<p class="note">This report was made on one machine from transcripts already on its disk, and the scan sent nothing anywhere.</p>
<p class="note">Every command below has been through a secret scrubber, a path redactor, a pass for secret-named values and long random-looking strings, and an identifier redactor, and every MCP tool call has had its payload values structurally redacted. Redaction runs before anything is written, so this file has never held the original text.</p>
<dl class="legend">
<div><dt><code>&lt;path&gt;</code></dt><dd>stands for a redacted filesystem path or URL</dd></div>
<div><dt><code>&lt;name&gt;</code> <code>&lt;host&gt;</code> <code>&lt;user&gt;</code> <code>&lt;message&gt;</code> <code>&lt;comment&gt;</code></dt><dd>stand for an identifying operand of a command &mdash; a container, a namespace, a machine, a login, a commit message or heredoc body, a shell comment</dd></div>
<div><dt><code>&lt;value&gt;</code></dt><dd>stands for a redacted MCP payload value</dd></div>
<div><dt><code>[REDACTED:&hellip;]</code></dt><dd>stands for a redacted secret; <code>[REDACTED:secret:generic]</code> marks a long random-looking string masked on a best guess</dd></div>
<div><dt><code>&hellip;</code></dt><dd>marks where a long command was shortened for display</dd></div>
</dl>
<p class="warning">${check}</p>
<p class="note pdf-tip"><strong>Saving as PDF?</strong> Turn off headers and footers in the print dialog, so the file&rsquo;s location on your disk is not printed on every page.</p>
</section>`;
}

/**
 * How redaction works and where it can miss: the limits stated, not left to be discovered.
 *
 * Paths and working directories are redacted structurally, so "appear nowhere" holds.
 * Identifying names are removed for a fixed list of commands, a deny-list that cannot be
 * proved complete, and the section says so.
 */
function redactionSection(): string {
  return `<section id="redaction"><h2>How redaction works and where it can miss</h2>
<p class="note">Working directories and file paths appear nowhere in this file, and the projects these sessions came from are carried as a count and never as names.</p>
<p class="note"><strong>Identifying names are a weaker claim than paths, and the difference is worth knowing.</strong> Shell commands go through an identifier redactor keyed to a fixed list of tools &mdash; container runtimes, <code>kubectl</code> (including resource names), the database clients (host, database, and the SQL handed to <code>-c</code> / <code>-e</code>), <code>ssh</code>, <code>git</code> commit messages and identity settings, 1Password&#39;s <code>op</code> (item and vault names), and <code>gh</code> titles and bodies &mdash; plus, in any command, a secret passed as a flag value (<code>--token</code>, <code>--password</code>, <code>--key</code>), a UUID, the body of a heredoc, and the text of a <code>#</code> comment. That list is a deny-list and will miss the tool nobody thought of, so a bare operand naming a resource for a tool not on it can survive.</p>
<p class="note">Cloud account identifiers are redacted where a name or flag gives them away: <code>CLOUDFLARE_ACCOUNT_ID</code> and <code>--account-id</code>, <code>wrangler</code> commands, AWS account numbers after <code>--account</code> or inside an ARN, and <code>--project</code> for <code>gcloud</code>, <code>gsutil</code>, <code>bq</code> and <code>firebase</code>.</p>
<p class="note"><strong>Secrets without a known format are caught by name and by shape, and both are guesses.</strong> A value after a name ending in <code>_KEY</code> or <code>-key</code>, an <code>Authorization</code> header, and any long random-looking string of 32 or more characters is masked. A secret that is shorter, that is only hexadecimal and has no revealing name, that is split by punctuation, or that has no name and is followed by a <code>.</code>, ends in <code>=</code> or is written as short dashed groups can survive. Branch names, folder names and git branch operands are kept readable and are not redacted.</p>
<p class="note"><strong>MCP tool calls are handled the other way round:</strong> a call to an MCP server arrives as a structured payload, and rather than deny-listing known-sensitive fields, every value in it is redacted to <code>&lt;value&gt;</code> by default and only the field names and the shape are kept.</p>
<p class="note">Guardrail ids and titles are shown as their author wrote them &mdash; which for any guardrail you added yourself means your own words, unredacted. Redaction is thorough but not a guarantee. Read the commands and guardrail names above before posting this anywhere public.</p>
</section>`;
}

/**
 * The reader's own coverage limit, stated rather than left to be discovered. Each app gets its
 * own sentence because each reader walks a different shape of folder.
 */
function coverageNote(result: ScanResult): string {
  if (result.notRead === 0) return "";
  const notRead = `${escapeHtml(formatCount(result.notRead))} further transcript file${result.notRead === 1 ? "" : "s"}`;
  const was = result.notRead === 1 ? "was" : "were";
  const tail = `Every count above is of what was read, not of everything that exists.`;
  const open = `<p class="note"><strong>Coverage limit.</strong>`;

  switch (result.agent) {
    case "cursor":
      return `${open} This reader opens each session&#39;s file, and the files of the sub-agents that session started, in each project&#39;s <code>agent-transcripts</code> folder. ${notRead} in those folders ${was} not read. ${tail}</p>`;
    case "codex":
      return `${open} This reader opens the session files Codex files by date, in <code>~/.codex/sessions/&lt;year&gt;/&lt;month&gt;/&lt;day&gt;/</code>. ${notRead} elsewhere under the sessions root ${was} not read. ${tail}</p>`;
    case "claude":
      return `${open} This reader opens each session&#39;s transcript and the sub-agent transcripts in its <code>subagents</code> folder, folding a sub-agent&#39;s actions into the session that started it. ${notRead} elsewhere under the projects root &mdash; a stray file, or one nested somewhere it does not walk &mdash; ${was} not read. ${tail}</p>`;
    default:
      return unhandledAgent(result.agent);
  }
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
  // A reader that counts its skips lists them by kind in its own section instead.
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
  const coverage = coverageNote(result);
  return `<section id="scanned"><h2>What was scanned</h2>
<p class="note">${lines.join(" ")}</p>${coverage === "" ? "" : `\n${coverage}`}
</section>`;
}

/**
 * What a scan read but did not evaluate. Absent from a report whose reader counts none.
 */
function skippedSection(payload: ReportPayload): string {
  const skipped = payload.skipped;
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

  return `<section id="not-evaluated"><h2>What was not evaluated</h2>
<p class="note">None of this stopped the scan. Each line of a session file is read on its own, and whatever could not be used is counted here.</p>
${kinds}${tools}${notes.map((note) => `\n<p class="note">${escapeHtml(note)}</p>`).join("")}
</section>`;
}

/**
 * The token detail table. The cache-write split is withheld entirely when no turn reported
 * one, and the section is omitted for sessions that record no token counts.
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

  // "Read from cache" is cumulative: the cached prefix is re-read, and re-charged, on every
  // turn, so a long session's total dwarfs its distinct input.
  const cacheReadNote =
    t.cacheRead > 0
      ? `<p class="note">"Read from cache" is cumulative — the cached prefix is re-read and re-charged every turn, so this counts the same tokens many times over a session. It is a total of what the model billed for, not of distinct input.</p>`
      : "";

  return `<section id="tokens"><h2>Tokens</h2>
<p class="note">Read straight from the transcripts, so these are exact counts and not estimates.</p>
<div class="table-wrap"><table class="kv">
${body}
</table></div>
${cacheReadNote}${splitNote}</section>`;
}

/** The AgentTrail OS block. Claude Code reports only. */
function productNoteSection(result: ScanResult): string {
  if (result.agent !== "claude") return "";
  const a = result.agent;
  const { primary, secondary } = PRODUCT_NOTE;
  return `<aside class="product-note" id="os" aria-label="About AgentTrail OS">
<p class="eyebrow">${escapeHtml(PRODUCT_NOTE.eyebrow)}</p>
<h2>${escapeHtml(PRODUCT_NOTE.heading)}</h2>
<p>${escapeHtml(PRODUCT_NOTE.body)}</p>
<p class="product-note-action">${outLink(siteLink(primary.path, a, primary.content), escapeHtml(primary.label), "button")}
${outLink(siteLink(secondary.path, a, secondary.content), escapeHtml(secondary.label), "text-link")}</p>
</aside>`;
}

/** The page title: the tool, whose sessions, and the day — distinct in a list of reports. */
function pageTitle(result: ScanResult, meta: ReportMeta): string {
  return `AgentTrail Guard scan report · ${agentName(result.agent)} · ${meta.generatedAt.toISOString().slice(0, 10)}`;
}

/** The data block's text: the payload, with every `<` as the escape backslash-u003c. */
export function dataBlockText(payload: ReportPayload): string {
  return JSON.stringify(payload, null, 1).replace(/</g, "\\u003c");
}

/**
 * The policy for the standalone page: no requests, and only this one script may run. Trusted
 * Types makes Chromium refuse the markup sinks (`innerHTML` and the like) at run time too.
 */
export function contentSecurityPolicy(): string {
  const hash = createHash("sha256").update(REPORT_SCRIPT, "utf8").digest("base64");
  return `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'`;
}

/**
 * Render the whole report.
 *
 * Pure: the same result, the same `generatedAt` and the same variant produce the same bytes.
 * Every element sits on its own line, so no line of the file is long.
 */
export function renderReport(
  result: ScanResult,
  meta: ReportMeta,
  options: RenderOptions = {},
): string {
  const variant = options.variant ?? "document";
  const payload = reportPayload(result, meta);
  // A scan that read no tool calls has no result to show or share: the page says so instead.
  const scanned = result.toolCalls > 0;
  const head = `<title>${escapeHtml(pageTitle(result, meta))}</title>
<style>${REPORT_STYLES}</style>`;
  // Each section on its own lines; one that has nothing to say is left out entirely.
  const sections = [
    topBar(payload),
    heroSection(result, payload, meta, variant),
    ...(scanned
      ? [
          wouldHaveDoneSection(result, payload),
          fixFirstSection(payload),
          owaspSection(payload),
          findingsSection(payload, variant),
          recurringSection(payload),
        ]
      : []),
    nextStepsSection(result),
    scanned ? shareSectionHtml(result, payload, variant) : "",
    beforeYouShareSection(result, variant),
    redactionSection(),
    corpusSection(result),
    skippedSection(payload),
    scanned ? tokensSection(result) : "",
    productNoteSection(result),
  ].filter((section) => section !== "");
  const body = `<main class="page" lang="en">
${sections.join("\n")}
<footer>
<p class="footer-brand">${LOGO_MARK_SVG}<span>agenttrail-guard ${escapeHtml(meta.version)} &middot; ${escapeHtml(payload.catalog)}</span></p>
<p>Source: ${escapeHtml(REPOSITORY_URL)}</p>
<p>A finding is a guardrail that matched. It is not proof that anything went wrong, and the guardrails state their own coverage limits.</p>
<ul class="footer-links">
<li>${outLink(siteLink("/agenttrail-guard", result.agent, "footer-guard"), "AgentTrail Guard")}</li>
<li>${outLink(siteLink("/guardrails", result.agent, "footer-library"), "Guardrail library")}</li>
<li>${outLink(siteLink("/security", result.agent, "footer-security"), "Security")}</li>
</ul>
</footer>
<p id="page-status" class="sr-only" role="status" aria-live="polite"></p>
<textarea id="copy-buffer" class="sr-only" tabindex="-1" aria-hidden="true" readonly></textarea>
</main>`;

  if (variant === "artifact") return `${head}\n${body}\n`;
  return `<!doctype html>
<html lang="en">
<head>
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy()}">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
${head}
</head>
<body>
${body}
<script type="application/json" id="report-data">
${dataBlockText(payload)}
</script>
<script>${REPORT_SCRIPT}</script>
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
 * Read off `reportPayload`, the same projection the page and the data block are, so the two
 * cannot list different sets. Counts are omitted: an integer cannot carry a name. Shipped
 * library text (pack names, descriptions) is omitted too: it is the same for every user.
 *
 * De-duplicated, first appearance wins.
 */
export function reviewStrings(result: ScanResult): readonly ReviewGroup[] {
  const payload = reportPayload(result, { version: "", generatedAt: new Date(0) });
  const seen = new Set<string>();
  const take = (value: string): string[] => {
    if (seen.has(value)) return [];
    seen.add(value);
    return [value];
  };

  const guardrails: string[] = [];
  const commands: string[] = [];

  for (const finding of payload.findings) {
    guardrails.push(...take(`${finding.ruleId}  ${finding.title}`));
    for (const example of finding.examples) commands.push(...take(example.text));
  }
  for (const item of payload.recurring) {
    guardrails.push(...take(`${item.ruleId}  ${item.title}`));
    commands.push(...take(item.text));
  }
  // A tool name comes off disk too, so a reader's unrecognized names are listed.
  const tools = (payload.skipped?.unmappedTools ?? []).flatMap((tool) => take(tool.name));

  const groups: ReviewGroup[] = [];
  if (guardrails.length > 0)
    groups.push({ label: "Guardrails named in the report", lines: guardrails });
  if (commands.length > 0) groups.push({ label: "Command shapes in the report", lines: commands });
  if (tools.length > 0) groups.push({ label: "Tool names in the report", lines: tools });
  if (payload.findings.length > 0) {
    groups.push({ label: "The suggested post, which you can edit", lines: [payload.shareText] });
  }
  return groups;
}

/**
 * The `--json` payload: the whole redacted `ScanResult`, plus the metadata the footer
 * carries. It goes to the user's own terminal or pipe, so it is not capped; the file's own
 * export button is `reportPayload`.
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
