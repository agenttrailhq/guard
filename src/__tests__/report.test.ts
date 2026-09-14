/**
 * `core/report.ts` — a self-contained report, with no currency.
 *
 * Every self-containment assertion here is paired with a NEGATIVE CONTROL that runs
 * the same matcher over a fixture string containing the banned form. Without them the
 * suite would keep passing if the generator started returning the empty string, or if
 * a regex were edited into one that matches nothing — both of which are exactly the
 * silent failure the assertions exist to prevent.
 */

import { CATALOG_VERSION } from "@agenttrail/guardrails/guardrails";
import { describe, expect, it } from "vitest";
import { compileAllowlist } from "../core/evaluate.js";
import {
  escapeHtml,
  MAX_EXAMPLES,
  MAX_ROWS,
  REPORT_FILENAME,
  REPOSITORY_URL,
  type ReportMeta,
  renderJson,
  renderReport,
  reviewStrings,
} from "../core/report.js";
import { compileCatalog } from "../core/rules.js";
import { aggregateScan, type ScanCorpus, type ScanResult } from "../core/scan-report.js";
import { bash, session, TEST_CATALOG, toolUse, turn } from "./scan-fixtures.js";

const CATALOG = compileCatalog(TEST_CATALOG);
const META: ReportMeta = { version: "0.1.0", generatedAt: new Date("2026-09-08T09:00:00.000Z") };

function resultOf(corpus: Partial<ScanCorpus> = {}): ScanResult {
  return aggregateScan(
    { sessions: [], quarantined: 0, notRead: 0, projects: 0, ...corpus },
    CATALOG,
    compileAllowlist([]),
  );
}

/** A corpus that exercises every section: two rules, a repeat, tokens, a quarantine. */
const POPULATED = resultOf({
  sessions: [
    session([
      turn(
        [
          bash("rm -rf /Users/priya/clients/acme/build", "1"),
          bash("rm -rf /Users/priya/clients/beta/dist", "2"),
          bash("git checkout -- src/billing.ts", "3"),
          toolUse("Read", { file_path: "/srv/app/.env" }, "4"),
          bash("ls -la", "5"),
        ],
        {
          input_tokens: 1200,
          output_tokens: 340,
          cache_read_input_tokens: 98_000,
          cache_creation_input_tokens: 4200,
          cache_creation: { ephemeral_5m_input_tokens: 4000, ephemeral_1h_input_tokens: 200 },
        },
      ),
    ]),
  ],
  quarantined: 2,
  projects: 3,
});

const HTML = renderReport(POPULATED, META);

describe("the report is self-contained — nothing outside the file is referenced", () => {
  const BANNED: readonly [string, RegExp, string][] = [
    ["a script tag", /<script/i, "<script>alert(1)</script>"],
    ["a src attribute", /\ssrc\s*=/i, `<img src="x.png">`],
    ["a link tag", /<link\b/i, `<link rel="stylesheet" href="x.css">`],
    ["an href", /\shref\s*=/i, `<a href="https://example.com">x</a>`],
    ["a CSS import", /@import/i, `@import url("x.css");`],
    ["a CSS url()", /url\s*\(/i, `background: url(x.png);`],
    ["an iframe", /<iframe/i, `<iframe src="x"></iframe>`],
    ["an inline event handler", /\son[a-z]+\s*=\s*["']/i, `<div onclick="x()">y</div>`],
    ["a form", /<form\b/i, `<form action="https://x"></form>`],
  ];

  it.each(BANNED)("contains no %s", (_label, pattern) => {
    expect(HTML).not.toMatch(pattern);
  });

  it.each(
    BANNED,
  )("negative control — the %s matcher DOES fire on a violating fixture", (_label, pattern, violating) => {
    expect(violating).toMatch(pattern);
  });

  it("contains no http(s) reference at all, not even in a comment", () => {
    // The repository URL is the one URL in the file and it is deliberately TEXT. It is
    // still a `https://` substring, so the assertion is scoped to "no URL other than
    // that one" rather than "no URL", and the count is pinned so a second one shows up.
    const urls = HTML.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
    expect(urls).toEqual([REPOSITORY_URL]);
  });

  it("is a complete HTML document, not a fragment", () => {
    expect(HTML.startsWith("<!doctype html>")).toBe(true);
    expect(HTML).toContain("<title>");
    expect(HTML.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("carries its whole stylesheet inline", () => {
    expect(HTML).toContain("<style>");
    expect(HTML).toContain("prefers-color-scheme");
  });
});

describe("no currency, in any spelling", () => {
  /**
   * A currency word. These cannot be shell syntax, so they are banned everywhere.
   */
  const CURRENCY_WORD = /\bUSD\b|\bdollars?\b|\bestimated\b|\brisk avoided\b/i;
  /** A currency SYMBOL. Banned in the guard's own chrome — see below for why not everywhere. */
  const CURRENCY_SYMBOL = /[$£€¥]/;

  /**
   * The report minus every quoted command.
   *
   * The distinction is not a loophole. A report can contain `$` characters such as
   * `${DB}` and `$?` inside commands the user's agent actually ran, and `redactPaths`
   * preserves a shell variable on purpose
   * so a rule's coverage limit stays visible. A blanket ban would have to redact `$`,
   * which would hide exactly the coverage limit the rule descriptions state — and `awk '{print $1}'` would trip even a money-shaped `\$\d` matcher.
   *
   * The rule is about what the GUARD claims, not about what the user typed. So the
   * chrome — every word this tool wrote — carries no currency symbol at all, and the
   * `<code>` spans are quoted input.
   */
  const chrome = HTML.replace(/<code>[\s\S]*?<\/code>/g, "");

  it("no currency symbol anywhere in the guard's own words", () => {
    expect(chrome).not.toMatch(CURRENCY_SYMBOL);
  });

  it("no currency WORD anywhere at all, chrome or quoted command", () => {
    expect(HTML).not.toMatch(CURRENCY_WORD);
    expect(renderJson(POPULATED, META)).not.toMatch(CURRENCY_WORD);
  });

  it("in the JSON, a currency symbol can only ever be inside a quoted command", () => {
    // Walked rather than grepped: every string on the payload is checked, and the
    // command-shape fields are the only ones allowed to carry a `$`.
    const payload = JSON.parse(renderJson(POPULATED, META));
    const offenders: string[] = [];
    const walk = (node: unknown, key: string): void => {
      if (typeof node === "string") {
        if (key !== "text" && CURRENCY_SYMBOL.test(node)) offenders.push(`${key}: ${node}`);
      } else if (Array.isArray(node)) {
        for (const item of node) walk(item, key);
      } else if (node !== null && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) walk(v, k);
      }
    };
    walk(payload, "root");
    expect(offenders).toEqual([]);
  });

  it("negative control — both matchers fire on the headline they exist to prevent", () => {
    const headline = "rm -rf seen 17 times, $5,070,000 estimated risk avoided";
    expect(headline).toMatch(CURRENCY_WORD);
    expect(headline).toMatch(CURRENCY_SYMBOL);
  });

  it("negative control — the chrome strip does not simply empty the document", () => {
    // Without this, "the chrome has no `$`" would pass on an empty string.
    expect(chrome.length).toBeGreaterThan(2000);
    expect(chrome).toContain("Findings");
  });

  it("a shell variable in a command SURVIVES, which is the point of the split", () => {
    const withVar = resultOf({
      sessions: [session([turn([bash("rm -rf $DIR && rm -rf /tmp/x", "1")])])],
      projects: 1,
    });
    const html = renderReport(withVar, META);
    expect(html).toContain("$DIR");
    expect(html.replace(/<code>[\s\S]*?<\/code>/g, "")).not.toMatch(CURRENCY_SYMBOL);
  });
});

describe("what the report says", () => {
  it("leads with the counts, and they are the aggregator's", () => {
    expect(HTML).toContain(">5<"); // tool calls
    expect(HTML).toContain("risky actions");
    expect(HTML).toContain("recurring mistakes");
  });

  it("names each matched guardrail, its severity and what it would have done", () => {
    expect(HTML).toContain("Recursive delete");
    expect(HTML).toContain("t.rm-rf");
    expect(HTML).toContain("critical");
    expect(HTML).toContain("would block");
    expect(HTML).toContain("would ask");
  });

  it("shows a repeat as one shape with its count, not as two rows", () => {
    // The two `rm -rf` calls differ only by path, so redaction makes them one shape.
    expect(HTML).toContain("rm -rf &lt;path&gt;");
    expect(HTML).toContain("Recurring issues");
  });

  it("reports the skipped files, and does not imply they were corrupt", () => {
    // A skipped file is usually a session with no messages, not a corrupt one. "Could not
    // be read" reads as corruption and would send someone looking for a problem that is
    // not there.
    expect(HTML).toContain("yielded no session");
    expect(HTML).toContain("session started and abandoned");
    expect(HTML).not.toContain("could not be read as a transcript");
  });

  it("states the reader's coverage limit when files were not read", () => {
    const under = resultOf({ sessions: [session([])], projects: 1, notRead: 751 });
    const html = renderReport(under, META);
    expect(html).toContain("Coverage limit");
    expect(html).toContain("751 further transcript files");
    expect(html).toContain("does not descend into a session");
  });

  it("the coverage note DENIES the alarming reading rather than inviting it", () => {
    // "Sessions filed deeper are outside these numbers" would tell a reader they are
    // missing most of their history. The nested files are sub-agent transcripts inside
    // sessions that WERE counted, and overstating a gap misleads as much as hiding one.
    const html = renderReport(
      resultOf({ sessions: [session([])], projects: 1, notRead: 751 }),
      META,
    );
    expect(html).toContain("belong to sessions already counted above");
    expect(html).toContain("rather than being sessions of their own");
    expect(html).toContain("the actions sub-agents took, not the sessions themselves");
    expect(html).not.toContain("sessions filed deeper");
    // The closing line stays: it frames every number on the page.
    expect(html).toContain("Every count above is of what was read, not of everything that exists.");
  });

  it("says nothing about coverage when everything under the root was read", () => {
    // A caveat printed unconditionally is noise, and noise is how a real caveat stops
    // being read.
    expect(HTML).not.toContain("Coverage limit");
  });

  it("renders a severity and an action it has never seen, rather than dropping the row", () => {
    // Not hypothetical: the 56 shipped rules are authored against a shared schema
    // whose `severity` is a free string, and `@agenttrail/guardrails` is a separate
    // package on a separate release cadence. A rule carrying `severity: "informational"`
    // must still produce a row — a report that silently omits a finding because it did
    // not recognise a label is the exact failure mode this report exists to avoid.
    const exotic = aggregateScan(
      { sessions: [], quarantined: 0, notRead: 0, projects: 0 },
      compileCatalog([
        {
          id: "t.exotic",
          category: "prod-infra",
          severity: "informational",
          defaultAction: "warn",
          title: "A severity the renderer has never seen",
          description: "Present so the unknown-severity branch is exercised.",
          match: { any_of: [{ kind: "execute_tool", label: "Bash", detail_contains: ["boom"] }] },
        },
      ]),
      compileAllowlist([]),
    );
    // Nothing matched, so drive the renderer through a hand-built finding instead.
    const withExotic = {
      ...exotic,
      findings: [
        {
          ruleId: "t.exotic",
          title: "A severity the renderer has never seen",
          severity: "informational",
          action: "warn" as const,
          count: 1,
          examples: [{ text: "boom", count: 1 }],
        },
      ],
    };
    const html = renderReport(withExotic, META);
    expect(html).toContain("informational");
    expect(html).toContain("sev-unknown");
    expect(html).toContain("would warn");
  });

  it("uses the singular verb for exactly one skipped file or line", () => {
    const one = resultOf({ sessions: [session([turn([], {})], 1)], projects: 1, quarantined: 1 });
    const html = renderReport(one, META);
    expect(html).toContain("1 file yielded no session and was skipped");
    expect(html).toContain("1 individual line could not be parsed and was skipped.");
  });

  it("prints the project COUNT and never a project name", () => {
    expect(HTML).toContain("3 projects");
    expect(HTML).not.toContain("priya");
    expect(HTML).not.toContain("acme");
  });

  it("carries the tool version, the catalog line and the repository URL", () => {
    expect(HTML).toContain("agenttrail-guard 0.1.0");
    expect(HTML).toContain(REPOSITORY_URL);
  });

  it("carries the BUNDLED catalog's version and age, distinct from the tool's", () => {
    // The two versions sit side by side in the footer and answer different questions:
    // `agenttrail-guard 0.1.0` is the tool, `guardrail library v0.0.1` is the corpus that
    // determines which rules this user actually has. `META.generatedAt` is fixed, so
    // the age is deterministic here.
    expect(HTML).toContain(`guardrail library v${CATALOG_VERSION}, published `);
    expect(HTML).toMatch(/guardrail library v\d+\.\d+\.\d+, published (today|\d+ days? ago)/);
    expect(HTML).not.toContain("not yet stamped");
  });

  it("has no call to action", () => {
    expect(HTML).not.toMatch(/sign up|free trial|get started|upgrade|book a demo/i);
  });

  it("says a finding is not proof that anything went wrong", () => {
    expect(HTML).toContain("It is not proof that anything went wrong");
  });
});

describe("the token section only claims what it can source", () => {
  /** The split ROW's label. The explanatory note also names the split, so the row is
   * identified by its own label rather than by the words "5-minute / 1-hour", which
   * appear in both cases and would make the withheld-row assertion untestable. */
  const SPLIT_ROW = "…of which 5-minute / 1-hour";

  it("shows the 5m / 1h split when a session reported one", () => {
    expect(HTML).toContain(SPLIT_ROW);
    expect(HTML).toContain("4,000 / 200");
    expect(HTML).toContain("is not derived from the total above");
  });

  it("WITHHOLDS the split row when no session reported one, and says so", () => {
    // Withheld, not zeroed: "nobody reported a split" and "the split was 0" are two
    // different facts, and only one of them is true here.
    const noSplit = resultOf({
      sessions: [session([turn([bash("ls", "1")], { cache_creation_input_tokens: 500 })])],
      projects: 1,
    });
    const html = renderReport(noSplit, META);
    expect(html).not.toContain(SPLIT_ROW);
    expect(html).toContain("None of these sessions reported");
    // The aggregate it DOES have is still printed.
    expect(html).toContain("Written to cache");
  });

  it("states the totals are exact rather than estimated", () => {
    expect(HTML).toContain("exact counts and not estimates");
  });
});

describe("the empty state is a report, not an error", () => {
  const html = renderReport(resultOf(), META);

  it("renders a whole document with zeroes", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("No guardrail matched anything in these sessions.");
    expect(html).toContain("Nothing matched more than once.");
  });

  it("uses the singular where the count is one", () => {
    const one = renderReport(resultOf({ sessions: [session([])], projects: 1 }), META);
    expect(one).toContain("1 session across 1 project.");
  });
});

describe("escaping", () => {
  it("escapes all five characters", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });

  it("a command containing markup becomes text, not markup", () => {
    // `ScanResult` is redacted, not inert. `>` is a shell redirect and appears in real
    // commands; without escaping, the findings table would render an element.
    const injected = resultOf({
      sessions: [session([turn([bash("rm -rf /tmp/x && echo '<img>' > out", "1")])])],
      projects: 1,
    });
    const html = renderReport(injected, META);
    expect(html).not.toContain("<img>");
    expect(html).toContain("&lt;img&gt;");
  });
});

describe("the JSON payload", () => {
  const json = JSON.parse(renderJson(POPULATED, META));

  it("carries the same redacted result the HTML renders", () => {
    expect(json.result).toEqual(JSON.parse(JSON.stringify(POPULATED)));
  });

  it("stamps the tool, version, time and catalog line", () => {
    expect(json.tool).toBe("agenttrail-guard");
    expect(json.version).toBe("0.1.0");
    expect(json.generatedAt).toBe("2026-09-08T09:00:00.000Z");
    // The same line the HTML footer renders — a pipeline consumer gets exactly what a
    // reader of the report gets, including the catalog's real version.
    expect(json.catalog).toContain(`guardrail library v${CATALOG_VERSION}, published `);
    expect(json.catalog).not.toContain("not yet stamped");
  });

  it("carries no path, no project name and no working directory", () => {
    const text = renderJson(POPULATED, META);
    for (const leak of ["priya", "acme", "/srv/app", "/Users/"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("ends with a newline, so it pipes cleanly", () => {
    expect(renderJson(POPULATED, META).endsWith("\n")).toBe(true);
  });
});

describe("the filename is the one the docs promise", () => {
  it("is agenttrail-guard-report.html", () => {
    expect(REPORT_FILENAME).toBe("agenttrail-guard-report.html");
  });
});

/**
 * `reviewStrings` — the `--review` payload, asserted against the RENDERED FILE.
 *
 * `scan --review` tells the reader "that is the whole file, not a sample". That is a
 * claim about two functions agreeing, and the sharp edge is the caps: the renderer
 * slices findings, examples and repeats, and a review computed over the unsliced result
 * would list strings the file does not contain — or, worse, the other way round. So the
 * fixture below deliberately exceeds BOTH caps, and the comparison is against the
 * generated HTML rather than against the constants.
 */
describe("the pre-flight review lists exactly what the file carries", () => {
  /** More findings than `MAX_ROWS`, and more shapes under one of them than `MAX_EXAMPLES`. */
  const OVERSIZED: ScanResult = {
    ...POPULATED,
    findings: Array.from({ length: MAX_ROWS + 5 }, (_, i) => ({
      ruleId: `t.rule-${String(i).padStart(3, "0")}`,
      title: `Guardrail number ${i}`,
      severity: "high",
      action: "warn" as const,
      count: MAX_ROWS + 5 - i,
      examples: Array.from({ length: MAX_EXAMPLES + 2 }, (_, j) => ({
        text: `cmd-${i}-shape-${j} <path>`,
        count: MAX_EXAMPLES + 2 - j,
      })),
    })),
    recurring: Array.from({ length: MAX_ROWS + 5 }, (_, i) => ({
      text: `repeat-${String(i).padStart(3, "0")} <path>`,
      count: 2,
      ruleId: `t.rule-${String(i).padStart(3, "0")}`,
      title: `Guardrail number ${i}`,
    })),
  };

  const flat = (result: ScanResult): string[] =>
    reviewStrings(result).flatMap((g) => g.lines.flatMap((l) => l.split("  ").filter(Boolean)));

  it("every string it shows really is in the file", () => {
    const html = renderReport(OVERSIZED, META);
    for (const value of flat(OVERSIZED)) {
      expect(html, `"${value}" was reviewed but is not in the file`).toContain(escapeHtml(value));
    }
  });

  it("and it shows every string the file carries — the direction that matters", () => {
    // Under-reporting is the dangerous half: a review that quietly omitted one shape
    // would let exactly the string nobody looked at ship. Checked over the FIXTURE's
    // own strings, each looked for in the HTML and then in the review.
    const html = renderReport(OVERSIZED, META);
    const reviewed = new Set(flat(OVERSIZED));
    const candidates = [
      ...OVERSIZED.findings.flatMap((f) => [f.ruleId, f.title, ...f.examples.map((e) => e.text)]),
      ...OVERSIZED.recurring.flatMap((r) => [r.text, r.ruleId, r.title]),
    ];
    const inFileButNotReviewed = candidates.filter(
      (value) => html.includes(escapeHtml(value)) && !reviewed.has(value),
    );
    expect(inFileButNotReviewed).toEqual([]);
  });

  it("the caps are actually exercised — the negative control", () => {
    // Without this the two assertions above would pass on a fixture that never hit a
    // cap, which is precisely the case they exist to cover.
    const html = renderReport(OVERSIZED, META);
    expect(html).toContain("further guardrails matched and are not listed here");
    expect(html).toContain("more shapes");
    expect(flat(OVERSIZED).length).toBeLessThan(
      OVERSIZED.findings.length * (MAX_EXAMPLES + 2) + OVERSIZED.recurring.length,
    );
  });

  it("is empty, and says nothing, when nothing matched", () => {
    expect(reviewStrings(resultOf())).toEqual([]);
  });

  it("de-duplicates, so a shape that is both a finding and a repeat is read once", () => {
    const lines = reviewStrings(POPULATED).flatMap((g) => g.lines);
    expect(new Set(lines).size).toBe(lines.length);
  });
});
