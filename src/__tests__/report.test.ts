// cspell:words backticked hrefs noopener noreferrer
/**
 * `core/report.ts` — a self-contained report, with no currency.
 *
 * Every self-containment assertion here is paired with a NEGATIVE CONTROL that runs
 * the same matcher over a fixture string containing the banned form. Without them the
 * suite would keep passing if the generator started returning the empty string, or if
 * a regex were edited into one that matches nothing — both of which are exactly the
 * silent failure the assertions exist to prevent.
 */

import {
  CATALOG_PUBLISHED_AT,
  CATALOG_VERSION,
  OWASP_SOURCES,
} from "@agenttrail/guardrails/guardrails";
import { describe, expect, it } from "vitest";
import { compileAllowlist } from "../core/evaluate.js";
import type { OwaspId } from "../core/owasp.js";
import {
  ARTIFACT_FILENAME,
  bySeverityThenCount,
  escapeHtml,
  MAX_EXAMPLES,
  MAX_ROWS,
  matchTally,
  PRODUCT_NOTE,
  REPORT_FILENAME,
  REPOSITORY_URL,
  type ReportMeta,
  renderJson,
  renderReport,
  reportPayload,
  reviewStrings,
  SITE_URL,
} from "../core/report.js";
import {
  DARK_TOKENS,
  LIGHT_TOKENS,
  LOGO_LOCKUP_SVG,
  LOGO_MARK_SVG,
  reportStyles,
} from "../core/report-brand.js";
import { compileCatalog } from "../core/rules.js";
import {
  aggregateScan,
  type ScanCorpus,
  type ScanFinding,
  type ScanResult,
} from "../core/scan-report.js";
import { bash, session, TEST_CATALOG, toolUse, turn } from "./scan-fixtures.js";
import {
  LOCAL_FIX_CATEGORIES,
  TEST_ONLY_BUILDERS,
  VERIFIED_META,
  VERIFIED_RESULT,
} from "./verified-corpus.js";

/**
 * The fixture's rules with OWASP ids, as a shipped guardrail carries them, so every rendering
 * below has an OWASP section and per-row ids.
 */
const FIXTURE_OWASP: Readonly<Record<string, readonly OwaspId[]>> = {
  "t.rm-rf": ["ASI02", "LLM03"],
  "t.env-file": ["LLM02"],
  "t.git-checkout": ["ASI02"],
};
const CATALOG = compileCatalog(
  TEST_CATALOG.map((rule) => ({ ...rule, owasp: FIXTURE_OWASP[rule.id] ?? [] })),
);
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
const ARTIFACT = renderReport(POPULATED, META, { variant: "artifact" });
// Each app's corpus declares what its own reader's records support, as the reader does:
// Cursor's session files carry no token counts, Codex's do, and both readers count what
// they could not use.
/** One session with one tool call that matches nothing, so the report has a scan to show. */
const ONE_CALL = {
  sessions: [session([turn([bash("ls -la", "1")], { input_tokens: 10, output_tokens: 5 })])],
  projects: 1,
};
// As for Codex below: Cursor's reader reads only Cursor's own tool shape.
const CURSOR = {
  ...resultOf({ agent: "cursor", capabilities: { tokens: false, skips: true }, ...ONE_CALL }),
  toolCalls: 1,
};
const CURSOR_HTML = renderReport(CURSOR, META);
const CURSOR_ARTIFACT = renderReport(CURSOR, META, { variant: "artifact" });
// The Codex reader reads only Codex's own tool shape, so the one call is counted here: these
// tests are about the sections a scan with calls shows, not about that reader.
const CODEX = {
  ...resultOf({ agent: "codex", capabilities: { tokens: true, skips: true }, ...ONE_CALL }),
  toolCalls: 1,
};
const CODEX_HTML = renderReport(CODEX, META);
const CODEX_ARTIFACT = renderReport(CODEX, META, { variant: "artifact" });

/** The synthetic verified report, both variants, with the fixes file named on its cards. */
const VERIFIED_OPTIONS = {
  cardBuilders: TEST_ONLY_BUILDERS,
  localFixCategories: LOCAL_FIX_CATEGORIES,
};
const VERIFIED_HTML = renderReport(VERIFIED_RESULT, VERIFIED_META, VERIFIED_OPTIONS);
const VERIFIED_ARTIFACT = renderReport(VERIFIED_RESULT, VERIFIED_META, {
  ...VERIFIED_OPTIONS,
  variant: "artifact",
});

/** Every form the file can take: each app, both variants, and a verified report. */
const RENDERINGS: readonly [string, string][] = [
  ["a Claude Code document", HTML],
  ["a Claude Code artifact", ARTIFACT],
  ["a Cursor document", CURSOR_HTML],
  ["a Cursor artifact", CURSOR_ARTIFACT],
  ["a Codex document", CODEX_HTML],
  ["a Codex artifact", CODEX_ARTIFACT],
  ["a verified document", VERIFIED_HTML],
  ["a verified artifact", VERIFIED_ARTIFACT],
];

/** Every `href` value in a page, in document order, whatever the quoting. */
function hrefs(html: string): string[] {
  return [...html.matchAll(/\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)].map(
    (m) => m[1] ?? m[2] ?? m[3] ?? "",
  );
}

/** Every http(s) URL in a page, in document order. */
function urls(html: string): string[] {
  return html.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
}

/** The page without its script and data block: what the guard's own markup says. */
function withoutScripts(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/g, "");
}

/** The UTM tags every site link carries, for one agent. */
function utmFor(agent: string): Record<string, string> {
  return { utm_source: "guard", utm_medium: "scan-report", utm_campaign: agent };
}

const X_INTENT = "https://x.com/intent/post?text=";

/** The only links off the site: where OWASP publishes its two lists. They carry no tags. */
const OWASP_LISTS: readonly string[] = [OWASP_SOURCES.agentic, OWASP_SOURCES.llm];

describe("the report is self-contained — nothing outside the file is loaded", () => {
  const BANNED: readonly [string, RegExp, string][] = [
    ["a src attribute", /\ssrc\s*=/i, `<img src="x.png">`],
    ["a link tag", /<link\b/i, `<link rel="stylesheet" href="x.css">`],
    ["a CSS import", /@import/i, `@import url("x.css");`],
    ["a CSS url()", /url\s*\(/i, `background: url(x.png);`],
    ["an iframe", /<iframe/i, `<iframe src="x"></iframe>`],
    ["an inline event handler", /\son[a-z]+\s*=\s*["']/i, `<div onclick="x()">y</div>`],
    ["a form", /<form\b/i, `<form action="https://x"></form>`],
  ];

  describe.each(RENDERINGS)("%s", (_name, html) => {
    it.each(BANNED)("contains no %s", (_label, pattern) => {
      expect(html).not.toMatch(pattern);
    });

    it("links only within the page, to the site with tags, to an X post, or to an OWASP list", () => {
      const agent = html.includes("Agent: Cursor")
        ? "cursor"
        : html.includes("Agent: Codex CLI")
          ? "codex"
          : "claude";
      const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
      for (const raw of hrefs(html)) {
        const href = raw.replace(/&amp;/g, "&");
        if (href.startsWith("#")) {
          expect(ids.has(href.slice(1)), `${href} has no target`).toBe(true);
        } else if (OWASP_LISTS.includes(href)) {
          expect(new URL(href).search).toBe("");
        } else if (href.startsWith(X_INTENT)) {
          const url = new URL(href);
          expect(url.searchParams.get("hashtags")).toBe("agenttrail");
          const back = new URL(url.searchParams.get("url") ?? "");
          expect(back.origin).toBe(SITE_URL);
          expect(Object.fromEntries(back.searchParams)).toMatchObject(utmFor(agent));
        } else {
          const url = new URL(href);
          expect(url.origin, href).toBe(SITE_URL);
          expect(Object.fromEntries(url.searchParams)).toMatchObject(utmFor(agent));
          expect(url.searchParams.get("utm_content")).toMatch(/^[a-z-]+$/);
        }
      }
    });

    it("opens every outbound link with no opener and no referrer", () => {
      const anchors = html.match(/<a\s[^>]*>/g) ?? [];
      const outbound = anchors.filter((a) => /href="https:/.test(a));
      expect(outbound.length).toBeGreaterThan(0);
      for (const a of outbound) {
        expect(a).toContain('target="_blank"');
        expect(a).toContain('rel="noopener noreferrer"');
      }
    });

    it("carries its whole stylesheet inline", () => {
      expect(html).toContain("<style>");
      expect(html).toContain("prefers-color-scheme");
    });
  });

  it.each(
    BANNED,
  )("negative control — the %s matcher DOES fire on a violating fixture", (_label, pattern, violating) => {
    expect(violating).toMatch(pattern);
  });

  it("links to exactly these site pages, pinned per agent", () => {
    // Pinned, not pattern-matched: a new destination turns this red until it is added here.
    const pages = (html: string): string[] =>
      [
        ...new Set(
          hrefs(html)
            .map((h) => h.replace(/&amp;/g, "&"))
            .filter((h) => h.startsWith(SITE_URL))
            .map((h) => {
              const url = new URL(h);
              return `${url.pathname} ${url.searchParams.get("utm_content")}`;
            }),
        ),
      ].sort();
    const common = [
      "/agenttrail-guard footer-guard",
      "/get-started/guard next-agents",
      "/get-started/guard next-commands",
      "/guardrails footer-library",
      "/guardrails next-library",
      "/security footer-security",
    ];
    expect(pages(CURSOR_HTML)).toEqual(common);
    expect(pages(CODEX_HTML)).toEqual(common);
    expect(pages(HTML)).toContain("/security/owasp owasp");
    expect(pages(HTML)).toContain("/security/owasp owasp-risk");
    expect(pages(HTML)).toEqual(
      [
        ...common,
        "/agenttrail-os os-demo",
        "/guard-vs-os os-compare",
        "/security/owasp owasp",
        "/security/owasp owasp-risk",
      ].sort(),
    );
    expect(pages(ARTIFACT)).toEqual(pages(HTML));
  });

  it("negative control — the href reader finds every quoting style", () => {
    expect(hrefs(`<a href="x">a</a> <a href='y'>b</a> <a href=z>c</a>`)).toEqual(["x", "y", "z"]);
  });

  it.each(
    RENDERINGS,
  )("%s names no URL beyond the site, an X post and the repository", (_n, html) => {
    // The repository URL is deliberately text. Every other URL is a link checked above.
    for (const url of urls(html)) {
      const ok =
        url.startsWith(`${SITE_URL}/`) ||
        url.startsWith(X_INTENT) ||
        url === REPOSITORY_URL ||
        OWASP_LISTS.includes(url);
      expect(ok, url).toBe(true);
    }
    expect(urls(html)).toContain(REPOSITORY_URL);
  });

  it("is a complete HTML document, not a fragment", () => {
    expect(HTML.startsWith("<!doctype html>")).toBe(true);
    expect(HTML).toContain("<title>");
    expect(HTML.trimEnd().endsWith("</html>")).toBe(true);
  });
});

describe("the artifact variant is page content, for a host that supplies the skeleton", () => {
  it("starts with its own title and carries no document skeleton", () => {
    for (const html of [ARTIFACT, CURSOR_ARTIFACT]) {
      expect(html.startsWith("<title>")).toBe(true);
      expect(html).not.toMatch(/<!doctype|<html\b|<head\b|<body\b/i);
      expect(html).toContain("<style>");
    }
  });

  it("closes its title inside the first 8KB, where a host looks for it", () => {
    const end = ARTIFACT.indexOf("</title>");
    expect(end).toBeGreaterThan(0);
    expect(end).toBeLessThan(8192);
  });

  it("carries the same body as the standalone page, apart from who it speaks to", () => {
    // The findings a publisher reviewed are the findings a viewer reads.
    const body = (html: string): string =>
      html
        .slice(html.indexOf("<main"), html.indexOf("</main>"))
        .replace(/<p class="provenance">[\s\S]*?<\/p>/, "")
        .replace(/<p class="origin">[\s\S]*?<\/p>/, "")
        .replace(/<p class="warning">[\s\S]*?<\/p>/, "")
        // The post: editable here, read-only there, and the note says which.
        .replace(/<p class="note share-note">[\s\S]*?<\/p>/, "")
        .replace(
          '<textarea id="share-text" rows="4" readonly>',
          '<textarea id="share-text" rows="4">',
        )
        .replace(/\n<p class="note artifact-note">[\s\S]*?<\/p>/, "");
    expect(body(ARTIFACT)).toBe(body(HTML));
    expect(body(ARTIFACT).length).toBeGreaterThan(2000);
  });

  it("says where it came from, instead of claiming nothing was uploaded", () => {
    const provenance = (html: string): string =>
      html.match(/<p class="provenance">([\s\S]*?)<\/p>/)?.[1] ?? "";
    expect(provenance(ARTIFACT)).toContain("published to claude.ai by the person who ran it");
    expect(provenance(ARTIFACT)).toContain("crash reporting is the one exception");
    expect(provenance(ARTIFACT)).toContain("Claude Code transcripts");
    expect(provenance(ARTIFACT)).not.toContain("nothing uploaded");
    expect(provenance(HTML)).toContain("nothing uploaded");
  });

  it("keeps the review command, addressed to the person who published it", () => {
    expect(ARTIFACT).toContain("<code>agenttrail-guard scan --agent claude --review</code>");
    expect(ARTIFACT).toContain("the person who published it can check every line");
  });
});

describe.each([
  ["with the verified sections' rules", true],
  ["without them", false],
])("one stylesheet serves both hosts and both themes, %s", (_name, verified) => {
  const REPORT_STYLES = reportStyles(verified);

  it("applies the dark palette by system preference unless a host pins light", () => {
    expect(REPORT_STYLES).toMatch(
      /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\)/,
    );
  });

  it("applies it again for an explicit dark choice", () => {
    expect(REPORT_STYLES).toContain(':root[data-theme="dark"]');
  });

  it("paints the body itself and leaves the root's padding to the host", () => {
    expect(REPORT_STYLES).toMatch(/body \{[^}]*background: var\(--bg\)/);
    // Light, dark by preference, dark by choice, and light again for print.
    const rootRules = REPORT_STYLES.match(/:root[^{]*\{[^}]*\}/g) ?? [];
    expect(rootRules.length).toBe(4);
    for (const rule of rootRules) expect(rule).not.toMatch(/padding/);
  });

  it("prints no share controls, and prints a button link as plain text with its URL after it", () => {
    const print = REPORT_STYLES.slice(REPORT_STYLES.indexOf("@media print"));
    const rules = [...print.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({
      selectors: (m[1] ?? "").split(",").map((s) => s.trim()),
      body: m[2] ?? "",
    }));
    const hidden = rules.filter((r) => /display: none/.test(r.body)).flatMap((r) => r.selectors);
    expect(hidden).toContain(".share");
    const button = rules.find((r) => r.selectors.includes(".button"));
    expect(button?.body).toMatch(/display: inline;/);
    expect(button?.body).toMatch(/background: none/);
    expect(button?.body).toMatch(/padding: 0/);
    expect(print).toMatch(/a\[href\^="http"\]::after \{ content: " \(" attr\(href\) "\)"/);
  });

  it("prints a long finding across pages, keeping short blocks and headings with what follows", () => {
    const print = REPORT_STYLES.slice(REPORT_STYLES.indexOf("@media print"));
    const rules = [...print.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({
      selectors: (m[1] ?? "").split(",").map((s) => s.trim()),
      body: m[2] ?? "",
    }));
    const unbroken = rules
      .filter((r) => /break-inside: avoid/.test(r.body))
      .flatMap((r) => r.selectors);
    expect(unbroken).not.toContain(".finding");
    expect(unbroken).toEqual(expect.arrayContaining([".finding-head", ".card", ".stat"]));
    const keptWithNext = rules
      .filter((r) => /break-after: avoid/.test(r.body))
      .flatMap((r) => r.selectors);
    expect(keptWithNext).toEqual(expect.arrayContaining(["h2", "h3", "summary"]));
  });

  it("writes no label in capitals: no uppercase transform and no wide letter-spacing", () => {
    // Labels are written in sentence case in the source, so a brand name renders as written.
    expect(REPORT_STYLES).not.toMatch(/text-transform:\s*uppercase/i);
    expect(REPORT_STYLES).not.toMatch(/letter-spacing:\s*0?\.0*[1-9]/);
  });

  it("negative control — the capitals matchers fire", () => {
    expect(".x { text-transform: uppercase; }").toMatch(/text-transform:\s*uppercase/i);
    expect(".x { letter-spacing: 0.06em; }").toMatch(/letter-spacing:\s*0?\.0*[1-9]/);
    expect("h1 { letter-spacing: -0.02em; }").not.toMatch(/letter-spacing:\s*0?\.0*[1-9]/);
  });

  it("loads no font and no resource", () => {
    expect(REPORT_STYLES).not.toMatch(/@font-face|@import|url\s*\(/i);
  });

  it("defines the same tokens for both themes", () => {
    expect(Object.keys(DARK_TOKENS).sort()).toEqual(Object.keys(LIGHT_TOKENS).sort());
  });

  it("carries none of the redaction canary's planted numbers", () => {
    // `scan-redaction-canary.test.ts` asserts the report never contains them; a colour or
    // a path coordinate that happened to would fail it for a reason nobody could find.
    for (const fixed of [REPORT_STYLES, LOGO_LOCKUP_SVG, LOGO_MARK_SVG]) {
      expect(fixed).not.toContain("3456");
      expect(fixed).not.toContain("909042");
    }
  });
});

describe("the logo is drawn inline and references nothing", () => {
  it.each([
    ["the lockup", LOGO_LOCKUP_SVG],
    ["the mark", LOGO_MARK_SVG],
  ])("%s has no namespace URL, link, url(), image or title", (_label, svg) => {
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).not.toMatch(/xmlns|href|url\s*\(|<use\b|<image\b|<title\b|<script|\son[a-z]+=/i);
  });

  /** The page's own words: no markup, script, styles, commands, the lockup's tag or the OS link. */
  const prose = (html: string): string =>
    withoutScripts(html)
      .replace(/<style>[\s\S]*?<\/style>/, "")
      .replace(/<code[^>]*>[\s\S]*?<\/code>/g, "")
      .replace('<span class="product-tag">Guard</span>', "")
      .replace(`>${PRODUCT_NOTE.secondary.label}<`, "><")
      .replace(/<[^>]+>/g, " ");
  const BARE = /(?<!AgentTrail )\b(Guard|OS)\b/;

  it.each(RENDERINGS)("%s names the products in full in its prose", (_n, html) => {
    expect(prose(html)).not.toMatch(BARE);
    expect(prose(html)).toContain("AgentTrail Guard");
  });

  it("negative control — a bare product name is caught", () => {
    expect(prose("<h1>Guard would have stopped 1 action</h1>")).toMatch(BARE);
    expect(prose("<p>OS remembers it</p>")).toMatch(BARE);
    expect(prose("<p>AgentTrail OS remembers it</p>")).not.toMatch(BARE);
  });

  it.each(RENDERINGS)("%s shows the lockup once, named for assistive technology", (_n, html) => {
    expect(html.split('class="lockup"').length - 1).toBe(1);
    expect(html).toContain('<div class="brand" role="img" aria-label="AgentTrail">');
  });
});

describe("no line of the file is long", () => {
  // A reader that pages through a file by line — the one that reads a report before it is
  // published — would otherwise see less than it publishes.
  it.each(RENDERINGS)("%s", (_name, html) => {
    const longest = Math.max(...html.split("\n").map((line) => line.length));
    expect(longest).toBeLessThanOrEqual(1000);
  });
});

/**
 * The report minus every quoted command: `<code>` spans, quoted guardrail library text, and
 * the data block and the post preview, which carry the same commands and counts as data.
 */
function chromeOf(html: string): string {
  return withoutScripts(html)
    .replace(/<p class="library-text[^"]*">[\s\S]*?<\/p>/g, "")
    .replace(/<code[^>]*>[\s\S]*?<\/code>/g, "")
    .replace(/<textarea[\s\S]*?<\/textarea>/g, "");
}

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
  const chrome = chromeOf(HTML);

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
    expect(chrome).toContain("All findings");
  });

  it("the verified sections add no currency, in either form", () => {
    for (const html of [VERIFIED_HTML, VERIFIED_ARTIFACT]) {
      expect(chromeOf(html)).not.toMatch(CURRENCY_SYMBOL);
      expect(html).not.toMatch(CURRENCY_WORD);
      expect(chromeOf(html)).toContain("What actually happened");
    }
  });

  it("a shell variable in a command SURVIVES, which is the point of the split", () => {
    const withVar = resultOf({
      sessions: [session([turn([bash("rm -rf $DIR && rm -rf /tmp/x", "1")])])],
      projects: 1,
    });
    const html = renderReport(withVar, META);
    expect(html).toContain("$DIR");
    expect(chromeOf(html)).not.toMatch(CURRENCY_SYMBOL);
  });
});

describe("what the report says", () => {
  it("leads with the counts, and they are the aggregator's", () => {
    expect(HTML).toContain(">5<"); // tool calls
    expect(HTML).toContain("risky actions");
    expect(HTML).toContain("repeated command shape<");
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
    expect(HTML).toContain("Repeat offenders");
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
    // The reader DOES descend into sub-agent transcripts, so the note says so.
    expect(html).toContain("the sub-agent transcripts in its");
  });

  it("the coverage note DENIES the alarming reading rather than inviting it", () => {
    // "Sessions filed deeper are outside these numbers" would tell a reader they are
    // missing most of their history. Sub-agent transcripts ARE read and folded into their
    // session, so what remains is stray files elsewhere — overstating that misleads as much
    // as hiding it.
    const html = renderReport(
      resultOf({ sessions: [session([])], projects: 1, notRead: 751 }),
      META,
    );
    expect(html).toContain("the session that started it");
    expect(html).toContain("elsewhere under the projects root");
    expect(html).not.toContain("sessions filed deeper");
    expect(html).not.toContain("does not descend");
    // The closing line stays: it frames every number on the page.
    expect(html).toContain("Every count above is of what was read, not of everything that exists.");
  });

  it("says nothing about coverage when everything under the root was read", () => {
    // A caveat printed unconditionally is noise, and noise is how a real caveat stops
    // being read.
    expect(HTML).not.toContain("Coverage limit");
  });

  it("renders a severity and an action it has never seen, rather than dropping the row", () => {
    // Not hypothetical: the shipped guardrails are authored against a shared schema
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
      toolCalls: 1,
      riskyActions: 1,
      riskyByAction: { block: 0, require_approval: 0, warn: 1 },
      findings: [
        {
          ruleId: "t.exotic",
          title: "A severity the renderer has never seen",
          severity: "informational",
          action: "warn" as const,
          count: 1,
          examples: [{ text: "boom", count: 1 }],
          owasp: [],
        },
      ],
    };
    const html = renderReport(withExotic, META);
    // The row stays. Its severity is shown as `unknown`: a severity is free text on a rule a
    // user wrote, so the file never shows it.
    expect(html).toContain("A severity the renderer has never seen");
    expect(html).toContain('<span class="badge sev-unknown">unknown</span>');
    expect(html).not.toContain("informational");
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
    // `agenttrail-guard 0.1.0` is the tool, `guardrail library v0.1.0` is the corpus that
    // determines which rules this user actually has. Render at a `generatedAt` a day
    // after the catalog's real publish date so the age is a deterministic "1 day ago",
    // independent of when this release happened.
    const now = new Date(Date.parse(CATALOG_PUBLISHED_AT) + 24 * 60 * 60 * 1000);
    const html = renderReport(POPULATED, { version: "0.1.0", generatedAt: now });
    expect(html).toContain(`guardrail library v${CATALOG_VERSION}, published `);
    expect(html).toMatch(/guardrail library v\d+\.\d+\.\d+, published (today|\d+ days? ago)/);
    expect(html).not.toContain("not yet stamped");
  });

  it("gives the catalog's info severity its own tone", () => {
    const info: ScanResult = {
      ...POPULATED,
      findings: [
        {
          ruleId: "t.info",
          title: "An informational guardrail",
          severity: "info",
          action: "warn",
          count: 1,
          examples: [{ text: "boom", count: 1 }],
          owasp: [],
        },
      ],
    };
    const html = renderReport(info, META);
    expect(html).toContain('<span class="badge sev-info">info</span>');
    expect(html).not.toContain('class="badge sev-unknown"');
  });

  it("says a finding is not proof that anything went wrong", () => {
    expect(HTML).toContain("It is not proof that anything went wrong");
  });
});

describe("the AgentTrail OS block", () => {
  const notes = (html: string): number => html.split('class="product-note"').length - 1;

  it("appears exactly once in a Claude Code report, before the footer, in both variants", () => {
    for (const html of [HTML, ARTIFACT]) {
      expect(notes(html)).toBe(1);
      expect(html.indexOf('class="product-note"')).toBeLessThan(html.indexOf("<footer"));
      expect(html).toContain(escapeHtml(PRODUCT_NOTE.heading));
      expect(html).toContain(PRODUCT_NOTE.primary.label);
      expect(html).toContain(PRODUCT_NOTE.secondary.label);
    }
  });

  it("never appears in a Cursor or Codex report", () => {
    for (const html of [CURSOR_HTML, CURSOR_ARTIFACT, CODEX_HTML, CODEX_ARTIFACT]) {
      expect(notes(html)).toBe(0);
      expect(html).not.toContain(escapeHtml(PRODUCT_NOTE.heading));
      expect(html).not.toContain(PRODUCT_NOTE.primary.label);
    }
  });

  it("negative control — the counter does count a note", () => {
    expect(notes('<aside class="product-note">x</aside>')).toBe(1);
  });

  it.each(RENDERINGS)("%s has no sign-up, trial, upgrade or prize wording", (_n, html) => {
    const words = chromeOf(html);
    expect(words).not.toMatch(/sign up|free trial|get started|upgrade|book a demo/i);
    expect(words).not.toMatch(/\b(prize|giveaway|win|winners?|free month|promo|promotion)\b/i);
  });

  it("negative control — the wording matchers fire", () => {
    expect("Share to win a free month").toMatch(
      /\b(prize|giveaway|win|winners?|free month|promo|promotion)\b/i,
    );
    expect("Sign up free").toMatch(/sign up|free trial|get started|upgrade|book a demo/i);
  });

  it("says that nothing in the report was sent to the product it names", () => {
    expect(HTML).toContain("nothing in this report was sent to it");
  });
});

describe("a backticked span in a guardrail title renders as code", () => {
  const titled = (title: string): ScanResult => ({
    ...POPULATED,
    findings: [
      {
        ruleId: "t.titled",
        title,
        severity: "high",
        action: "block",
        count: 2,
        examples: [{ text: "x", count: 2 }],
        owasp: [],
      },
    ],
    recurring: [{ text: "x", count: 2, calls: 2, ruleId: "t.titled", title }],
  });

  it("wraps the span in code, in the findings and in the repeats", () => {
    const html = renderReport(titled("Hold `rm -rf` for approval"), META);
    const row = html.slice(
      html.indexOf('id="finding-0"'),
      html.indexOf("</li>", html.indexOf('id="finding-0"')),
    );
    const repeats = html.slice(
      html.indexOf('id="repeats"'),
      html.indexOf("</section>", html.indexOf('id="repeats"')),
    );
    expect(row).toContain("Hold <code>rm -rf</code> for approval");
    expect(repeats).toContain("Hold <code>rm -rf</code> for approval");
    expect(withoutScripts(html)).not.toContain("`");
  });

  it("leaves an unpaired backtick as a backtick", () => {
    expect(renderReport(titled("A lone ` tick"), META)).toContain("A lone ` tick");
  });

  it("escapes before it wraps, so markup inside the span stays text", () => {
    const html = renderReport(titled("Run `<script>` here"), META);
    expect(html).toContain("<code>&lt;script&gt;</code>");
    // The page's own script is the only `<script>` element; the title stays text.
    expect(withoutScripts(html)).not.toContain("<script>");
    expect(html.split("<script>").length - 1).toBe(1);
  });
});

describe("the match tally", () => {
  const finding = (severity: string, action: ScanFinding["action"], count: number) => ({
    ruleId: `t.${severity}-${action}`,
    title: "t",
    severity,
    action,
    count,
    examples: [],
    owasp: [],
  });

  it("totals every finding, including those past the table's row cap", () => {
    const many: ScanResult = {
      ...POPULATED,
      findings: Array.from({ length: MAX_ROWS + 5 }, (_, i) => ({
        ...finding("high", "warn", 2),
        ruleId: `t.rule-${i}`,
      })),
    };
    const tally = matchTally(many);
    expect(tally.bySeverity).toEqual([{ severity: "high", count: 2 * (MAX_ROWS + 5) }]);
    expect(tally.byAction).toEqual([{ action: "warn", count: 2 * (MAX_ROWS + 5) }]);
  });

  it("lists severities most serious first, then any it does not recognise", () => {
    const tally = matchTally({
      ...POPULATED,
      findings: [
        finding("low", "warn", 1),
        finding("zany", "warn", 9),
        finding("critical", "block", 1),
        finding("info", "require_approval", 3),
      ],
    });
    expect(tally.bySeverity.map((s) => s.severity)).toEqual(["critical", "low", "info", "zany"]);
    expect(tally.byAction.map((a) => a.action)).toEqual(["block", "require_approval", "warn"]);
  });

  it("orders findings for a summary by severity, then count, then id", () => {
    const ordered = bySeverityThenCount([
      finding("low", "warn", 50),
      finding("critical", "block", 1),
      { ...finding("high", "warn", 2), ruleId: "t.b" },
      { ...finding("high", "warn", 2), ruleId: "t.a" },
      finding("high", "block", 7),
    ]);
    expect(ordered.map((f) => f.ruleId)).toEqual([
      "t.critical-block",
      "t.high-block",
      "t.a",
      "t.b",
      "t.low-warn",
    ]);
  });

  it("renders above the findings, and not at all when nothing matched", () => {
    expect(HTML.indexOf('class="tally"')).toBeGreaterThan(0);
    expect(HTML.indexOf('class="tally"')).toBeLessThan(HTML.indexOf("<h2>All findings</h2>"));
    expect(renderReport(resultOf(), META)).not.toContain('class="tally"');
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

  it("renders a whole document that says nothing was scanned", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<h1>No sessions found to scan</h1>");
    expect(html).toContain("This is not a clean result");
  });

  it("says nothing matched when calls were scanned and none matched", () => {
    const clean = renderReport(resultOf(ONE_CALL), META);
    expect(clean).toContain("<h1>Nothing in these sessions matched a guardrail</h1>");
    expect(clean).toContain("No guardrail matched anything in these sessions.");
    expect(clean).toContain("Nothing matched more than once.");
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

describe("the report names the app whose sessions it read", () => {
  it("a Claude Code report says so, and its review hint names --agent claude", () => {
    expect(POPULATED.agent).toBe("claude");
    expect(HTML).toContain('<p class="agent">Agent: Claude Code</p>');
    expect(HTML).toContain("<code>agenttrail-guard scan --agent claude --review</code>");
  });

  it("a Claude Code report keeps its token section and lists nothing as unevaluated", () => {
    expect(HTML).toContain("<h2>Tokens</h2>");
    expect(HTML).not.toContain("What was not evaluated");
    expect(POPULATED).not.toHaveProperty("skipped");
  });

  it("a Cursor report says so, and its review hint names --agent cursor", () => {
    expect(CURSOR.agent).toBe("cursor");
    expect(CURSOR_HTML).toContain('<p class="agent">Agent: Cursor</p>');
    expect(CURSOR_HTML).toContain("<code>agenttrail-guard scan --agent cursor --review</code>");
  });

  it("a Codex report says so, and its review hint names --agent codex", () => {
    expect(CODEX.agent).toBe("codex");
    expect(CODEX_HTML).toContain('<p class="agent">Agent: Codex CLI</p>');
    expect(CODEX_HTML).toContain("<code>agenttrail-guard scan --agent codex --review</code>");
  });

  it("what the report carries follows the reader's records, not the app's name", () => {
    // Both readers count what they could not use, so both list it; only Cursor's records
    // lack token counts, so only Cursor's report withholds the token section.
    for (const html of [CURSOR_HTML, CODEX_HTML]) {
      expect(html).toContain("<h2>What was not evaluated</h2>");
    }
    expect(CURSOR.tokens).toBeNull();
    expect(CURSOR_HTML).not.toContain("<h2>Tokens</h2>");
    expect(CURSOR_HTML).toContain("Cursor&#39;s session files record no token counts");
    expect(CODEX.tokens).not.toBeNull();
    expect(CODEX_HTML).toContain("<h2>Tokens</h2>");
    expect(CODEX_HTML).not.toContain("record no token counts");
  });

  it("labels the cache-read total as cumulative, so it is not read as fresh input", () => {
    // POPULATED has non-zero cache reads, so both the row label and the note appear.
    expect(HTML).toContain("Read from cache (cumulative)");
    expect(HTML).toContain("re-read and re-charged every turn");
  });
});

describe("the filename is the one the docs promise", () => {
  it("is agenttrail-guard-report.html", () => {
    expect(REPORT_FILENAME).toBe("agenttrail-guard-report.html");
  });

  it("the page-content variant has its own name, so it never overwrites the page", () => {
    expect(ARTIFACT_FILENAME).toBe("agenttrail-guard-artifact.html");
    expect(ARTIFACT_FILENAME).not.toBe(REPORT_FILENAME);
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
      owasp: [],
      examples: Array.from({ length: MAX_EXAMPLES + 2 }, (_, j) => ({
        text: `cmd-${i}-shape-${j} <path>`,
        count: MAX_EXAMPLES + 2 - j,
      })),
    })),
    recurring: Array.from({ length: MAX_ROWS + 5 }, (_, i) => ({
      text: `repeat-${String(i).padStart(3, "0")} <path>`,
      count: 2,
      calls: 2,
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
    expect(html).toContain("5 further repeats are not listed here.");
    const payload = reportPayload(OVERSIZED, META);
    expect(payload.recurring).toHaveLength(MAX_ROWS);
    expect(payload.moreRecurring).toBe(5);
    // Exactly what the caps leave: the carried guardrails (each repeat's guardrail is one of
    // them), their first shapes, and the carried repeats.
    const lines = Object.fromEntries(
      reviewStrings(OVERSIZED).map((g) => [g.label, g.lines.length]),
    );
    expect(lines["Guardrails named in the report"]).toBe(MAX_ROWS);
    expect(lines["Command shapes in the report"]).toBe(MAX_ROWS * MAX_EXAMPLES + MAX_ROWS);
  });

  it("is empty, and says nothing, when nothing matched", () => {
    expect(reviewStrings(resultOf())).toEqual([]);
  });

  it("keeps every line short even with both caps saturated", () => {
    for (const variant of ["document", "artifact"] as const) {
      const html = renderReport(OVERSIZED, META, { variant });
      expect(Math.max(...html.split("\n").map((line) => line.length))).toBeLessThanOrEqual(1000);
    }
  });

  it("de-duplicates, so a shape that is both a finding and a repeat is read once", () => {
    const lines = reviewStrings(POPULATED).flatMap((g) => g.lines);
    expect(new Set(lines).size).toBe(lines.length);
  });
});

describe("an app that cannot ask says so", () => {
  // The label stays "would ask" on every app, because it names the guardrail's own
  // decision. On Codex that decision cannot be carried out, so the report has to say the
  // action was stopped — otherwise it claims a person was asked on the one app where
  // nobody is.
  const approvalFinding = {
    ruleId: "ps.permission-widen",
    title: "Making a file writable by everyone",
    severity: "high",
    action: "require_approval",
    count: 1,
    examples: [{ text: "chmod 777 note.txt", when: "2026-09-21T10:40:12.000Z" }],
    owasp: [],
  };

  function reportFor(agent: "claude" | "cursor" | "codex", findings: unknown[]): string {
    return renderReport(
      {
        agent,
        sessions: 1,
        toolCalls: 1,
        riskyActions: findings.length,
        riskyByAction: { block: 0, require_approval: findings.length, warn: 0 },
        decided: [],
        projects: 1,
        notRead: 0,
        findings,
        recurring: [],
        owasp: [],
        tokens: null,
      } as never,
      META,
    );
  }

  it("tells a Codex reader that would-ask meant stopped", () => {
    const html = reportFor("codex", [approvalFinding]);
    expect(html).toContain("would ask");
    expect(html).toContain("would have been stopped");
  });

  it("says nothing of the kind for an app that can ask", () => {
    for (const agent of ["claude", "cursor"] as const) {
      expect(reportFor(agent, [approvalFinding])).not.toContain("would have been stopped");
    }
  });

  it("stays quiet when no guardrail asked for approval", () => {
    const blocking = { ...approvalFinding, action: "block", ruleId: "dd.rm-rf-absolute" };
    expect(reportFor("codex", [blocking])).not.toContain("would have been stopped");
  });
});
