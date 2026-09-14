// cspell:words Consolas hellip Menlo middot Neue
/**
 * `agenttrail-guard-report.html` — one self-contained file.
 *
 * ── The constraint that shapes every line below ──────────────────────────────
 * "It must render from a `file://` URL with the wifi off, and it must not phone home
 * when someone opens it." So: inline `<style>`, no `<script>`, no `<img>`, no `<link>`,
 * no `@import`, no `url(…)`, no web font, and **not a single external reference of any
 * kind**. `report.test.ts` asserts each of those over the generated string, each with a
 * negative control proving the assertion fires on a fixture that violates it.
 *
 * ── The repository URL in the footer is TEXT, not a link ─────────────────────
 * An `<a href>` would be inert until clicked and would not phone home — but making it a
 * link means the self-containment assertion needs a carve-out for one permitted `href`,
 * and a carve-out is easy to widen. A URL a reader can select and paste costs them one action and
 * makes "this file references nothing outside itself" a total, checkable claim.
 *
 * ── No call to action ─────────────────────────────────────────────────────────
 * The file is meant to be shareable. The footer says what the tool is and where the
 * source lives, and stops.
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
import type { ScanResult } from "./scan-report.js";
import { formatCount, formatTokens, totalTokens } from "./tokens.js";

/** Where the source lives. Rendered as text; see the header. */
export const REPOSITORY_URL = "https://github.com/agenttrailhq/guard";

/** The report's filename, used by `commands/scan.ts`. */
export const REPORT_FILENAME = "agenttrail-guard-report.html";

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

/** A severity's display class. Unknown severities fall to the neutral tone. */
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
    default:
      return "sev-unknown";
  }
}

/** What the guard would have done, in words rather than in the engine's vocabulary. */
function actionLabel(action: string): string {
  switch (action) {
    case "block":
      return "would block";
    case "require_approval":
      return "would ask";
    default:
      return "would warn";
  }
}

/** One `<div class="stat">`. */
function stat(value: string, label: string, note?: string): string {
  const noteHtml = note === undefined ? "" : `<div class="stat-note">${escapeHtml(note)}</div>`;
  return `<div class="stat"><div class="stat-value">${escapeHtml(value)}</div><div class="stat-label">${escapeHtml(label)}</div>${noteHtml}</div>`;
}

/** The hero strip. */
function heroSection(result: ScanResult): string {
  const t = result.tokens;
  const cells = [
    stat(formatCount(result.sessions), result.sessions === 1 ? "session" : "sessions"),
    stat(formatCount(result.toolCalls), "tool calls"),
    stat(formatCount(result.riskyActions), "risky actions"),
    stat(formatCount(result.recurring.length), "recurring mistakes"),
    stat(formatTokens(totalTokens(t)), "tokens", `${formatTokens(t.cacheRead)} read from cache`),
  ];
  return `<section class="stats">${cells.join("")}</section>`;
}

/**
 * The token detail table.
 *
 * The cache-write split is a SEPARATE row from the aggregate and is withheld entirely
 * when no turn reported one — see the module header, and `tokens.ts` on why the two
 * are never derived from each other.
 */
function tokensSection(result: ScanResult): string {
  const t = result.tokens;
  const rows = [
    ["Input", formatCount(t.input)],
    ["Output", formatCount(t.output)],
    ["Read from cache", formatCount(t.cacheRead)],
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
    .join("");

  const splitNote =
    t.turnsWithSplit > 0
      ? `<p class="note">The 5-minute / 1-hour split is reported separately by the model and is not derived from the total above; on real sessions the two do not always agree, so both are shown as reported.</p>`
      : `<p class="note">None of these sessions reported a 5-minute / 1-hour cache-write split, so that row is omitted rather than shown as zero.</p>`;

  return `<section><h2>Tokens</h2><p class="note">Read straight from the transcripts, so these are exact counts and not estimates.</p><table class="kv">${body}</table>${splitNote}</section>`;
}

/** The findings table. */
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
        .join("");
      const more =
        finding.examples.length > MAX_EXAMPLES
          ? `<li class="more">and ${escapeHtml(formatCount(finding.examples.length - MAX_EXAMPLES))} more shapes</li>`
          : "";
      return `<tr>
    <td>
      <div class="guardrail-title">${escapeHtml(finding.title)}</div>
      <div class="guardrail-id"><code>${escapeHtml(finding.ruleId)}</code></div>
      <ul class="shapes">${examples}${more}</ul>
    </td>
    <td><span class="badge ${severityClass(finding.severity)}">${escapeHtml(finding.severity)}</span></td>
    <td class="action">${escapeHtml(actionLabel(finding.action))}</td>
    <td class="num">${escapeHtml(formatCount(finding.count))}</td>
  </tr>`;
    })
    .join("");

  const truncated =
    result.findings.length > MAX_ROWS
      ? `<p class="note">${escapeHtml(formatCount(result.findings.length - MAX_ROWS))} further guardrails matched and are not listed here.</p>`
      : "";

  return `<section><h2>Findings</h2>
<div class="table-wrap"><table class="findings">
  <thead><tr><th>Guardrail</th><th>Severity</th><th>Action</th><th class="num">Matches</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>${truncated}</section>`;
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
        `<tr><td><code>${escapeHtml(item.text)}</code></td><td class="num">${escapeHtml(formatCount(item.count))}&times;</td><td>${escapeHtml(item.title)}</td></tr>`,
    )
    .join("");
  return `<section><h2>Recurring issues</h2>
<p class="note">The same shape, seen more than once. Paths are redacted before counting, so many different paths under one command become one repeat.</p>
<div class="table-wrap"><table class="recurring"><tbody>${rows}</tbody></table></div></section>`;
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
  if (result.skippedLines > 0) {
    lines.push(
      `${escapeHtml(formatCount(result.skippedLines))} individual line${result.skippedLines === 1 ? "" : "s"} could not be parsed and ${result.skippedLines === 1 ? "was" : "were"} skipped.`,
    );
  }

  // The reader's own coverage limit, stated rather than left to be discovered. A
  // report that silently covers a quarter of the corpus is the same class of failure
  // as one that over-claims, pointed the other way — and this one reads as good news.
  const coverage =
    result.notRead > 0
      ? `<p class="note"><strong>Coverage limit.</strong> This reader opens one transcript per session directly under each project, and does not descend into a session&#39;s own directory. ${escapeHtml(formatCount(result.notRead))} further transcript file${result.notRead === 1 ? "" : "s"} sit${result.notRead === 1 ? "s" : ""} there. Those belong to sessions already counted above rather than being sessions of their own &mdash; sub-agent transcripts, typically &mdash; so what is missing from the numbers on this page is the actions sub-agents took, not the sessions themselves. Every count above is of what was read, not of everything that exists.</p>`
      : "";

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
  return `<section><h2>What was scanned</h2><p class="note">${lines.join(" ")}</p>${coverage}
<p class="note">Working directories and file paths appear nowhere in this file, and the projects these sessions came from are carried as a count and never as names.</p>
<p class="note"><strong>Identifying names are a weaker claim, and the difference is worth knowing.</strong> Commands also go through an identifier redactor, which knows a fixed list of tools &mdash; container runtimes, <code>kubectl</code>, the database clients, <code>ssh</code> and <code>git</code> messages. A bare operand naming a container, a namespace, a host or a database is removed for a tool on that list, and may survive for one that is not. Guardrail ids and titles are shown as their author wrote them &mdash; which for any guardrail you added yourself means your own words, unredacted. Redaction is thorough but not a guarantee. Read the commands and guardrail names above before posting this anywhere public.</p></section>`;
}

/** Inline stylesheet. No `url(…)`, no `@import`, no web font — see the module header. */
const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #ffffff; --fg: #111827; --muted: #5b6472; --line: #e3e6ea;
  --card: #f7f8fa; --code: #eef1f4; --accent: #2563eb;
  --crit: #b42318; --high: #b54708; --med: #854d0e; --low: #3f6212; --unk: #5b6472;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0e1116; --fg: #e6e9ee; --muted: #9aa4b2; --line: #232a33;
    --card: #161b22; --code: #1b2129; --accent: #7aa2f7;
    --crit: #ff8a80; --high: #ffb86b; --med: #f2d472; --low: #a5d66f; --unk: #9aa4b2;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2.5rem 1.25rem 4rem;
  background: var(--bg); color: var(--fg);
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
main { max-width: 62rem; margin: 0 auto; }
h1 { font-size: 1.6rem; margin: 0 0 .35rem; letter-spacing: -.01em; }
h2 { font-size: 1.05rem; margin: 0 0 .75rem; letter-spacing: -.005em; }
section { margin-top: 2.5rem; }
p { margin: 0 0 .75rem; }
code {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: .86em; background: var(--code); padding: .12em .38em; border-radius: 4px;
  overflow-wrap: anywhere;
}
.subtitle { color: var(--muted); margin: 0; }
.note { color: var(--muted); font-size: .88rem; }
.empty { color: var(--muted); font-style: italic; }
.stats { display: flex; flex-wrap: wrap; gap: .75rem; margin-top: 1.75rem; }
.stat {
  flex: 1 1 8.5rem; background: var(--card); border: 1px solid var(--line);
  border-radius: 10px; padding: .9rem 1rem;
}
.stat-value { font-size: 1.5rem; font-weight: 650; letter-spacing: -.02em; }
.stat-label { color: var(--muted); font-size: .82rem; margin-top: .1rem; }
.stat-note { color: var(--muted); font-size: .74rem; margin-top: .3rem; }
table { width: 100%; border-collapse: collapse; }
.table-wrap { overflow-x: auto; }
th, td { text-align: left; padding: .6rem .5rem; border-bottom: 1px solid var(--line); vertical-align: top; }
thead th { color: var(--muted); font-weight: 600; font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.kv th { color: var(--muted); font-weight: 500; }
.guardrail-title { font-weight: 600; }
.guardrail-id { margin-top: .15rem; }
.shapes { list-style: none; margin: .5rem 0 0; padding: 0; }
.shapes li { margin-bottom: .2rem; }
.shapes .times { color: var(--muted); font-size: .8rem; margin-left: .5rem; }
.shapes .more { color: var(--muted); font-size: .8rem; font-style: italic; }
.action { color: var(--muted); white-space: nowrap; }
.badge {
  display: inline-block; border: 1px solid currentColor; border-radius: 999px;
  padding: .05rem .5rem; font-size: .74rem; font-weight: 600; text-transform: uppercase;
  letter-spacing: .03em; white-space: nowrap;
}
.sev-critical { color: var(--crit); }
.sev-high { color: var(--high); }
.sev-medium { color: var(--med); }
.sev-low { color: var(--low); }
.sev-unknown { color: var(--unk); }
footer {
  margin-top: 3.5rem; padding-top: 1.25rem; border-top: 1px solid var(--line);
  color: var(--muted); font-size: .82rem;
}
footer p { margin: 0 0 .35rem; }
`;

/**
 * Render the whole report.
 *
 * Pure: the same result and the same `generatedAt` produce the same bytes, which is
 * what lets the suite assert over the string instead of over a file on disk.
 */
export function renderReport(result: ScanResult, meta: ReportMeta): string {
  // Through the SEAM, not a hard-coded `undefined`: `catalogStamp()` returns nothing
  // when the bundled catalog carries no stamp, and the footer says so. Once
  // it does, this line starts printing a real version with no edit here.
  const catalogLine = formatCatalogStamp(catalogStamp(), meta.generatedAt);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agenttrail guard scan report</title>
<style>${STYLES}</style>
</head>
<body>
<main>
<header>
<h1>agenttrail guard &mdash; scan report</h1>
<p class="subtitle">What your coding agent actually did, and which guardrails would have fired.</p>
<p class="note">Generated ${escapeHtml(meta.generatedAt.toISOString())} by agenttrail-guard ${escapeHtml(meta.version)}. Produced entirely on this machine from transcripts already on disk &mdash; no account, nothing uploaded, and no network call: the one exception anywhere in this tool is crash reporting, which is off unless you turn it on and which a scan never uses.</p>
</header>
${heroSection(result)}
<section>
<h2>Before you share this</h2>
<p class="note">Every command below has been through a secret scrubber, a path redactor and an identifier redactor. <code>&lt;path&gt;</code> stands for a redacted filesystem path or URL; <code>&lt;name&gt;</code>, <code>&lt;host&gt;</code>, <code>&lt;user&gt;</code> and <code>&lt;message&gt;</code> stand for an identifying operand of a command &mdash; a container, a namespace, a machine, a login, a commit message; <code>[REDACTED:&hellip;]</code> stands for a redacted secret. Redaction runs before anything is written, so this file has never held the original text.</p>
<p class="note">Redaction is thorough but not a guarantee. Read the findings before posting this anywhere public, and run <code>agenttrail-guard scan --review</code> to see every line before the file is written.</p>
</section>
${findingsSection(result)}
${recurringSection(result)}
${tokensSection(result)}
${corpusSection(result)}
<footer>
<p>agenttrail-guard ${escapeHtml(meta.version)} &middot; ${escapeHtml(catalogLine)}</p>
<p>Source: ${escapeHtml(REPOSITORY_URL)}</p>
<p>A finding is a guardrail that matched. It is not proof that anything went wrong, and the guardrails state their own coverage limits.</p>
</footer>
</main>
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

  const groups: ReviewGroup[] = [];
  if (guardrails.length > 0)
    groups.push({ label: "Guardrails named in the report", lines: guardrails });
  if (commands.length > 0) groups.push({ label: "Command shapes in the report", lines: commands });
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
