// cspell:words backticked describedby hellip labelledby middot noopener noreferrer ldquo rdquo rsquo
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
 * share text, and with `--verify` the verification, its list capped at `MAX_ROWS`. The rows, the
 * data block, the export and `scan --review` all read it, so the review lists exactly what the
 * file holds, and a field added to `ScanResult` reaches the file only when it is added here.
 * `--json` on stdout stays the whole result.
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
import { ICONS, LOGO_LOCKUP_SVG, LOGO_MARK_SVG, reportStyles, riskStyles } from "./report-brand.js";
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
import { formatCount, type TokenTotals } from "./tokens.js";
import type { AgentSource, GuardAction } from "./types.js";
import { CARD_BUILDERS } from "./verify/builders.js";
import {
  type CardBuilders,
  type CardContext,
  type CardSentence,
  type CardView,
  cardsFor,
  type HeadlineClaim,
  HIDING_FORMS_LIST,
  honestStatus,
  isLocalFix,
  isPositiveCount,
  LOCAL_FIX_SERIALIZED,
  pickHeadline,
  type SentenceTemplate,
  sentence,
  type VerifiedNote,
} from "./verify/cards.js";
import {
  CATEGORY_TITLES,
  CODEX_CAVEAT,
  CODEX_UNVERIFIED_TEXT,
  cardCount,
  chipCategories,
  chipText,
  countOf,
  FIXES_FILE,
  FIXES_FILE_NOTE,
  KIND_LABELS,
  leadNotes,
  MORE_EVIDENCE,
  PROVENANCE_PHRASES,
  toneLabel,
  UNSAFE_FIXES_FILE_NOTE,
} from "./verify/copy.js";
import { verifiedNotes } from "./verify/notes.js";
import { shareCounts } from "./verify/share-copy.js";
import {
  FACT_KEYS,
  FACT_VALUE_ENUMS,
  FIXTURE_CHECKS,
  SECRET_KINDS,
  SECRET_PROVENANCES,
  type SecretProvenance,
  type SecretsCheck,
  VERIFY_CATEGORIES,
  VERIFY_STATUSES,
  type Verification,
  type VerifyStatus as VerificationStatus,
  type VerifyCategory,
} from "./verify/types.js";

/** Where the source lives. Rendered as text. */
export const REPOSITORY_URL = "https://github.com/agenttrailhq/guard";

/** The site every outbound link points at, through `siteLink`. */
export const SITE_URL = "https://www.agenttrail.sh";

/** The report's filename, used by `commands/scan.ts`. */
export const REPORT_FILENAME = "agenttrail-guard-report.html";

/** The page-content variant's default filename, so it never overwrites the standalone page. */
export const ARTIFACT_FILENAME = "agenttrail-guard-artifact.html";

/**
 * The local fix-commands file, written next to the report when a check has an exact command for
 * this machine. It holds real branch names and paths, so it is never part of the page: the page
 * names it and shows redacted shapes.
 */
export const FIXES_FILENAME = FIXES_FILE;

/** Which page to render. See "Two variants, one body" in the header. */
export type ReportVariant = "document" | "artifact";

/** How to render. The default is the standalone `document`. */
export interface RenderOptions {
  readonly variant?: ReportVariant;
  /**
   * The categories whose exact fix commands were written to `FIXES_FILENAME`. Their cards name
   * the file. Empty, or absent, when no file was written.
   */
  readonly localFixCategories?: readonly VerifyCategory[];
  /**
   * The categories whose could-not-make-a-safe-command note was written to `FIXES_FILENAME`.
   * Their cards say the file lists those fixes. Empty, or absent, when no file was written.
   */
  readonly unsafeFixCategories?: readonly VerifyCategory[];
  /** The card builders. For tests; the report uses `CARD_BUILDERS`. */
  readonly cardBuilders?: CardBuilders;
}

/** The AgentTrail OS block, in Claude Code reports only. Wording lives here, not in markup. */
export const PRODUCT_NOTE = {
  eyebrow: "AgentTrail OS",
  heading:
    "AgentTrail Guard stops the mistake. AgentTrail OS remembers it and turns it into a rule.",
  body: "This report is one look at the transcripts on one machine. AgentTrail OS watches every agent session, turns each repeated mistake into a guardrail, and proves the fix on your own history. It is a separate product, and nothing in this report was sent to it.",
  steps: [
    {
      title: "Connect your projects",
      text: "Every agent session on the team is recorded in one place, with the guardrails that matched.",
    },
    {
      title: "Backtest a guardrail",
      text: "See which past commands it would have caught before it applies to anyone's work.",
    },
    {
      title: "Approve before it runs",
      text: "A matching command waits for a teammate to allow it, and the decision is kept.",
    },
  ],
  start: { label: "Start free with AgentTrail OS", path: "/signup", content: "os-signup" },
  primary: { label: "Book a team demo", path: "/agenttrail-os", content: "os-demo" },
  secondary: { label: "Guard vs OS", path: "/guard-vs-os", content: "os-compare" },
} as const;

/** The site's own accounts, linked from the footer. */
export const SOCIAL_LINKS = {
  github: "https://github.com/agenttrailhq",
  x: "https://x.com/agenttrailhq",
  linkedin: "https://www.linkedin.com/company/agenttrail",
  npm: "https://www.npmjs.com/org/agenttrail",
} as const;

/** Where to report a security issue. */
export const SECURITY_EMAIL = "security@agenttrail.sh";

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
  /**
   * What `scan --verify` found, absent without it. Counts and fixed enums only, and its list of
   * likely-real credentials capped at `MAX_ROWS`.
   */
  readonly verification?: Verification;
  /**
   * The nine cards, in page order, built from `verification` above. Every sentence on them comes
   * from a template, and every fix command is a redacted shape. Absent without verification.
   */
  readonly cards?: readonly CardView[];
  /**
   * The verified note on each listed finding a check covers, in the findings' order, from the
   * same verification and cards. Absent when no finding gets one.
   */
  readonly notes?: readonly VerifiedNote[];
}

const SECRET_KIND_SET: ReadonlySet<string> = new Set(SECRET_KINDS);
const PROVENANCE_SET: ReadonlySet<string> = new Set(SECRET_PROVENANCES);
const FIXTURE_CHECK_SET: ReadonlySet<string> = new Set(FIXTURE_CHECKS);

/**
 * The secrets check, copied field by field, its list capped at `MAX_ROWS`. Its strings get the
 * same enum check `--json` applies through `copyFacts`: a kind that is not a known one becomes
 * `other`, a way in that is not a known one is dropped, and a fixture check that is not a known
 * one becomes `unavailable`, so the data block can never carry another string.
 */
function payloadSecrets(check: SecretsCheck): SecretsCheck {
  const facts = check.facts;
  return {
    status: copyStatus(check.status),
    matches: check.matches,
    facts: {
      classes: {
        "likely-real": facts.classes["likely-real"],
        "committed-fixture": facts.classes["committed-fixture"],
        placeholder: facts.classes.placeholder,
        "local-dev": facts.classes["local-dev"],
      },
      items: facts.items.slice(0, MAX_ROWS).map((item) => ({
        kind: SECRET_KIND_SET.has(item.kind) ? item.kind : "other",
        via: item.via.filter((way) => PROVENANCE_SET.has(way)),
        files: item.files,
      })),
      moreItems: facts.moreItems + Math.max(0, facts.items.length - MAX_ROWS),
      filesRead: facts.filesRead,
      filesNotRead: facts.filesNotRead,
      unplaced: facts.unplaced,
      setAside: {
        unnamedOutputOnly: facts.setAside.unnamedOutputOnly,
        namedNotCredentialShaped: facts.setAside.namedNotCredentialShaped,
      },
      fixtureCheck: FIXTURE_CHECK_SET.has(facts.fixtureCheck) ? facts.fixtureCheck : "unavailable",
      reposChecked: facts.reposChecked,
      reposNotChecked: facts.reposNotChecked,
    },
  };
}

/** Deepest nesting `copyFacts` copies. Facts are flat records and short lists. */
const MAX_FACTS_DEPTH = 6;

/** Every string facts may hold as a value: the registered enums. */
const FACT_VALUES: ReadonlySet<string> = new Set(FACT_VALUE_ENUMS.flat());

/** Every key facts may use: the registered keys, and the enum values a record may be keyed by. */
const FACT_KEY_SET: ReadonlySet<string> = new Set([...FACT_KEYS, ...FACT_VALUES]);

/**
 * A category's facts, copied value by value, keeping only what facts may say: numbers,
 * booleans, strings from the registered enums (`FACT_VALUE_ENUMS`), lists, and objects whose
 * keys are registered (`FACT_KEYS`). Any other string, key or value is dropped, so a branch
 * name or a path a check put into its facts by mistake never reaches the page or `--json`.
 * With `capLists`, each list is cut to `MAX_ROWS`, as the file is. A `LocalFix` — an exact
 * command for the local fixes file — is refused outright, never copied.
 */
function copyFacts(value: unknown, capLists: boolean, depth = 0): unknown {
  if (isLocalFix(value)) throw new Error(LOCAL_FIX_SERIALIZED);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return FACT_VALUES.has(value) ? value : undefined;
  if (depth >= MAX_FACTS_DEPTH) return undefined;
  if (Array.isArray(value)) {
    const items = capLists ? value.slice(0, MAX_ROWS) : value;
    return items
      .map((item) => copyFacts(item, capLists, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (!FACT_KEY_SET.has(key)) continue;
      const copied = copyFacts(item, capLists, depth + 1);
      if (copied !== undefined) out[key] = copied;
    }
    return out;
  }
  return undefined;
}

const STATUS_SET: ReadonlySet<string> = new Set(VERIFY_STATUSES);

/**
 * A category's status, as the boundary passes it: one of `VERIFY_STATUSES`, or
 * `could-not-check` for anything else, so a check that sets a stray value never shows a
 * status the page does not know, and never a `clean` it did not earn.
 */
function copyStatus(status: unknown): VerificationStatus {
  return typeof status === "string" && STATUS_SET.has(status)
    ? (status as VerificationStatus)
    : "could-not-check";
}

/**
 * One category's result, copied: its status (checked against `VERIFY_STATUSES`), its raw count
 * whenever it has one — a could-not-check result can carry a count and no facts — and its
 * facts through `copyFacts`.
 */
function copyCategory<T extends { readonly status: VerificationStatus }>(
  result: T,
  capLists: boolean,
): T {
  const out: { status: VerificationStatus; matches?: number; facts?: unknown } = {
    status: copyStatus(result.status),
  };
  const matches = (result as { readonly matches?: unknown }).matches;
  if (typeof matches === "number") out.matches = matches;
  if ("facts" in result) {
    out.facts = copyFacts((result as { readonly facts: unknown }).facts, capLists);
  }
  return out as unknown as T;
}

/**
 * The verification, copied field by field. For the file (`capLists`), the secrets list is cut
 * to the row cap with the rest counted; for `--json`, nothing is cut. Either way every
 * category's facts pass through `copyFacts`.
 */
function copyVerification(verification: Verification, capLists: boolean): Verification {
  const categories = verification.categories;
  return {
    matchedCalls: {
      ran: verification.matchedCalls.ran,
      mentioned: verification.matchedCalls.mentioned,
      unknown: verification.matchedCalls.unknown,
    },
    resultsRecorded: verification.resultsRecorded,
    ranEvidence: verification.ranEvidence,
    categories: {
      secrets: capLists
        ? payloadSecrets(categories.secrets)
        : copyCategory(categories.secrets, false),
      "skipped-checks": copyCategory(categories["skipped-checks"], capLists),
      "lost-work": copyCategory(categories["lost-work"], capLists),
      cloud: copyCategory(categories.cloud, capLists),
      "prod-infra": copyCategory(categories["prod-infra"], capLists),
      tests: copyCategory(categories.tests, capLists),
      destructive: copyCategory(categories.destructive, capLists),
      unreviewed: copyCategory(categories.unreviewed, capLists),
      egress: copyCategory(categories.egress, capLists),
    },
    ...(verification.dependencies === undefined
      ? {}
      : {
          dependencies: copyFacts(
            verification.dependencies,
            capLists,
          ) as Verification["dependencies"],
        }),
  };
}

/**
 * A copied verification with each category's status as it is shown (`honestStatus`, the same
 * rule the cards use): a `clean` that could not confirm, because its facts name hiding forms or
 * because the app records no command output, becomes could-not-check. The data block and
 * `--json` carry this, so neither says clean where the page says could not confirm.
 */
function honestVerification(verification: Verification): Verification {
  const recorded = verification.resultsRecorded;
  const categories: Record<string, unknown> = {};
  for (const category of VERIFY_CATEGORIES) {
    const result = verification.categories[category] as {
      readonly status: VerificationStatus;
      readonly facts?: unknown;
    };
    categories[category] = {
      ...result,
      status: honestStatus(category, result.status, result.facts, recorded),
    };
  }
  return { ...verification, categories: categories as unknown as Verification["categories"] };
}

/**
 * The verification as every output carries it: copied through the facts boundary, then with
 * honest statuses. With `capLists`, lists are cut as the file cuts them.
 */
export function boundaryVerification(verification: Verification, capLists: boolean): Verification {
  return honestVerification(copyVerification(verification, capLists));
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
export function reportPayload(
  result: ScanResult,
  meta: ReportMeta,
  /** The card builders. For tests; the report uses `CARD_BUILDERS`. */
  builders: CardBuilders = CARD_BUILDERS,
): ReportPayload {
  const ordered = bySeverityThenCount(result.findings);
  // The cards are built from the copy, so they say no more than the file carries; the share
  // post reads its verified counts from them. The copy the file carries has the same statuses
  // the cards show.
  const copied =
    result.verification === undefined ? undefined : copyVerification(result.verification, true);
  // A scan that read no tool calls shows no cards, so the file carries none either.
  const cards =
    copied === undefined || result.toolCalls === 0 ? undefined : cardsFor(copied, builders);
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
      calls: r.calls,
      ruleId: r.ruleId,
      title: r.title,
    })),
    moreRecurring: Math.max(0, result.recurring.length - MAX_ROWS),
    tokens: result.tokens === null ? null : tokenCopy(result.tokens),
    shareText: shareText(
      result,
      cards === undefined || copied === undefined
        ? undefined
        : { cards, context: { ranEvidence: copied.ranEvidence } },
    ),
    owasp: result.owasp
      .filter((t) => isOwaspId(t.id))
      .map((t) => ({
        id: t.id,
        callCount: t.callCount,
        ruleMatches: t.ruleMatches,
        guardrailCount: t.guardrailCount,
      })),
  };
  // A note is read beside its card, so there are notes only where there are cards.
  const notes =
    copied === undefined || cards === undefined
      ? []
      : verifiedNotes(payload.findings, copied, cards);
  const withVerification: ReportPayload =
    copied === undefined
      ? payload
      : {
          ...payload,
          verification: honestVerification(copied),
          ...(cards === undefined ? {} : { cards }),
          ...(notes.length === 0 ? {} : { notes }),
        };
  const skipped = result.skipped;
  if (skipped === undefined) return withVerification;
  return {
    ...withVerification,
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

/** The tail the totals post ends with. The verified post ends ". Nothing uploaded.", to fit. */
const SHARE_TAIL = ". Checked locally, nothing uploaded.";

/**
 * The prefilled post. The user can edit it before posting.
 *
 * With verified counts that may lead (`shareCounts`, by the headline's own rule in
 * `leadingCards`: result-backed, not clean, not could-not-check, never on a Codex scan, and
 * confirmed, except a skipped-checks or lost-work count read from git state, which may lead
 * where its card could not confirm), it states them, most important first, as many as fit in a
 * post. Otherwise it is the totals post (`totalsShareText`).
 *
 * Built from counts, the agent's display name, fixed phrases and at most one shipped guardrail
 * title — never a command, a path, a project name, a card's own sentence, or a guardrail the
 * user wrote, whose title can name internal things.
 */
export function shareText(
  result: ScanResult,
  verified?: { readonly cards: readonly CardView[]; readonly context: CardContext },
): string {
  // Verified counts only over a scan that read a whole, positive number of tool calls.
  const counts =
    verified === undefined || !isPositiveCount(result.toolCalls)
      ? []
      : shareCounts(verified.cards, verified.context);
  const calls = counted(result.toolCalls, "tool call", "tool calls");
  const head = `AgentTrail Guard checked ${calls} from ${agentName(result.agent)} on my machine`;
  for (let n = counts.length; n > 0; n--) {
    const text = `${head}: ${counts.slice(0, n).join(" · ")}. Nothing uploaded.`;
    if (postLength(text) <= POST_LIMIT) return text;
  }
  return totalsShareText(result);
}

/**
 * The totals post: totals, and the top blocked LIBRARY guardrail's title.
 *
 * Built from counts, the agent's display name and one shipped title — never a command, a
 * path, a project name, or a guardrail the user wrote, whose title can name internal things.
 */
export function totalsShareText(result: ScanResult): string {
  const { block, require_approval: ask, warn } = result.riskyByAction;
  const calls = counted(result.toolCalls, "tool call", "tool calls");
  const head = `I scanned ${calls} from ${agentName(result.agent)} with AgentTrail Guard`;
  const tail = SHARE_TAIL;
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

/** How a severity is written on the page. A severity the page does not know reads "Unknown". */
const SEVERITY_LABELS: Readonly<Record<string, string>> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Info",
  unknown: "Unknown",
};

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

/** An action as the page's filters and classes name it: block, ask or warn. */
function actionSlug(action: string): "block" | "ask" | "warn" {
  if (action === "block") return "block";
  if (action === "require_approval") return "ask";
  return "warn";
}

/** A severity pill with its dot. */
function severityBadge(severity: string): string {
  const label = SEVERITY_LABELS[severity] ?? severity;
  return `<span class="badge ${severityClass(severity)}"><span class="sr-only">Severity: </span>${escapeHtml(label)}</span>`;
}

/** An action pill: "Would block", tinted. */
function actionChip(action: string): string {
  const label = actionLabel(action);
  return `<span class="act act-${actionSlug(action)}">${escapeHtml(label.charAt(0).toUpperCase() + label.slice(1))}</span>`;
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
function outLink(url: string, text: string, className?: string, attrs = ""): string {
  const cls = className === undefined ? "" : ` class="${className}"`;
  return `<a${cls} href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"${attrs}>${text}</a>`;
}

/** An outbound "learn more" link, with its arrow and a note that it opens in a new tab. */
function learnLink(url: string, text: string): string {
  return outLink(
    url,
    `${escapeHtml(text)} <span aria-hidden="true">&#8599;</span><span class="sr-only"> (opens in a new tab)</span>`,
  );
}

/** The placeholders the redaction writes, picked out where a command shows them. */
const PLACEHOLDER_HTML = /&lt;(path|name|host|user|message|comment|value|other|unnamed)&gt;/g;

/**
 * A command's text as markup: escaped, each word an unbreakable unit so a flag is never split
 * from its hyphen, and each redaction placeholder marked. Copying it gives back the command.
 */
function commandHtml(command: string): string {
  return escapeHtml(command)
    .split(" ")
    .map((word) =>
      word === ""
        ? ""
        : `<span class="tok">${word.replace(PLACEHOLDER_HTML, '<span class="ph">&lt;$1&gt;</span>')}</span>`,
    )
    .join(" ");
}

/**
 * A command in the terminal frame, with a copy button. The button shows only with the page
 * script. Its visible text is "Copy"; `name` is its accessible name, fixed text that starts with
 * "Copy" and tells the buttons apart.
 */
function copyable(id: string, command: string, name: string, className = ""): string {
  return `<div class="copy${className}"><span class="prompt" aria-hidden="true"></span><code id="${escapeHtml(id)}">${escapeHtml(command)}</code><button type="button" class="js-only" data-copy="${escapeHtml(id)}" data-label="Copy" aria-label="${escapeHtml(name)}">Copy</button></div>`;
}

/** One tile of the facts strip. */
function stat(value: string, label: string, note?: string): string {
  const noteHtml = note === undefined ? "" : `<div class="stat-note">${escapeHtml(note)}</div>`;
  return `<div class="card stat"><div class="stat-value">${escapeHtml(value)}</div><div class="stat-label">${escapeHtml(label)}</div>${noteHtml}</div>`;
}

/** The first sentence of a description. */
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

/** A section's heading and the line under it. */
function sectionHead(title: string, lead: string, headingId?: string): string {
  const id = headingId === undefined ? "" : ` id="${headingId}"`;
  return `<div class="section-head"><div><h2${id}>${title}</h2>${lead === "" ? "" : `<p>${lead}</p>`}</div></div>`;
}

/** One template sentence as a span, naming its template for the copy checks. */
function sentenceSpan(line: CardSentence): string {
  return `<span data-template="${escapeHtml(line.template)}">${escapeHtml(line.text)}</span>`;
}

/** Template sentences as one run of text. */
function sentencesHtml(lines: readonly CardSentence[]): string {
  return lines.map(sentenceSpan).join(" ");
}

// ── Sections ──────────────────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A time as people read it, in UTC so every reader sees the same: "1 Oct 2026, 09:00 UTC". */
export function readableTime(at: Date): string {
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}, ${two(at.getUTCHours())}:${two(at.getUTCMinutes())} UTC`;
}

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

/** A headline in three parts: the counted phrase is the emphasised one. */
export interface HeadlineParts {
  readonly before: string;
  readonly emphasis: string;
  readonly after: string;
}

/** The verb that ends a claim's counted subject ("522 likely-real credentials | are …"). */
const CLAIM_VERB = /\s(?:are|is|were|was|can|could|ran|reached|lowered|need|needs|would|still)\b/;

/**
 * Split a headline for the page: a claim that starts with a count emphasises its subject, up to
 * its verb; any other headline emphasises its first counted phrase. The three parts joined are
 * the headline exactly.
 */
export function headlineParts(text: string): HeadlineParts {
  const lead = /^\d[\d,]*/.exec(text);
  if (lead !== null) {
    const verb = CLAIM_VERB.exec(text);
    if (verb !== null && verb.index > lead[0].length) {
      return { before: "", emphasis: text.slice(0, verb.index), after: text.slice(verb.index) };
    }
  }
  const counted = /\d[\d,]*\s+likely-real\s+credentials?|\d[\d,]*\s+[^\s,.]+/.exec(text);
  if (counted === null) return { before: text, emphasis: "", after: "" };
  return {
    before: text.slice(0, counted.index),
    emphasis: counted[0],
    after: text.slice(counted.index + counted[0].length),
  };
}

/**
 * The page's headline for likely-real credentials: who left them, and where. The claim and its
 * count are the secrets card's; only the sentence is the page's own.
 */
export const HERO_SECRETS_HEADLINE: SentenceTemplate<{
  readonly agent: AgentSource;
  readonly count: number;
}> = {
  id: "hero.headline.secrets",
  render: ({ agent, count }) =>
    count > 0
      ? `${agentName(agent)} left ${formatCount(count)} likely-real ${count === 1 ? "credential" : "credentials"} in its transcripts.`
      : undefined,
};

/** The verified headline as the page states it. */
function heroHeadline(claim: HeadlineClaim, agent: AgentSource): CardSentence {
  if (claim.basis === "likely-real-credentials") {
    return sentence(HERO_SECRETS_HEADLINE, { agent, count: claim.count }) ?? claim.sentence;
  }
  return claim.sentence;
}

/** The headline as a heading, its counted phrase in the alert colour. */
function headlineHtml(text: string, template?: string): string {
  const parts = headlineParts(text);
  const tpl = template === undefined ? "" : ` data-template="${escapeHtml(template)}"`;
  const em = parts.emphasis === "" ? "" : `<em>${escapeHtml(parts.emphasis)}</em>`;
  return `<h1 id="headline"${tpl}>${escapeHtml(parts.before)}${em}${escapeHtml(parts.after)}</h1>`;
}

/** The top bar: the lockup, the section links, and the PDF, JSON and theme controls. */
function topBar(payload: ReportPayload): string {
  const scanned = payload.toolCalls > 0;
  const links: [string, string][] = [
    ...(scanned && payload.cards !== undefined
      ? [["what-happened", "What happened"] as [string, string]]
      : []),
    ...(scanned && payload.findings.length > 0
      ? [["outcomes", "Overview"] as [string, string]]
      : []),
    ...(payload.owasp.length > 0 ? [["owasp", "OWASP"] as [string, string]] : []),
    ...(scanned ? [["findings", "All findings"] as [string, string]] : []),
    ["next", "Next steps"],
    ["privacy", "Privacy"],
  ];
  const nav = links.map(([id, label]) => `<a href="#${id}">${label}</a>`).join("\n");
  return `<a class="skip" href="#main">Skip to the report</a>
<header class="topbar">
<div class="topbar-inner">
<a class="home-link" href="#main" aria-label="AgentTrail: back to the top of the report">${LOGO_LOCKUP_SVG}</a>
<nav class="navlinks" aria-label="Sections">
${nav}
</nav>
<div class="tools">
<button class="icon-btn labeled js-only" id="print" type="button" aria-label="Save as PDF" title="Save the full report as a PDF">${ICONS.pdf}<span>PDF</span></button>
<button class="icon-btn labeled js-only" id="export" type="button" aria-label="Download JSON" title="Download the scan data as JSON">${ICONS.json}<span>JSON</span></button>
<button class="icon-btn js-only" id="theme" type="button" aria-label="Dark theme" aria-pressed="false" title="Switch between light and dark">${ICONS.moon}${ICONS.sun}</button>
</div>
</div>
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
  const iso = meta.generatedAt.toISOString();
  const stamp = `Generated <time datetime="${escapeHtml(iso)}">${escapeHtml(readableTime(meta.generatedAt))}</time> by agenttrail-guard ${escapeHtml(meta.version)}`;
  if (variant === "artifact") {
    return `${stamp} on the publisher&#39;s own machine, from their own ${escapeHtml(agentName(result.agent))} transcripts. The scan itself made no network call &mdash; crash reporting is the one exception anywhere in this tool, off unless turned on, and a scan never uses it. This copy was published to claude.ai by the person who ran it, through Claude Code.`;
  }
  return `${stamp}. Produced entirely on this machine from transcripts already on disk &mdash; no account, nothing uploaded, and no network call: the one exception anywhere in this tool is crash reporting, which is off unless you turn it on and which a scan never uses.`;
}

/** What a scan that read no tool calls says instead of a result. */
function emptyLead(result: ScanResult): string {
  const read =
    result.sessions === 0
      ? `The scan found no ${agentName(result.agent)} sessions to read`
      : `The scan read ${counted(result.sessions, "session", "sessions")} with no tool calls in them`;
  return `${read}, so nothing was checked. This is not a clean result: check that the folder and the agent are the ones you meant, then scan again.`;
}

/** The ring's circle: radius 52 in a 120 box. */
const RING_RADIUS = 52;

/** The share of tool calls that matched no guardrail, to one decimal place, rounded down. */
export function noMatchShare(toolCalls: number, risky: number): number {
  if (toolCalls <= 0) return 0;
  return Math.floor(((toolCalls - risky) / toolCalls) * 1000) / 10;
}

/** The "no match" ring beside the headline. */
function ringHtml(result: ScanResult): string {
  const share = noMatchShare(result.toolCalls, result.riskyActions);
  const circumference = 2 * Math.PI * RING_RADIUS;
  const arc = (circumference * share) / 100;
  const clean = Math.max(0, result.toolCalls - result.riskyActions);
  const pct = `${share.toFixed(1)}%`;
  return `<div class="ring-wrap">
<div class="ring" role="img" id="ring" aria-label="${escapeHtml(`${pct} of tool calls matched no guardrail`)}">
<svg viewBox="0 0 120 120" aria-hidden="true" focusable="false"><circle class="ring-track" cx="60" cy="60" r="${RING_RADIUS}" fill="none" stroke-width="12"/><circle class="ring-arc" id="ring-arc" cx="60" cy="60" r="${RING_RADIUS}" fill="none" stroke-width="12" stroke-linecap="round" stroke-dasharray="${arc.toFixed(1)} ${circumference.toFixed(1)}"/></svg>
<div class="ring-label"><strong id="ring-pct">${escapeHtml(pct)}</strong><span>no match</span></div>
</div>
<p class="ring-legend" id="ring-legend"><b>${escapeHtml(`${formatCount(clean)} of ${formatCount(result.toolCalls)}`)}</b> tool calls matched no guardrail</p>
</div>`;
}

/** How a credential got into a transcript, most telling first: one per row on the page. */
const PROVENANCE_PRIORITY: readonly SecretProvenance[] = [
  "pasted-into-prompt",
  "typed-into-command",
  "printed-by-command",
  "in-agent-reply",
  "added-by-app",
];

/** The one way a credential arrived that its row shows. */
function primaryWay(via: readonly SecretProvenance[]): SecretProvenance | undefined {
  return PROVENANCE_PRIORITY.find((way) => via.includes(way));
}

/** Where most credentials arrived, as the lead says it. */
const ARRIVED_IN: Readonly<Record<SecretProvenance, string>> = {
  "pasted-into-prompt": "in a prompt you wrote",
  "typed-into-command": "in a command the agent typed",
  "printed-by-command": "in a command's output",
  "in-agent-reply": "in an agent reply",
  "added-by-app": "in text the app added to a prompt",
};

/** Kind labels whose first word is not a name, lower-cased mid-sentence. */
const GENERIC_KIND_START =
  /^(?:Password|Private|Random-looking|Other|Named|Authorization|Bearer|Database|URL)\b/;

/** A kind label as a plural phrase: "GitHub tokens", "URLs with a password". */
function pluralKind(label: string, first: boolean): string {
  let text = label.replace(/^(?:A|An) /, "");
  if (!first && GENERIC_KIND_START.test(text)) text = text.charAt(0).toLowerCase() + text.slice(1);
  // A brand written in lower case (npm) stays so, even first.
  if (first && !/^npm\b/.test(text)) text = text.charAt(0).toUpperCase() + text.slice(1);
  const cuts = [text.indexOf(" with "), text.indexOf(" (")].filter((at) => at !== -1);
  const cut = cuts.length === 0 ? -1 : Math.min(...cuts);
  const head = cut === -1 ? text : text.slice(0, cut);
  const tail = cut === -1 ? "" : text.slice(cut);
  return `${/s$/.test(head) ? head : `${head}s`}${tail}`;
}

/** Join phrases as prose: "a", "a and b", "a, b and c". */
function andList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The kinds sentence under a secrets headline: which kinds, and how most arrived. */
export const LEAD_KINDS: SentenceTemplate<SecretsCheck["facts"]> = {
  id: "hero.lead.kinds",
  render: (f) => {
    if (f.items.length === 0) return undefined;
    const kinds = [...new Set(f.items.map((item) => item.kind))].map(
      (kind) => KIND_LABELS[kind] ?? KIND_LABELS.other,
    );
    const shown = kinds.slice(0, 3).map((label, i) => pluralKind(label, i === 0));
    const rest = kinds.length - shown.length;
    const list = andList(rest > 0 ? [...shown, counted(rest, "other kind", "other kinds")] : shown);
    return `${list} sit in plain text in the transcripts on this machine.`;
  },
};

/** How most likely-real credentials arrived, when one way holds at least half of them. */
export const LEAD_ARRIVED: SentenceTemplate<SecretsCheck["facts"]> = {
  id: "hero.lead.arrived",
  render: (f) => {
    const tally = new Map<SecretProvenance, number>();
    for (const item of f.items) {
      const way = primaryWay(item.via);
      if (way !== undefined) tally.set(way, (tally.get(way) ?? 0) + 1);
    }
    const top = [...tally].sort((a, b) => b[1] - a[1])[0];
    if (top === undefined || top[1] * 2 < f.items.length || f.items.length < 2) return undefined;
    return `Most arrived ${ARRIVED_IN[top[0]]}.`;
  },
};

/** The lead under a verified headline: the kinds for secrets, the card's own summary otherwise. */
function leadSentences(lead: CardView, payload: ReportPayload): CardSentence[] {
  if (lead.category === "secrets" && payload.verification !== undefined) {
    const facts = payload.verification.categories.secrets.facts;
    return [sentence(LEAD_KINDS, facts), sentence(LEAD_ARRIVED, facts)].filter(
      (line): line is CardSentence => line !== undefined,
    );
  }
  const claim = lead.headline?.sentence.text;
  return cardSummary(lead).happened.filter((line) => line.text !== claim);
}

/**
 * The hero: where it came from, the headline, the lead, what to do next, and the ring.
 *
 * `lead` is the card whose verified finding leads, if any. It takes the headline; without one
 * the headline is the totals headline.
 */
function heroSection(
  result: ScanResult,
  payload: ReportPayload,
  meta: ReportMeta,
  variant: ReportVariant,
  lead?: CardView,
): string {
  const origin =
    variant === "artifact"
      ? "Scanned locally &middot; published by the person who ran it"
      : "Scanned locally &middot; nothing uploaded";
  const when = `<time datetime="${escapeHtml(meta.generatedAt.toISOString())}">${escapeHtml(readableTime(meta.generatedAt))}</time>`;
  const metaRow = `<div class="hero-meta" id="hero-meta"><span class="hero-pill"><i class="dot"></i>${origin}</span><span class="hero-kicker"><span>Scan report</span><span class="sep" aria-hidden="true"> &middot; </span><span class="sr-only">, </span><span>${escapeHtml(agentName(result.agent))}</span><span class="sep sep-when" aria-hidden="true"> &middot; </span><span class="sr-only">, </span><span class="when">${when}</span></span></div>`;
  if (result.toolCalls === 0) {
    return `<section class="hero" aria-label="Summary">
<div class="hero-main">
${metaRow}
${headlineHtml(headline(result))}
<p class="lead" id="lead">${escapeHtml(emptyLead(result))}</p>
<div class="hero-cta">
${copyable("cmd-scan-hero", `agenttrail-guard scan --agent ${result.agent}`, "Copy the scan command", " hero-copy")}
</div>
<p class="lead small">This reads the folder ${escapeHtml(agentName(result.agent))} uses by default. To read another folder, add <code>--dir</code> and its path.</p>
</div>
</section>`;
  }
  const claim = lead?.headline;
  const pageClaim = claim === undefined ? undefined : heroHeadline(claim, result.agent);
  const h1 =
    pageClaim === undefined
      ? headlineHtml(headline(result))
      : headlineHtml(pageClaim.text, pageClaim.template);
  const leads = lead === undefined ? [] : leadSentences(lead, payload);
  const leadHtml =
    claim === undefined
      ? `<p class="lead" id="lead">What your coding agent actually did, and which guardrails would have fired.</p>`
      : leads.length === 0
        ? ""
        : `<p class="lead" id="lead">${sentencesHtml(leads)}</p>`;
  const fixTarget = payload.cards !== undefined ? "what-happened" : "findings";
  const fixButton =
    payload.findings.length > 0 || payload.cards !== undefined
      ? `\n<a class="btn btn-primary btn-lg" href="#${fixTarget}">See what to fix</a>`
      : "";
  return `<section class="hero" aria-label="Summary">
<div class="hero-main">
${metaRow}
${h1}${leadHtml === "" ? "" : `\n${leadHtml}`}
<div class="hero-cta">${fixButton}
${outLink(shareLink(payload.shareText, result.agent), `${ICONS.x}<span>Share on X<span class="sr-only"> (opens in a new tab)</span></span>`, "btn btn-secondary btn-lg share-x", ' id="hero-share"')}
${copyable("cmd-init-hero", `agenttrail-guard init --agent ${result.agent}`, "Copy the init command", " hero-copy")}
</div>
</div>
${ringHtml(result)}
</section>`;
}

/** Guardrails matched, counted by their action, from every finding. */
function guardrailsByAction(result: ScanResult): Record<"block" | "ask" | "warn", number> {
  const out = { block: 0, ask: 0, warn: 0 };
  for (const f of result.findings) out[actionSlug(f.action)] += 1;
  return out;
}

/** The facts strip under the hero: sessions, risky actions, guardrails matched, repeats. */
function statsSection(result: ScanResult): string {
  // Distinct shapes: one shape two guardrails matched is one repeat, as Repeat offenders lists it.
  const repeatedShapes = new Set(result.recurring.map((r) => r.text)).size;
  const by = guardrailsByAction(result);
  const cells = [
    stat(
      formatCount(result.sessions),
      result.sessions === 1 ? "Session" : "Sessions",
      `in ${counted(result.projects, "project", "projects")}`,
    ),
    stat(formatCount(result.riskyActions), "Risky actions", "Calls that matched a guardrail"),
    stat(
      formatCount(result.findings.length),
      "Guardrails matched",
      `${formatCount(by.block)} block, ${formatCount(by.ask)} ask, ${formatCount(by.warn)} warn`,
    ),
    stat(
      formatCount(repeatedShapes),
      repeatedShapes === 1 ? "Repeated command shape" : "Repeated command shapes",
      repeatedShapes === 0 ? "None seen twice" : "Listed under Repeat offenders",
    ),
  ];
  return `<div class="stats" id="stats">
${cells.join("\n")}
</div>`;
}

// ── Verified on this machine ──────────────────────────────────────────────────

/** A card's anchor. */
function cardId(category: VerifyCategory): string {
  return `check-${category}`;
}

/** How many credential rows the page lists before it says how many more there are. */
export const EVIDENCE_ROWS = 10;

/** One credential row: its kind, the one way it arrived, and how many files hold it. */
function evidenceRowHtml(item: SecretsCheck["facts"]["items"][number]): string {
  const kind = KIND_LABELS[item.kind] ?? KIND_LABELS.other;
  const way = primaryWay(item.via);
  const how = way === undefined ? "" : PROVENANCE_PHRASES[way];
  return `<li><b>${escapeHtml(kind)}</b><span>${escapeHtml(how)}</span><span class="lx-times">${escapeHtml(countOf(item.files, "file"))}</span></li>`;
}

/** One chip, as the page writes it. */
interface Chip {
  readonly category: VerifyCategory;
  readonly tone: VerificationStatus;
  readonly title: string;
  /** Its label, without the count, or its tone when it has no claim. */
  readonly label: string;
  readonly count?: number;
  readonly template: string;
  /** Count and label together, as the review lists it. */
  readonly text: string;
}

/** The chips for a page whose headline is `lead`, in order. */
function chipsFor(cards: readonly CardView[], lead?: CardView): Chip[] {
  return chipCategories(lead?.category).flatMap((category): Chip[] => {
    const card = cards.find((c) => c.category === category);
    if (card === undefined) return [];
    const chip = chipText(card);
    const text =
      chip.count === undefined ? chip.label.text : `${formatCount(chip.count)} ${chip.label.text}`;
    return [
      {
        category,
        tone: card.tone,
        title: CATEGORY_TITLES[category],
        label: chip.label.text,
        ...(chip.count === undefined ? {} : { count: chip.count }),
        template: chip.label.template,
        text,
      },
    ];
  });
}

/**
 * Under the hero, with verification: "What it found, never the values" (one row per
 * likely-real credential, at most `EVIDENCE_ROWS`), and "Also checked on this machine" (six
 * counts, zeros included, each linking to its card).
 */
function leadExtraSection(
  payload: ReportPayload,
  cards: readonly CardView[],
  lead?: CardView,
): string {
  const verification = payload.verification;
  if (verification === undefined) return "";
  const facts = verification.categories.secrets.facts;
  const parts: string[] = [];
  if (facts.items.length > 0) {
    const rows = facts.items.slice(0, EVIDENCE_ROWS).map(evidenceRowHtml).join("\n");
    const more = MORE_EVIDENCE.render({
      more: facts.moreItems + Math.max(0, facts.items.length - EVIDENCE_ROWS),
    });
    parts.push(`<div class="card lx-evidence" id="found">
<div class="lx-head"><span>What it found, never the values</span><span class="lx-rule">Kind and source only</span></div>
<ul class="lx-creds">
${rows}
</ul>${more === undefined ? "" : `\n<p class="lx-more"><span data-template="${MORE_EVIDENCE.id}">${escapeHtml(more)}</span> <a href="#${cardId("secrets")}">See the card</a></p>`}
</div>`);
  }
  const chips = chipsFor(cards, lead)
    .map(
      (chip) =>
        `<li><a class="lx-link" href="#${cardId(chip.category)}" data-template="${escapeHtml(chip.template)}">${escapeHtml(chip.label)}</a>${chip.count === undefined ? "" : `<b>${escapeHtml(formatCount(chip.count))}</b>`}</li>`,
    )
    .join("\n");
  // The forms the checks cannot read inside, said once here for every card that met one: each
  // such card's caveat points here.
  const forms = sentence(HIDING_FORMS_LIST, cards);
  if (chips !== "" || forms !== undefined) {
    parts.push(`<div class="lx-also" id="also-checked">
<h2 class="lx-h">Also checked on this machine</h2>${chips === "" ? "" : `\n<ul class="card lx-grid">\n${chips}\n</ul>`}${forms === undefined ? "" : `\n<p class="vnote">${sentenceSpan(forms)}</p>`}
</div>`);
  }
  if (parts.length === 0) return "";
  return `<section class="lead-extra" id="lead-extra" aria-label="Behind the headline">
${parts.join("\n")}
</section>`;
}

/**
 * The longest each short row of a card may be: sentences, and characters together. A row's
 * first sentence is always shown, so `report-design.test.ts` holds every check's first
 * sentences to these limits over a matrix of synthetic facts.
 */
export const SUMMARY_LIMITS = {
  happened: { sentences: 2, chars: 200 },
  now: { sentences: 1, chars: 140 },
  fix: { sentences: 1, chars: 140 },
} as const;

/** A card's short rows: the first sentences of each field, within `SUMMARY_LIMITS`. */
export interface CardSummary {
  readonly happened: readonly CardSentence[];
  readonly now: readonly CardSentence[];
  readonly fix: readonly CardSentence[];
}

/** The first sentences of `lines`, at most `limit.sentences`, within `limit.chars` together. */
function firstLines(
  lines: readonly CardSentence[],
  limit: { readonly sentences: number; readonly chars: number },
): CardSentence[] {
  const out: CardSentence[] = [];
  let length = 0;
  for (const line of lines) {
    if (out.length >= limit.sentences) break;
    const next = length + (out.length === 0 ? 0 : 1) + line.text.length;
    if (out.length > 0 && next > limit.chars) break;
    out.push(line);
    length = next;
  }
  return out;
}

/**
 * A card's short rows, taken from its own template sentences: the full lists stay behind the
 * card's expander, so every line on the card still comes from a check.
 */
export function cardSummary(card: CardView): CardSummary {
  return {
    happened: firstLines(card.found, SUMMARY_LIMITS.happened),
    now: firstLines(card.now, SUMMARY_LIMITS.now),
    fix: firstLines(card.fixSteps ?? [], SUMMARY_LIMITS.fix),
  };
}

/** How a card's tone reads on its pill. Could-not-confirm keeps the shared wording. */
export function vtoneLabel(card: CardView): string {
  if (card.tone === "act") return "Fix now";
  if (card.tone === "review") return "Review";
  if (card.tone === "clean" && card.unconfirmed === undefined) return "Checked, clean";
  return toneLabel(card);
}

/** Most fix shapes a card's command panel lists. */
const MAX_CARD_COMMANDS = 6;

/**
 * One card of "What actually happened": a tone, its title and count, short rows (What happened,
 * Now, Fix), one command panel, and the full check behind an expander.
 */
function verifiedCard(card: CardView): string {
  const title = CATEGORY_TITLES[card.category];
  const id = cardId(card.category);
  const count = cardCount(card);
  const short = cardSummary(card);
  const rows: string[] = [];
  if (short.happened.length > 0)
    rows.push(`<dt>What happened</dt><dd>${sentencesHtml(short.happened)}</dd>`);
  if (short.now.length > 0) rows.push(`<dt>Now</dt><dd>${sentencesHtml(short.now)}</dd>`);
  if (short.fix.length > 0) rows.push(`<dt>Fix</dt><dd>${sentencesHtml(short.fix)}</dd>`);
  const commands = card.fixes
    .slice(0, MAX_CARD_COMMANDS)
    .map(
      (fix) =>
        `<div class="vcmd"><span class="prompt" aria-hidden="true"></span><code>${commandHtml(fix.shape)}</code></div>`,
    )
    .join("\n");
  // The full check: every sentence the card's templates made, and why it could not confirm.
  const more: string[] = [];
  const group = (label: string, lines: readonly CardSentence[]): void => {
    if (lines.length > 0) more.push(`<h4>${label}</h4><p>${sentencesHtml(lines)}</p>`);
  };
  const codex = sentence(CODEX_CAVEAT, card);
  const extra =
    card.found.length > short.happened.length ||
    card.now.length > short.now.length ||
    (card.fixSteps ?? []).length > short.fix.length ||
    card.read !== undefined ||
    card.caveat !== undefined ||
    codex !== undefined;
  if (extra) {
    group("What checking found", card.found);
    group("Now", card.now);
    group("Fix", card.fixSteps ?? []);
    if (card.read !== undefined) group("What it read", [card.read]);
    // Why the card could not confirm everything, after its numbers and its fix.
    if (card.caveat !== undefined)
      more.push(`<p class="note card-caveat">${sentenceSpan(card.caveat)}</p>`);
    if (codex !== undefined) more.push(`<p class="note codex-caveat">${sentenceSpan(codex)}</p>`);
  }
  const expander =
    more.length === 0
      ? ""
      : `\n<details class="vmore"><summary>How this was checked</summary><div class="vmore-body">\n${more.join("\n")}\n</div></details>`;
  return `<article class="card vrow v-${card.tone}" id="${id}" aria-labelledby="${id}-title" aria-describedby="${id}-tone">
<div class="vtop"><span class="vtone" id="${id}-tone">${escapeHtml(vtoneLabel(card))}</span><h3 id="${id}-title">${escapeHtml(title)}</h3>${count === undefined ? "" : `<span class="vmatched" data-template="${escapeHtml(count.template)}">${escapeHtml(count.text)}</span>`}</div>${rows.length === 0 ? "" : `\n<dl class="vfacts">${rows.join("")}</dl>`}${commands === "" ? "" : `\n<div class="vcmds">\n${commands}\n</div>`}${expander}
</article>`;
}

/** "What actually happened": the nine cards, act first, then review, clean and the rest. */
function whatHappenedSection(
  verification: Verification,
  cards: readonly CardView[],
  variant: ReportVariant,
  localFixCategories: readonly VerifyCategory[],
  unsafeFixCategories: readonly VerifyCategory[],
): string {
  const rows = cards.map(verifiedCard).join("\n");
  // Said once, under the cards: what a count counts, and where the exact commands are. A
  // category with no check has no commands in the file.
  const notes = leadNotes(verification);
  const listed = (categories: readonly VerifyCategory[]): boolean =>
    cards.some((c) => c.tone !== "not-checked" && categories.includes(c.category));
  /** A note naming the fixes file, with the file name as code. */
  const fileHtml = (template: SentenceTemplate<{ variant: ReportVariant }>): string =>
    ` <span data-template="${template.id}">${escapeHtml(template.render({ variant }) ?? "").replace(FIXES_FILENAME, `<code>${FIXES_FILENAME}</code>`)}</span>`;
  const files =
    (listed(localFixCategories) ? fileHtml(FIXES_FILE_NOTE) : "") +
    (listed(unsafeFixCategories) ? fileHtml(UNSAFE_FIXES_FILE_NOTE) : "");
  return `<section id="what-happened" aria-labelledby="h-verified">
${sectionHead("What actually happened", "A match only means a guardrail fired. Each card says what checking it on this machine found, how things stand now, and how to fix it.", "h-verified")}
<div class="verified" id="verified-rows">
${rows}
</div>
<p class="vnote">The checks only read: they changed nothing on this machine.${notes.length === 0 ? "" : ` ${sentencesHtml(notes)}`}${files}</p>
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
  return ` <strong>On Codex, &ldquo;would ask&rdquo; means the action would have been stopped.</strong> Codex gives a guardrail no way to ask you, so AgentTrail Guard sends those as a block. The label is the guardrail&#39;s own decision, kept the same across apps so one guardrail reads the same way everywhere.`;
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
  // Every choice is needed: a pick either completes a group of asks it is in, or ties at
  // nothing removed and is then needed by the pick that completes a group with it. A
  // property test over random overlaps checks that each guardrail offered removes asks.
  return {
    ids: [...chosen].sort((a, b) => (own.get(b) ?? 0) - (own.get(a) ?? 0) || a.localeCompare(b)),
    share: drop / total,
    asks: total,
    remaining: total - drop,
  };
}

/** An id that a shell reads as one plain word. */
export const SHELL_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The tuning hint's card: a few guardrails produce most of the asks. */
function tuningSection(result: ScanResult, payload: ReportPayload): string {
  const hint = tuningHint(result.decided, payload.findings);
  if (hint === undefined) return "";
  const n = hint.ids.length;
  const pct = Math.round(hint.share * 100);
  // A copyable command only for an id that is safe to paste into a shell. A user's own id is
  // any string, so one that is not gets named as text, with no command to copy.
  const safe = hint.ids.filter((id) => SHELL_SAFE_ID.test(id));
  const unsafe = hint.ids.filter((id) => !SHELL_SAFE_ID.test(id));
  const commands = safe.map((id) => `agenttrail-guard guardrails set-action ${id} warn`);
  const copy =
    commands.length === 0
      ? ""
      : `<div class="copy multi"><span class="prompt" aria-hidden="true"></span><code id="cmd-tune">${commands.map((c) => `<span class="ln">${escapeHtml(c)}</span>`).join("\n")}</code><button type="button" class="js-only" data-copy="cmd-tune" data-label="Copy" aria-label="${escapeHtml(n === 1 ? "Copy the set-action command" : "Copy the set-action commands")}">Copy</button></div>`;
  const unsafeNote = unsafe
    .map(
      (id) =>
        ` Set <code>${escapeHtml(id)}</code> to warn with <code>agenttrail-guard guardrails set-action</code>: its id has characters a shell would read, so no command is offered to copy.`,
    )
    .join("");
  return `<div class="card insight" id="insight">${ICONS.info}<div class="insight-text"><p id="insight-main"><strong>${escapeHtml(counted(n, "guardrail accounts", "guardrails account"))} for ${pct}% of the asks.</strong> Setting ${n === 1 ? "it" : "them"} to warn would take the tool calls you are asked about from ${escapeHtml(formatCount(hint.asks))} to ${escapeHtml(formatCount(hint.remaining))}, and the agent would be shown a warning on those calls instead.</p><p class="muted small">The agent is still shown each match.${unsafeNote}</p></div><div class="insight-cmds" id="insight-cmds">${copy}</div></div>`;
}

/** The verdict panels' titles. */
const OUTCOME_TITLES: Readonly<Record<GuardAction, string>> = {
  block: "Blocked",
  require_approval: "Asked you first",
  warn: "Warned",
};

/** "What AgentTrail Guard would have done": three panels, the tuning hint and the severity bar. */
function wouldHaveDoneSection(result: ScanResult, payload: ReportPayload): string {
  if (result.findings.length === 0) return "";
  const guardrails = guardrailsByAction(result);
  const panels = ACTION_ORDER.map((action) => {
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
          `<li><span>${inlineTitle(f.title)}</span><b>${escapeHtml(formatCount(n))}</b></li>`,
      );
    const all = guardrails[actionSlug(action)];
    if (all > 0) {
      top.push(
        `<li class="olink-li"><a class="olink" href="#findings">See all ${escapeHtml(formatCount(all))} in All findings</a></li>`,
      );
    }
    return `<div class="card outcome o-${actionSlug(action)}">
<div class="n">${escapeHtml(formatCount(count))}</div>
<div class="t">${OUTCOME_TITLES[action]}</div>
<p>${escapeHtml(ACTION_MEANING[action])}</p>
<ul class="otop">${top.length === 0 ? "" : `\n${top.join("\n")}\n`}</ul>
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
  const severities = [...severityCounts].map(([severity, count]) => ({ severity, count }));
  const total = severities.reduce((sum, s) => sum + s.count, 0);
  const bar = severities
    .map((s) => `<span class="s-${escapeHtml(s.severity)}" style="flex: ${s.count} 0 0"></span>`)
    .join("");
  const legend = severities
    .map(
      (s) =>
        `<span><i class="s-${escapeHtml(s.severity)}"></i>${escapeHtml(SEVERITY_LABELS[s.severity] ?? s.severity)} <b>${escapeHtml(formatCount(s.count))}</b></span>`,
    )
    .join("\n");
  const barLabel = severities
    .map(
      (s) => `${formatCount(s.count)} ${(SEVERITY_LABELS[s.severity] ?? s.severity).toLowerCase()}`,
    )
    .join(", ");

  return `<section id="outcomes">
${sectionHead("What AgentTrail Guard would have done", "If AgentTrail Guard had been running during these sessions, with its default settings.")}
<div class="outcomes" id="outcome-cards">
${panels}
</div>
<p class="vnote" id="excl-note">Tool calls, each counted once under the strictest guardrail it matched.${askOnCodexNote(result, byAction)}</p>
${tuningSection(result, payload)}
<div class="card sevbar-card">
<h3 class="sevbar-title">Matches by severity</h3>
<div class="sevbar" role="img" id="sevbar" aria-label="${escapeHtml(barLabel)}">${bar}</div>
<div class="sevlegend" id="sevlegend">
${legend}
</div>
<p class="sev-caption" id="sev-caption">${escapeHtml(counted(total, "guardrail match", "guardrail matches"))} from ${escapeHtml(counted(result.riskyActions, "risky action", "risky actions"))}: each guardrail counts its own matches, so a tool call that matched two guardrails counts under both.</p>
</div>
</section>`;
}

/** The edition of the two OWASP lists the ids follow, as `OWASP_SOURCES` links them. */
export const OWASP_EDITION = "2026 edition";

/** The OWASP risks the matched guardrails name, or nothing when no matched guardrail carries an id. */
function owaspSection(payload: ReportPayload): string {
  if (payload.owasp.length === 0) return "";
  const touched = (list: readonly { readonly id: string }[]): number =>
    payload.owasp.filter((t) => list.some((risk) => risk.id === t.id)).length;
  const risks = [...payload.owasp].sort(
    (a, b) => b.callCount - a.callCount || a.id.localeCompare(b.id),
  );
  const most = Math.max(1, ...risks.map((t) => t.callCount));
  const cards = risks
    .map(
      (
        t,
      ) => `<label class="card risk" for="ff-risk-${escapeHtml(t.id)}" data-risk="${escapeHtml(t.id)}">
<span class="risk-top"><span class="risk-id">${escapeHtml(t.id)}</span><span class="risk-count"><span class="risk-n">${escapeHtml(formatCount(t.callCount))}</span> <span class="risk-unit">${t.callCount === 1 ? "call" : "calls"}</span></span></span>
<span class="risk-title">${escapeHtml(owaspTitle(t.id))}</span>
<span class="risk-sub">${escapeHtml(counted(t.guardrailCount, "guardrail", "guardrails"))}</span>
<span class="risk-meter" aria-hidden="true"><span style="width: ${((t.callCount / most) * 100).toFixed(1)}%"></span></span>
</label>`,
    )
    .join("\n");
  const caption = `This scan touched ${touched(OWASP_AGENTIC)} of ${OWASP_AGENTIC.length} agentic risks and ${touched(OWASP_LLM)} of ${OWASP_LLM.length} LLM risks, in the ${OWASP_EDITION} lists. A guardrail can name more than one risk, and a tool call can match more than one guardrail, so counts overlap. This covers coding-agent actions only, and an id never claims a guardrail covers the whole risk.`;
  return `<section id="owasp">
${sectionHead("Mapped to OWASP", `The OWASP Top 10 risks for agentic applications (ASI) and LLM applications that these findings fall under. <span class="screen-only">Select a risk to filter the findings below.</span>`)}
<div class="owasp-grid" id="owasp-grid">
${cards}
</div>
<div class="owasp-foot"><span id="owasp-caption">${escapeHtml(caption)}</span></div>
<div class="learn">${learnLink(siteLink(sitePath(OWASP_PAGE_URL), payload.agent, "owasp"), "How the guardrails map to OWASP")}${learnLink(OWASP_SOURCES.agentic, `OWASP Top 10 for Agentic Applications (${OWASP_EDITION})`)}${learnLink(OWASP_SOURCES.llm, `OWASP Top 10 for LLM Applications (${OWASP_EDITION})`)}</div>
</section>`;
}

/** Each finding's anchor: `finding-<slug of its id>`, unique on the page. */
function findingAnchors(findings: readonly PayloadFinding[]): Map<PayloadFinding, string> {
  const used = new Set<string>();
  const out = new Map<PayloadFinding, string>();
  findings.forEach((f, i) => {
    let anchor = `finding-${ruleSlug(f.ruleId) || String(i)}`;
    if (used.has(anchor)) anchor = `${anchor}-${i}`;
    used.add(anchor);
    out.set(f, anchor);
  });
  return out;
}

/** Rank maps for the sorts, computed here so the page reads numbers only. */
function ranks(findings: readonly PayloadFinding[]): {
  category: Map<PayloadFinding, number>;
  count: Map<PayloadFinding, number>;
  name: Map<PayloadFinding, number>;
} {
  // A user's own guardrails are one group, after every pack. Compared in a fixed locale, so
  // the ranks are the same on every machine.
  const yours = (f: PayloadFinding): number => (f.category === undefined ? 1 : 0);
  const pack = (f: PayloadFinding): string =>
    f.category === undefined ? YOUR_GUARDRAILS : packLabel(f.category);
  const rankBy = (cmp: (a: PayloadFinding, b: PayloadFinding) => number) =>
    new Map([...findings].sort(cmp).map((f, i) => [f, i]));
  return {
    category: rankBy(
      (a, b) =>
        yours(a) - yours(b) ||
        pack(a).localeCompare(pack(b), "en") ||
        findings.indexOf(a) - findings.indexOf(b),
    ),
    count: rankBy((a, b) => b.count - a.count || findings.indexOf(a) - findings.indexOf(b)),
    name: rankBy(
      (a, b) => a.title.localeCompare(b.title, "en") || a.ruleId.localeCompare(b.ruleId, "en"),
    ),
  };
}

/** How many rows a list shows before "All" is chosen. */
export const TOP_ROWS = 5;

/**
 * The tone a note's mark takes, by what the note says. A note that could not confirm is
 * neutral. A reassuring note is marked clean only in a clean category, and is neutral in any
 * other, so it never takes an alarming card's colour. A note of what was found takes its card's
 * tone; the dependency check has no card, so its notes are neutral.
 */
function noteTone(note: VerifiedNote, cards: readonly CardView[]): VerificationStatus | undefined {
  const tone = cards.find((card) => card.category === note.category)?.tone;
  switch (note.outcome) {
    case "could-not-confirm":
      return "could-not-check";
    case "reassuring":
      return tone === "clean" ? "clean" : undefined;
    default:
      return tone;
  }
}

/** A finding's verified note, first in its expanded row, marked by its tone. */
function noteHtml(note: VerifiedNote, tone: VerificationStatus | undefined): string {
  return `<p class="${tone === undefined ? "fchecked" : `fchecked v-${tone}`}"><b>What checking found:</b> <span data-template="${escapeHtml(note.sentence.template)}">${escapeHtml(note.sentence.text)}</span></p>`;
}

/** One row of All findings. */
function findingRow(
  f: PayloadFinding,
  index: number,
  anchor: string,
  order: { readonly category: number; readonly count: number; readonly name: number },
  top: string,
  most: number,
  agent: AgentSource,
  note?: { readonly note: VerifiedNote; readonly tone: VerificationStatus | undefined },
): string {
  const group = f.category === undefined ? YOUR_GUARDRAILS : packLabel(f.category);
  const examples = f.examples
    .map(
      (example) =>
        `<li><code class="cmd">${commandHtml(example.text)}</code><span class="times">${escapeHtml(formatCount(example.count))}&times;</span></li>`,
    )
    .join("\n");
  const more =
    f.moreShapes > 0
      ? `\n<p class="more">and ${escapeHtml(counted(f.moreShapes, "more shape", "more shapes"))}</p>`
      : "";
  const why =
    f.descriptionLines === undefined
      ? ""
      : `\n${libraryText(firstSentence(f.descriptionLines), "library-text why")}`;
  const how =
    f.descriptionLines === undefined
      ? ""
      : `\n<details class="libdesc"><summary>How this guardrail decides, and what it misses<span class="sr-only">: ${inlineTitle(f.title)}</span></summary>
${libraryText(f.descriptionLines.join(" "))}
<p>${outLink(libraryLink(f.category ?? "", f.ruleId, agent), "Open it in the guardrail library")}</p>
</details>`;
  const risks =
    f.owasp.length === 0
      ? ""
      : `\n<p class="owasp-line"><span class="lbl">OWASP:</span> ${f.owasp.map((id) => outLink(owaspRiskLink(id, agent), `${escapeHtml(id)} ${escapeHtml(owaspTitle(id))}`, undefined, ` aria-describedby="${anchor}-title"`)).join(' <span class="sep" aria-hidden="true">&middot;</span> ')}</p>`;
  const tags = f.owasp.map((id) => `<span class="otag">${escapeHtml(id)}</span>`).join("");
  const width = ((f.count / most) * 100).toFixed(1);
  const style = `--o-risk: ${index}; --o-category: ${order.category}; --o-count: ${order.count}; --o-name: ${order.name}`;
  return `<details class="frow" id="${anchor}" data-action="${actionSlug(f.action)}" data-risks="${escapeHtml(f.owasp.join(" "))}" data-cat="${escapeHtml(f.category ?? "yours")}" data-top="${top}" style="${style}">
<summary><div><div class="ftitle" id="${anchor}-title">${inlineTitle(f.title)}</div><div class="fsub"><span class="fid">${escapeHtml(f.ruleId)}</span><span class="pack">${escapeHtml(group)}</span>${tags}</div></div><div class="fmeta">${severityBadge(f.severity)}${actionChip(f.action)}<span class="fbar" aria-hidden="true"><span style="width: ${width}%"></span></span><span class="fcount">${escapeHtml(formatCount(f.count))}<span class="unit"> ${f.count === 1 ? "match" : "matches"}</span></span></div></summary>
<div class="fbody">${note === undefined ? "" : `\n${noteHtml(note.note, note.tone)}`}${why}${how}${risks}
<ul class="shapes">
${examples}
</ul>${more}
</div>
</details>`;
}

/** One segment of a radio group. */
function segment(name: string, id: string, value: string, label: string, checked: boolean): string {
  return `<label class="filter"><input type="radio" name="${name}" id="${id}" value="${value}" autocomplete="off"${checked ? " checked" : ""}>${label}</label>`;
}

/** All findings: one row per guardrail, with filters, OWASP risks, sorts, search and a limit. */
function findingsSection(payload: ReportPayload, variant: ReportVariant): string {
  if (payload.findings.length === 0) {
    return `<section id="findings">
${sectionHead("All findings", "")}
<div class="card empty">No guardrail matched anything in these sessions.</div>
</section>`;
  }
  const findings = payload.findings;
  const r = ranks(findings);
  const anchors = findingAnchors(findings);
  const most = Math.max(1, ...findings.map((f) => f.count));
  const total = findings.length + payload.moreFindings;
  const matches = findings.reduce((sum, f) => sum + f.count, 0);

  // Category order: each pack's header, then its rows.
  const packOf = (f: PayloadFinding): string => f.category ?? "yours";
  const byCategory = [...findings].sort(
    (a, b) => (r.category.get(a) ?? 0) - (r.category.get(b) ?? 0),
  );
  const categoryOrder = new Map<PayloadFinding, number>();
  const groups: { cat: string; label: string; order: number; rows: PayloadFinding[] }[] = [];
  let position = 0;
  for (const f of byCategory) {
    let group = groups[groups.length - 1];
    if (group === undefined || group.cat !== packOf(f)) {
      group = {
        cat: packOf(f),
        label: f.category === undefined ? YOUR_GUARDRAILS : packLabel(f.category),
        order: position++,
        rows: [],
      };
      groups.push(group);
    }
    group.rows.push(f);
    categoryOrder.set(f, position++);
  }
  const topIn = (rank: number | undefined): boolean => (rank ?? TOP_ROWS) < TOP_ROWS;
  const topCategory = new Set(byCategory.slice(0, TOP_ROWS));
  const topOf = (f: PayloadFinding, index: number): string =>
    [
      index < TOP_ROWS ? "risk" : "",
      topCategory.has(f) ? "category" : "",
      topIn(r.count.get(f)) ? "count" : "",
      topIn(r.name.get(f)) ? "name" : "",
    ]
      .filter((t) => t !== "")
      .join(" ");

  const headers = groups
    .map((g) => {
      const acts = [...new Set(g.rows.map((f) => actionSlug(f.action)))].join(" ");
      const risks = [...new Set(g.rows.flatMap((f) => f.owasp))].join(" ");
      const top = g.rows.some((f) => topCategory.has(f)) ? "category" : "";
      const n = g.rows.reduce((sum, f) => sum + f.count, 0);
      return `<div class="fgroup" data-cat="${escapeHtml(g.cat)}" data-acts="${acts}" data-risks="${escapeHtml(risks)}" data-top="${top}" style="--o-category: ${g.order}"><h3>${escapeHtml(g.label)}</h3><span class="fgroup-meta">${escapeHtml(`${counted(g.rows.length, "guardrail", "guardrails")} · ${counted(n, "match", "matches")}`)}</span></div>`;
    })
    .join("\n");
  const notes = payload.notes ?? [];
  const cards = payload.cards ?? [];
  // Only a library guardrail's row carries a note: a guardrail the user wrote has none.
  const noteFor = (f: PayloadFinding) => {
    const note = f.source === "library" ? notes.find((n) => n.ruleId === f.ruleId) : undefined;
    return note === undefined ? undefined : { note, tone: noteTone(note, cards) };
  };
  const rows = findings
    .map((f, i) =>
      findingRow(
        f,
        i,
        anchors.get(f) ?? `finding-${i}`,
        {
          category: categoryOrder.get(f) ?? i,
          count: r.count.get(f) ?? i,
          name: r.name.get(f) ?? i,
        },
        topOf(f, i),
        most,
        payload.agent,
        noteFor(f),
      ),
    )
    .join("\n");

  const showing = (shown: number): string =>
    `Showing ${formatCount(shown)} of ${counted(findings.length, "guardrail", "guardrails")} · ${counted(matches, "match", "matches")} in all`;
  const byAction = (slug: string): number =>
    findings.filter((f) => actionSlug(f.action) === slug).length;
  const rc = [
    `<span class="rc" data-s="top">${escapeHtml(showing(Math.min(TOP_ROWS, findings.length)))}</span>`,
    `<span class="rc" data-s="all">${escapeHtml(showing(findings.length))}</span>`,
    ...["block", "ask", "warn"].map(
      (slug) => `<span class="rc" data-s="${slug}">${escapeHtml(showing(byAction(slug)))}</span>`,
    ),
    ...payload.owasp.map(
      (t) =>
        `<span class="rc" data-s="risk-${escapeHtml(t.id)}">${escapeHtml(showing(findings.filter((f) => f.owasp.includes(t.id)).length))}</span>`,
    ),
    `<span class="rc-js" id="rc-search"></span>`,
  ].join("");
  const riskRadios =
    payload.owasp.length === 0
      ? ""
      : `\n<span class="risk-radios" id="ff-risks" role="group" aria-label="Filter by OWASP risk">${payload.owasp.map((t) => `<input class="vh risk-radio" type="radio" name="ff" id="ff-risk-${escapeHtml(t.id)}" value="${escapeHtml(t.id)}" autocomplete="off" aria-label="${escapeHtml(`OWASP ${t.id}: ${owaspTitle(t.id)}`)}">`).join("")}</span>`;
  const activeFilter =
    payload.owasp.length === 0
      ? ""
      : `\n<div class="active-filter" id="risk-filter"><span id="risk-filter-label">Filtered by ${payload.owasp.map((t) => `<span class="af-t" data-s="risk-${escapeHtml(t.id)}">${escapeHtml(`${t.id} ${owaspTitle(t.id)}`)}</span>`).join("")}</span><label for="ff-all" id="risk-clear">Clear<span class="sr-only"> the OWASP filter</span></label></div>`;
  const truncated =
    payload.moreFindings > 0
      ? `\n<p class="vnote">${escapeHtml(formatCount(payload.moreFindings))} further guardrails matched and are not listed here.</p>`
      : "";
  const limit =
    findings.length > TOP_ROWS
      ? `<div class="sortbox limit" id="fx-toggle"><span class="sort-cap" id="fx-cap">Show</span><div class="seg" role="radiogroup" aria-labelledby="fx-cap">${segment("fx", "fx-top", "top", `<span>Top ${TOP_ROWS}</span>`, true)}${segment("fx", "fx-all", "all", `<span>All ${escapeHtml(counted(findings.length, "guardrail", "guardrails"))}</span>`, false)}</div></div>`
      : "";
  const artifactNote =
    variant === "artifact"
      ? ` Search and export are in the report file itself, <code>${REPORT_FILENAME}</code>. To make one from your own sessions, run <code>agenttrail-guard scan</code>.`
      : "";
  return `<section id="findings">
${sectionHead("All findings", `<span id="findings-count">${escapeHtml(counted(total, "guardrail matched", "guardrails matched"))}.</span> <span class="screen-only">Open a row to see the commands behind it.</span>${artifactNote}`)}
<div class="explorer-controls">
<div class="toolbar">
<div class="seg" role="radiogroup" aria-label="Filter findings">${segment("ff", "ff-all", "all", "<span>All</span>", true)}${segment("ff", "ff-block", "block", '<span><span class="w">Would </span>block</span>', false)}${segment("ff", "ff-ask", "ask", '<span><span class="w">Would </span>ask</span>', false)}${segment("ff", "ff-warn", "warn", '<span><span class="w">Would </span>warn</span>', false)}</div>${riskRadios}
<div class="sortbox"><span class="sort-cap" id="sort-cap">Sort</span><div class="seg" role="radiogroup" aria-labelledby="sort-cap">${segment("fs", "fs-risk", "risk", '<span class="l">Most serious</span><span class="s">Serious</span>', true)}${segment("fs", "fs-category", "category", '<span class="l">By category</span><span class="s">Category</span>', false)}${segment("fs", "fs-count", "count", '<span class="l">Most matches</span><span class="s">Matches</span>', false)}${segment("fs", "fs-name", "name", '<span class="l">Name</span><span class="s">Name</span>', false)}</div></div>
<input class="search js-only" id="search" type="search" placeholder="Search by name or command" aria-label="Search guardrails or commands" autocomplete="off">
</div>
</div>${activeFilter}
<p class="result-count" id="result-count" aria-live="polite">${rc}</p>
<div class="card flist-card">
<div class="flist-head" aria-hidden="true"><span>Guardrail</span><span>Severity</span><span>Action</span><span></span><span>Matches</span></div>
<div class="flist" id="flist">
${headers}
${rows}
</div>
<div class="empty flist-empty" id="flist-empty">No findings match this search.</div>
</div>${truncated}
<div class="row-actions">${limit}<button class="btn btn-secondary btn-sm js-only" id="expand-all" type="button" aria-expanded="false">Expand all</button></div>
</section>`;
}

/** Repeat offenders: the same command shape more than once. */
function recurringSection(payload: ReportPayload): string {
  if (payload.recurring.length === 0) {
    return `<section id="repeats">
${sectionHead("Repeat offenders", "")}
<div class="card empty">Nothing matched more than once.</div>
</section>`;
  }
  const anchors = findingAnchors(payload.findings);
  // One row per shape: a shape that two guardrails matched lists both, once.
  const byShape = new Map<string, RecurringItem[]>();
  for (const item of payload.recurring) {
    byShape.set(item.text, [...(byShape.get(item.text) ?? []), item]);
  }
  const rows = [...byShape]
    .map(([text, items]) => {
      // Tool calls with this shape, each once: two guardrails on the same calls do not add,
      // and different calls that redact to this shape do.
      const times = Math.max(...items.map((item) => item.calls));
      const names = items
        .map((item) => {
          const finding = payload.findings.find((f) => f.ruleId === item.ruleId);
          const anchor = finding === undefined ? undefined : anchors.get(finding);
          const title = inlineTitle(item.title);
          const named =
            anchor === undefined ? title : `<a class="linkish" href="#${anchor}">${title}</a>`;
          // When the guardrails matched the shape a different number of times, say each.
          return item.count === times
            ? named
            : `${named} (${escapeHtml(formatCount(item.count))}&times;)`;
        })
        .join("<br>");
      return `<tr><td><code class="cmd">${commandHtml(text)}</code></td><td class="n">${escapeHtml(formatCount(times))}&times;</td><td class="g">${names}</td></tr>`;
    })
    .join("\n");
  const more =
    payload.moreRecurring > 0
      ? `\n<p class="vnote">${escapeHtml(counted(payload.moreRecurring, "further repeat is", "further repeats are"))} not listed here.</p>`
      : "";
  const limit =
    byShape.size > TOP_ROWS
      ? `\n<div class="row-actions" id="rx-row"><div class="sortbox limit"><span class="sort-cap" id="rx-cap">Show</span><div class="seg" role="radiogroup" aria-labelledby="rx-cap">${segment("rx", "rx-top", "top", `<span>Top ${TOP_ROWS}</span>`, true)}${segment("rx", "rx-all", "all", `<span>All ${escapeHtml(counted(byShape.size, "repeat", "repeats"))}</span>`, false)}</div></div></div>`
      : "";
  return `<section id="repeats">
${sectionHead("Repeat offenders", `The same command shape, seen more than once. Paths are redacted before counting, so one command against many files counts as one repeat. <span class="screen-only">Select a guardrail to jump to it.</span>`)}
<div class="card repeat-wrap">
<table class="repeat-table">
<thead><tr><th scope="col">Command shape</th><th scope="col" class="n">Times</th><th scope="col" class="g">Guardrail</th></tr></thead>
<tbody id="repeat-body">
${rows}
</tbody>
</table>
</div>${limit}${more}
</section>`;
}

/** The two apps a report was not made from, for the set-up link. */
const OTHER_AGENTS: Readonly<Record<AgentSource, string>> = {
  claude: "Cursor or Codex",
  cursor: "Claude Code or Codex",
  codex: "Claude Code or Cursor",
};

/** Three steps, each with a command to copy, and where to read more. */
function nextStepsSection(result: ScanResult): string {
  const a = result.agent;
  const step = (n: string, title: string, text: string, command: string, name: string): string =>
    `<div class="card step"><span class="step-n">${n}</span><h3>${title}</h3><p>${text}</p>${copyable(`cmd-step-${n}`, command, name)}</div>`;
  return `<section id="next">
${sectionHead("Next steps", "Two commands to turn it on, and one to check again. No account.")}
<div class="steps">
${step("01", "Turn on AgentTrail Guard", "Install the hook, so these guardrails check each command before it runs.", `agenttrail-guard init --agent ${a}`, "Copy the step 1 command")}
${step("02", "See what it is doing", "Shows whether it is on, and what it decided recently.", "agenttrail-guard status", "Copy the step 2 command")}
${step("03", "Scan again next week", "See whether the counts fall. <code>--review</code> shows every line before the file is written.", `agenttrail-guard scan --agent ${a} --review`, "Copy the step 3 command")}
</div>
<div class="learn">${learnLink(siteLink("/get-started/guard", a, "next-commands"), "Every command")}${learnLink(siteLink("/guardrails", a, "next-library"), "The guardrail library")}${learnLink(siteLink("/get-started/guard", a, "next-agents"), `Set up ${OTHER_AGENTS[a]}`)}</div>
</section>`;
}

/**
 * The post preview: verified counts or totals (`shareText`), editable, with a count and a plain
 * link to X, under a note that says which kind of post it is.
 */
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
    : "This published copy cannot change the post. In the report file it was made from, the post can be edited before posting.";
  // A post with verified counts holds counts only; the totals post may name one library guardrail.
  const what =
    payload.shareText === totalsShareText(result)
      ? "Totals and at most one library guardrail&#39;s name"
      : "Counts from the checks on this machine, and nothing else";
  const rows = Math.max(3, payload.shareText.split("\n").length + 1);
  return `<section id="share" class="share">
${sectionHead("Share your result", `${what}: no commands, paths, project names or guardrails you wrote. ${edit}`)}
<figure class="card post">
<figcaption class="post-head"><span>Post preview</span>${ICONS.x}</figcaption>
<label class="sr-only" for="share-text">Post text</label>
<textarea class="post-text" id="share-text" rows="${rows}"${editable ? "" : " readonly"}>${escapeHtml(payload.shareText)}</textarea>
<div class="post-foot">
${outLink(shareLink(payload.shareText, result.agent), `${ICONS.x}<span>Post on X<span class="sr-only"> (opens in a new tab)</span></span>`, "btn btn-primary", ' id="share-link"')}
<button class="btn btn-secondary js-only" id="share-copy" type="button" data-copy="share-text" data-label="Copy text" aria-label="Copy text of the post">Copy text</button>
<span class="post-count" id="share-count" data-over="${length > POST_LIMIT ? "true" : "false"}">${escapeHtml(`${length} / ${POST_LIMIT}`)}</span>
</div>
</figure>
</section>`;
}

/** The redaction legend: what each placeholder stands for. */
const LEGEND = `<dl class="legend">
<dt><code>&lt;path&gt;</code></dt><dd>A redacted file path or URL</dd>
<dt><code>&lt;name&gt;</code> <code>&lt;host&gt;</code> <code>&lt;user&gt;</code></dt><dd>An identifying operand of a command, such as a container, a namespace, a machine or a login</dd>
<dt><code>&lt;message&gt;</code> <code>&lt;comment&gt;</code></dt><dd>A commit message, heredoc body or shell comment</dd>
<dt><code>&lt;value&gt;</code></dt><dd>A redacted MCP payload value</dd>
<dt><code>[REDACTED:&hellip;]</code></dt><dd>A redacted secret; <code>[REDACTED:secret:generic]</code> marks a long random-looking string masked on a best guess</dd>
<dt><code>&hellip;</code></dt><dd>Where a long command was shortened for display</dd>
</dl>`;

/**
 * How redaction works and where it can miss: the limits stated, not left to be discovered.
 *
 * Paths and working directories are redacted structurally, so "appear nowhere" holds.
 * Identifying names are removed for a fixed list of commands, a deny-list that cannot be
 * proved complete, and the text says so.
 */
function redactionDetails(result: ScanResult, variant: ReportVariant): string {
  const review = `<code>agenttrail-guard scan --agent ${escapeHtml(result.agent)} --review</code>`;
  const check =
    variant === "artifact"
      ? `Redaction is thorough but not a guarantee. Read the findings before passing this page on; the person who published it can check every line with ${review} before the file is written.`
      : `Redaction is thorough but not a guarantee. Read the findings before posting this anywhere public, and run ${review} to see every line before the file is written.`;
  // With no tool calls read, there are no findings to read and no post to share.
  const warning = result.toolCalls === 0 ? "" : `\n<p class="warning">${check}</p>`;
  return `<details class="more-info" id="redaction"><summary>How redaction works and where it can miss</summary><div>
<p>Every command in this report has been through a secret scrubber, a path redactor, a pass for secret-named values and long random-looking strings, and an identifier redactor, and every MCP tool call has had its payload values structurally redacted. Redaction runs before anything is written, so this file has never held the original text.</p>
<p>Working directories and file paths appear nowhere in this file, and the projects these sessions came from are carried as a count and never as names.</p>
<p><strong>Identifying names are a weaker claim than paths, and the difference is worth knowing.</strong> Shell commands go through an identifier redactor keyed to a fixed list of tools &mdash; container runtimes, <code>kubectl</code> (including resource names), the database clients (host, login, database, and the SQL handed to <code>-c</code> / <code>-e</code>), <code>ssh</code>, <code>git</code> commit messages and identity settings, 1Password&#39;s <code>op</code> (item and vault names), and <code>gh</code> titles and bodies &mdash; plus, in any command, a secret passed as a flag value (<code>--token</code>, <code>--password</code>, <code>--key</code>), a UUID, an AWS profile or resource id, the body of a heredoc, and the text of a <code>#</code> comment. That list is a deny-list and will miss the tool nobody thought of, so a bare operand naming a resource for a tool not on it can survive.</p>
<p>Cloud account identifiers are redacted where a name or flag gives them away: <code>CLOUDFLARE_ACCOUNT_ID</code> and <code>--account-id</code>, <code>wrangler</code> commands, AWS account numbers after <code>--account</code> or inside an ARN, and <code>--project</code> for <code>gcloud</code>, <code>gsutil</code>, <code>bq</code> and <code>firebase</code>.</p>
<p><strong>Secrets without a known format are caught by name and by shape, and both are guesses.</strong> A value after a name ending in <code>_KEY</code> or <code>-key</code>, an <code>Authorization</code> header, and any long random-looking string of 32 or more characters is masked. A secret that is shorter, that is only hexadecimal and has no revealing name, that is split by punctuation, or that has no name and is followed by a <code>.</code>, ends in <code>=</code> or is written as short dashed groups can survive. Branch names, folder names and git branch operands are kept readable and are not redacted.</p>
<p><strong>MCP tool calls are handled the other way round:</strong> a call to an MCP server arrives as a structured payload, and rather than deny-listing known-sensitive fields, every value in it is redacted to <code>&lt;value&gt;</code> by default and only the field names and the shape are kept.</p>
<p>Guardrail ids and titles are shown as their author wrote them &mdash; which for any guardrail you added yourself means your own words, unredacted. Read the commands and guardrail names above before posting this anywhere public.</p>${warning}
</div></details>`;
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

/** "What was scanned": what was read, and what could not be. */
function scannedDetails(result: ScanResult): string {
  const lines: string[] = [];
  lines.push(
    `Read ${escapeHtml(formatCount(result.sessions))} session${result.sessions === 1 ? "" : "s"} across ${escapeHtml(formatCount(result.projects))} project${result.projects === 1 ? "" : "s"}.`,
  );
  if (result.quarantined > 0) {
    lines.push(
      `${escapeHtml(formatCount(result.quarantined))} file${result.quarantined === 1 ? "" : "s"} yielded no session and ${result.quarantined === 1 ? "was" : "were"} skipped &mdash; a transcript holding no messages, such as a session started and abandoned, has nothing to report.`,
    );
  }
  // A reader that counts its skips lists them by kind under "What was not evaluated" instead.
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
  // A Codex page whose checks ran says how far their reading of Codex can be trusted. Without
  // the checks the page makes no claim about them.
  const codex =
    result.agent === "codex" && result.verification !== undefined
      ? `\n<p class="note codex-reading">${escapeHtml(CODEX_UNVERIFIED_TEXT)}</p>`
      : "";
  return `<details class="more-info" id="scanned"><summary>What was scanned</summary><div>
<p class="note">${lines.join(" ")}</p>${coverage === "" ? "" : `\n${coverage}`}${codex}
</div></details>`;
}

/** "What was not evaluated". Absent from a report whose reader counts none. */
function notEvaluatedDetails(payload: ReportPayload): string {
  const skipped = payload.skipped;
  if (skipped === undefined) return "";

  const phrases = skippedPhrases(skipped);
  const kinds =
    phrases.length === 0
      ? `<p class="note">Every line of every session file that was opened was read.</p>`
      : `<ul class="more-list">\n${phrases.map((phrase) => `<li>${escapeHtml(phrase)}</li>`).join("\n")}\n</ul>`;

  const tools =
    skipped.unmappedTools.length === 0
      ? ""
      : `\n<p class="note">Tool calls this reader does not recognize, by name:</p>\n<ul class="shapes">\n${skipped.unmappedTools
          .map(
            (tool) =>
              `<li><code class="cmd">${escapeHtml(tool.name)}</code><span class="times">${escapeHtml(formatCount(tool.count))}&times;</span></li>`,
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

  return `<details class="more-info" id="not-evaluated"><summary>What was not evaluated</summary><div>
<p class="note">None of this stopped the scan. Each line of a session file is read on its own, and whatever could not be used is counted here.</p>
${kinds}${tools}${notes.map((note) => `\n<p class="note">${escapeHtml(note)}</p>`).join("")}
</div></details>`;
}

/** "Before you share this": the checks, the redaction legend, and the limits behind expanders. */
function privacySection(
  result: ScanResult,
  payload: ReportPayload,
  meta: ReportMeta,
  variant: ReportVariant,
): string {
  const made =
    variant === "artifact" ? "Published by the person who ran it." : "Made on this machine.";
  return `<section id="privacy">
${sectionHead("Before you share this", "Built to be shared. Still worth a read before you post it anywhere public.")}
<div class="card privacy">
<ul class="checks">
<li>${ICONS.check}<span><strong>${made}</strong> <span class="provenance">${provenance(result, meta, variant)}</span></span></li>
<li>${ICONS.check}<span><strong>Secrets, paths and identifiers redacted</strong> before anything was written. This file never held the original text.</span></li>
<li>${ICONS.check}<span><strong>Project names never appear</strong>, only a count of projects.</span></li>
<li class="note screen-only">${ICONS.info}<span><strong>Saving a PDF?</strong> Turn off headers and footers in the print dialog, so the file&rsquo;s location on your disk is not printed on every page.</span></li>
</ul>
${LEGEND}
</div>
${redactionDetails(result, variant)}
${scannedDetails(result)}${(() => {
  const more = notEvaluatedDetails(payload);
  return more === "" ? "" : `\n${more}`;
})()}
</section>`;
}

/**
 * Token usage, collapsed. The cache-write split is withheld entirely when no turn reported one,
 * and the section is omitted for sessions that record no token counts.
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
        `<tr><th scope="row">${escapeHtml(label ?? "")}</th><td>${escapeHtml(value ?? "")}</td></tr>`,
    )
    .join("\n");

  const splitNote =
    t.turnsWithSplit > 0
      ? `<p>The 5-minute / 1-hour split is reported separately by the model and is not derived from the total above; on real sessions the two do not always agree, so both are shown as reported.</p>`
      : `<p>None of these sessions reported a 5-minute / 1-hour cache-write split, so that row is omitted rather than shown as zero.</p>`;

  // "Read from cache" is cumulative: the cached prefix is re-read, and re-charged, on every
  // turn, so a long session's total dwarfs its distinct input.
  const cacheReadNote =
    t.cacheRead > 0
      ? `<p>"Read from cache" is cumulative — the cached prefix is re-read and re-charged every turn, so this counts the same tokens many times over a session. It is a total of what the model billed for, not of distinct input.</p>`
      : "";

  return `<section id="usage">
<details class="more-info card" id="tokens"><summary>Token usage for these sessions</summary><div class="usage-body">
<table class="kv"><tbody>
${body}
</tbody></table>
<div class="muted"><p>Read straight from the transcripts, so these are exact counts and not estimates.</p>${cacheReadNote}${splitNote}</div>
</div></details>
</section>`;
}

/** The OS panel's line about what this machine could not confirm, from the review cards. */
export const OS_REVIEW: SentenceTemplate<readonly CardView[]> = {
  id: "os.review",
  render: (cards) => {
    const review = cards.filter((card) => card.tone === "review");
    if (review.length === 0) return undefined;
    const titles = review.map((card, i) =>
      i === 0 ? CATEGORY_TITLES[card.category] : CATEGORY_TITLES[card.category].toLowerCase(),
    );
    return `${andList(titles)} ${review.length === 1 ? "needs" : "need"} a person to review: once a call has changed something remote, a scan on one machine can only report it.`;
  },
};

/** The AgentTrail OS panel. Claude Code reports only. */
function productNoteSection(result: ScanResult, cards: readonly CardView[] | undefined): string {
  if (result.agent !== "claude") return "";
  const a = result.agent;
  const { start, primary, secondary } = PRODUCT_NOTE;
  const [first, ...rest] = PRODUCT_NOTE.heading.split(". ");
  const heading =
    rest.length === 0
      ? escapeHtml(PRODUCT_NOTE.heading)
      : `${escapeHtml(`${first}.`)}<br class="br-md"> ${escapeHtml(rest.join(". "))}`;
  const review = cards === undefined ? undefined : sentence(OS_REVIEW, cards);
  const steps = PRODUCT_NOTE.steps
    .map((s) => `<li><b>${escapeHtml(s.title)}</b><span>${escapeHtml(s.text)}</span></li>`)
    .join("");
  return `<aside class="card product" id="os" aria-label="About AgentTrail OS">
<div>
<p class="eyebrow">${escapeHtml(PRODUCT_NOTE.eyebrow)}</p>
<h2>${heading}</h2>${review === undefined ? "" : `\n<p>${sentenceSpan(review)}</p>`}
<p>${escapeHtml(PRODUCT_NOTE.body)}</p>
<ol class="os-steps">${steps}</ol>
</div>
<div class="product-ctas">${outLink(siteLink(start.path, a, start.content), escapeHtml(start.label), "btn btn-primary")}${outLink(siteLink(primary.path, a, primary.content), escapeHtml(primary.label), "btn btn-secondary")}${outLink(siteLink(secondary.path, a, secondary.content), escapeHtml(secondary.label), "btn btn-secondary")}</div>
</aside>`;
}

/** The version line, the disclaimer and the source link, at the end of the report. */
function reportMeta(payload: ReportPayload, meta: ReportMeta): string {
  return `<div class="report-meta">
<p class="footer-brand">${LOGO_MARK_SVG}<span id="footer-version">agenttrail-guard ${escapeHtml(meta.version)} &middot; ${escapeHtml(payload.catalog)}</span></p>
<p>A finding is a guardrail that matched. It is not proof that anything went wrong, and each guardrail&#39;s entry in the library states what it can miss.</p>
<p>${outLink(REPOSITORY_URL, "Source on GitHub", undefined, ' id="source-link"')}</p>
</div>`;
}

/** The site's own footer: links to the product, resources and trust pages. */
function siteFooter(agent: AgentSource, year: number): string {
  const link = (path: string, content: string, label: string): string =>
    `<li>${outLink(siteLink(path, agent, content), escapeHtml(label))}</li>`;
  const column = (title: string, items: readonly string[]): string =>
    `<nav aria-label="${title} footer links"><p>${title}</p><ul>\n${items.join("\n")}\n</ul></nav>`;
  const social = (url: string, label: string, icon: string): string =>
    `<a href="${url}" target="_blank" rel="noopener noreferrer" aria-label="${label}">${icon}</a>`;
  return `<footer class="site-footer">
<div class="site-footer-inner">
<div class="sf-grid">
<div>
${outLink(siteLink("/", agent, "footer-home"), `<span role="img" aria-label="AgentTrail">${LOGO_LOCKUP_SVG}</span>`, undefined, ' aria-label="AgentTrail home"')}
<p class="sf-tagline">Give your AI agents room to work.<br>Keep the guardrails in your hands.</p>
<div class="sf-social">
${social(SOCIAL_LINKS.github, "AgentTrail on GitHub", ICONS.github)}
${social(SOCIAL_LINKS.x, "AgentTrail on X", ICONS.x)}
${social(SOCIAL_LINKS.linkedin, "AgentTrail on LinkedIn", ICONS.linkedin)}
${social(SOCIAL_LINKS.npm, "AgentTrail on npm", ICONS.npm)}
</div>
</div>
<div class="sf-cols">
${column("Product", [link("/agenttrail-guard", "footer-guard", "AgentTrail Guard"), link("/agenttrail-os", "footer-os", "AgentTrail OS"), link("/guard-vs-os", "footer-compare", "Guard vs OS"), link("/pricing", "footer-pricing", "Pricing")])}
${column("Resources", [link("/about", "footer-about", "About"), link("/blog", "footer-blog", "Blog"), link("/guardrails", "footer-library", "Guardrail library"), link("/security/owasp", "footer-owasp", "OWASP Top 10")])}
${column("Trust", [link("/security", "footer-security", "Security & Trust"), link("/subprocessors", "footer-subprocessors", "Subprocessors")])}
</div>
</div>
<div class="sf-bottom"><span>&copy; ${year} AgentTrail. All rights reserved.</span><a href="mailto:${SECURITY_EMAIL}">${SECURITY_EMAIL}</a></div>
</div>
</footer>`;
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
  const payload = reportPayload(result, meta, options.cardBuilders);
  // A scan that read no tool calls has no result to show or share: the page says so instead.
  const scanned = result.toolCalls > 0;
  // The verified lead, from the payload's cards: only with verification, and only over a scan
  // that read tool calls.
  const cards = scanned ? payload.cards : undefined;
  const lead =
    cards === undefined || payload.verification === undefined
      ? undefined
      : pickHeadline(cards, { ranEvidence: payload.verification.ranEvidence });
  const head = `<title>${escapeHtml(pageTitle(result, meta))}</title>
<style>${reportStyles(cards !== undefined)}${riskStyles(payload.owasp.map((t) => t.id))}</style>`;
  // Each section on its own lines; one that has nothing to say is left out entirely.
  const sections = [
    heroSection(result, payload, meta, variant, lead),
    ...(cards === undefined ? [] : [leadExtraSection(payload, cards, lead)]),
    statsSection(result),
    ...(cards === undefined || payload.verification === undefined
      ? []
      : [
          whatHappenedSection(
            payload.verification,
            cards,
            variant,
            options.localFixCategories ?? [],
            options.unsafeFixCategories ?? [],
          ),
        ]),
    ...(scanned
      ? [
          wouldHaveDoneSection(result, payload),
          owaspSection(payload),
          findingsSection(payload, variant),
          recurringSection(payload),
        ]
      : []),
    nextStepsSection(result),
    scanned ? shareSectionHtml(result, payload, variant) : "",
    privacySection(result, payload, meta, variant),
    scanned ? tokensSection(result) : "",
    productNoteSection(result, cards),
    reportMeta(payload, meta),
  ].filter((section) => section !== "");
  const printHead = `<div class="page print-only"><div class="print-head"><span role="img" aria-label="AgentTrail">${LOGO_LOCKUP_SVG}</span><span id="print-meta">${escapeHtml(pageTitle(result, meta))}</span></div></div>`;
  const body = `${topBar(payload)}
${printHead}
<main id="main" class="page" lang="en" tabindex="-1">
${sections.join("\n")}
<p id="page-status" class="sr-only" role="status" aria-live="polite"></p>
<textarea id="copy-buffer" class="sr-only" tabindex="-1" aria-hidden="true" readonly></textarea>
</main>
${siteFooter(result.agent, meta.generatedAt.getUTCFullYear())}
<div class="toast" id="toast" aria-hidden="true"></div>`;

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
export function reviewStrings(
  result: ScanResult,
  /** The card builders. For tests; the report uses `CARD_BUILDERS`. */
  builders: CardBuilders = CARD_BUILDERS,
): readonly ReviewGroup[] {
  const payload = reportPayload(result, { version: "", generatedAt: new Date(0) }, builders);
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
  const verified = verifiedLines(payload).flatMap(take);
  if (verified.length > 0) {
    groups.push({
      label: "What the checks found on this machine, by count and kind, never a value",
      lines: verified,
    });
  }
  if (payload.findings.length > 0) {
    groups.push({ label: "The suggested post, which you can edit", lines: [payload.shareText] });
  }
  return groups;
}

/**
 * Every line the verified sections write, as the page writes it. A card's lines are prefixed
 * with its title, two spaces apart, so each piece is a string the file carries.
 */
function verifiedLines(payload: ReportPayload): string[] {
  const cards = payload.toolCalls > 0 ? payload.cards : undefined;
  if (cards === undefined || payload.verification === undefined) return [];
  const lines: string[] = [];
  const lead = pickHeadline(cards, { ranEvidence: payload.verification.ranEvidence });
  if (lead?.headline !== undefined) {
    lines.push(heroHeadline(lead.headline, payload.agent).text);
    for (const line of leadSentences(lead, payload)) lines.push(line.text);
  }
  const facts = payload.verification.categories.secrets.facts;
  for (const item of facts.items.slice(0, EVIDENCE_ROWS)) {
    const way = primaryWay(item.via);
    lines.push(
      `${KIND_LABELS[item.kind] ?? KIND_LABELS.other}  ${way === undefined ? "" : PROVENANCE_PHRASES[way]}  ${countOf(item.files, "file")}`,
    );
  }
  const more = MORE_EVIDENCE.render({
    more: facts.moreItems + Math.max(0, facts.items.length - EVIDENCE_ROWS),
  });
  if (more !== undefined) lines.push(more);
  for (const chip of chipsFor(cards, lead)) lines.push(chip.label);
  const forms = sentence(HIDING_FORMS_LIST, cards);
  if (forms !== undefined) lines.push(forms.text);
  for (const card of cards) {
    const title = CATEGORY_TITLES[card.category];
    const count = cardCount(card);
    if (count !== undefined) lines.push(`${title}  ${count.text}`);
    for (const line of [...card.found, ...card.now, ...(card.fixSteps ?? [])]) {
      lines.push(`${title}  ${line.text}`);
    }
    for (const fix of card.fixes.slice(0, MAX_CARD_COMMANDS)) lines.push(`${title}  ${fix.shape}`);
    if (card.read !== undefined) lines.push(`${title}  ${card.read.text}`);
    if (card.caveat !== undefined) lines.push(`${title}  ${card.caveat.text}`);
    const caveat = sentence(CODEX_CAVEAT, card);
    if (caveat !== undefined) lines.push(`${title}  ${caveat.text}`);
  }
  // The section's note under the cards.
  for (const note of leadNotes(payload.verification)) lines.push(note.text);
  // Each finding's note, after its guardrail's id, as its row shows them.
  for (const note of payload.notes ?? []) lines.push(`${note.ruleId}  ${note.sentence.text}`);
  const review = payload.agent === "claude" ? sentence(OS_REVIEW, cards) : undefined;
  if (review !== undefined) lines.push(review.text);
  return lines;
}

/**
 * The `--json` payload: the whole redacted `ScanResult`, plus the metadata the footer
 * carries. It goes to the user's own terminal or pipe, so it is not capped; the file's own
 * export button is `reportPayload`.
 */
export function renderJson(result: ScanResult, meta: ReportMeta): string {
  // The verification goes through the same boundary as the file, uncapped: facts may carry
  // only registered enums and keys.
  const safe: ScanResult =
    result.verification === undefined
      ? result
      : { ...result, verification: boundaryVerification(result.verification, false) };
  return `${JSON.stringify(
    {
      tool: "agenttrail-guard",
      version: meta.version,
      generatedAt: meta.generatedAt.toISOString(),
      catalog: formatCatalogStamp(catalogStamp(), meta.generatedAt),
      // A Codex scan whose checks ran says, in --json too, how far their reading can be trusted.
      ...(result.agent === "codex" && result.verification !== undefined
        ? { notes: [CODEX_UNVERIFIED_TEXT] }
        : {}),
      result: safe,
    },
    null,
    2,
  )}\n`;
}
