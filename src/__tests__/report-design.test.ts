/**
 * The page holds to the v3 design: its tokens, its structure, the length of its short copy and
 * its one-row nav.
 *
 * The tokens are pinned to `design-tokens.ts`. The structure is the synthetic verified page's
 * skeleton — tags, ids and classes, repeated siblings collapsed, no text — pinned to
 * `__snapshots__/report-skeleton.golden.txt` (`vitest -u` rewrites it). The copy limits are held
 * over a matrix of the synthetic corpora, every card builder that fits them, and their counts
 * as given and scaled up a thousandfold.
 */

import { describe, expect, it } from "vitest";
import {
  cardSummary,
  headlineParts,
  type RenderOptions,
  renderReport,
  reportPayload,
  SUMMARY_LIMITS,
} from "../core/report.js";
import { DARK_TOKENS, LIGHT_TOKENS, reportStyles } from "../core/report-brand.js";
import type { ScanResult } from "../core/scan-report.js";
import { CARD_BUILDERS } from "../core/verify/builders.js";
import { type CardBuilders, pickHeadline } from "../core/verify/cards.js";
import { DESIGN_DARK, DESIGN_LIGHT } from "./design-tokens.js";
import { decodeEntities } from "./html-text.js";
import { notesResult, pageVerification, TONE_BUILDERS } from "./notes-corpus.js";
import {
  CLOUD_LEAD_RESULT,
  CODEX_ONLY_RESULT,
  CURSOR_RESULT,
  FALLBACK_RESULT,
  HIDING_RESULT,
  LOCAL_FIX_CATEGORIES,
  TEST_ONLY_BUILDERS,
  VERIFIED_META,
  VERIFIED_RESULT,
} from "./verified-corpus.js";

describe("the design tokens", () => {
  it("light and dark are the design's, value for value", () => {
    expect(LIGHT_TOKENS).toEqual(DESIGN_LIGHT);
    expect(DARK_TOKENS).toEqual(DESIGN_DARK);
  });

  it("each one reaches the stylesheet as a custom property, in both themes", () => {
    const css = reportStyles(true);
    for (const [name, value] of Object.entries(DESIGN_LIGHT)) {
      expect(css, name).toContain(`--${name}: ${value};`);
    }
    for (const [name, value] of Object.entries(DESIGN_DARK)) {
      expect(css, name).toContain(`--${name}: ${value};`);
    }
  });
});

/** Elements with no closing tag. */
const VOID = new Set(["area", "br", "col", "hr", "img", "input", "link", "meta", "source", "wbr"]);
/** Elements whose content is not page structure: read as one leaf each. */
const LEAVES = new Set(["svg", "script", "style", "textarea", "title"]);

/**
 * A page's structure, one element a line, indented by depth: tag, then `#id` and `.class`es.
 * Text, attributes other than id and class, and the head are left out; a run of siblings with
 * the same structure is written once, with how many there were.
 */
function skeleton(html: string): string {
  interface Node {
    readonly label: string;
    readonly children: Node[];
  }
  const root: Node = { label: "", children: [] };
  const stack: { tag: string; node: Node }[] = [{ tag: "", node: root }];
  const body = html.slice(html.indexOf("<body"));
  const tags = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  // Inside a leaf: its tag, and how deep it nests in itself.
  let skip: { tag: string; depth: number } | undefined;
  for (const m of body.matchAll(tags)) {
    const [, closing, rawTag, attrs = ""] = m;
    const tag = (rawTag ?? "").toLowerCase();
    if (skip !== undefined) {
      if (tag === skip.tag && closing === "/") skip.depth--;
      else if (tag === skip.tag && !attrs.trimEnd().endsWith("/")) skip.depth++;
      if (skip.depth === 0) skip = undefined;
      continue;
    }
    if (closing === "/") {
      const at = stack.map((s) => s.tag).lastIndexOf(tag);
      if (at > 0) stack.length = at;
      continue;
    }
    const id = attrs.match(/\sid="([^"]*)"/)?.[1];
    const classes = (attrs.match(/\sclass="([^"]*)"/)?.[1] ?? "").split(/\s+/).filter(Boolean);
    const label = `${tag}${id === undefined ? "" : `#${id}`}${classes.map((c) => `.${c}`).join("")}`;
    const node: Node = { label, children: [] };
    stack[stack.length - 1]?.node.children.push(node);
    if (LEAVES.has(tag)) {
      if (!attrs.trimEnd().endsWith("/")) skip = { tag, depth: 1 };
      continue;
    }
    if (!VOID.has(tag) && !attrs.trimEnd().endsWith("/")) stack.push({ tag, node });
  }
  const lines: string[] = [];
  const write = (nodes: readonly Node[], depth: number): void => {
    const shapes = nodes.map((n) => JSON.stringify(n));
    for (let i = 0; i < nodes.length; ) {
      let j = i + 1;
      while (j < nodes.length && shapes[j] === shapes[i]) j++;
      const node = nodes[i] as Node;
      lines.push(`${"  ".repeat(depth)}${node.label}${j - i > 1 ? ` ×${j - i}` : ""}`);
      write(node.children, depth + 1);
      i = j;
    }
  };
  write(root.children, 0);
  return `${lines.join("\n")}\n`;
}

describe("the page's structure", () => {
  const OPTIONS: RenderOptions = {
    cardBuilders: TEST_ONLY_BUILDERS,
    localFixCategories: LOCAL_FIX_CATEGORIES,
  };
  const html = renderReport(VERIFIED_RESULT, VERIFIED_META, OPTIONS);

  it("is the design's skeleton", async () => {
    await expect(skeleton(html)).toMatchFileSnapshot("__snapshots__/report-skeleton.golden.txt");
  });

  it("the skeleton holds no text from the page", () => {
    const text = skeleton(html);
    expect(text).not.toMatch(/[A-Z][a-z]+ [a-z]+/);
    expect(text).not.toContain("<");
  });

  it("negative control: the skeleton sees a moved section", () => {
    const moved = html.replace('<section id="owasp"', '<div id="owasp-moved"><section id="owasp"');
    expect(skeleton(moved)).not.toBe(skeleton(html));
  });

  it("the sections come in the design's order", () => {
    const order = [
      'class="topbar"',
      'class="hero"',
      'id="lead-extra"',
      'id="stats"',
      'id="what-happened"',
      'id="outcomes"',
      'id="owasp"',
      'id="findings"',
      'id="repeats"',
      'id="next"',
      'id="share"',
      'id="privacy"',
      'id="usage"',
      'id="os"',
      'class="report-meta"',
      'class="site-footer"',
    ];
    const at = order.map((part) => html.indexOf(part));
    for (const [i, part] of order.entries()) expect(at[i], part).toBeGreaterThan(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
});

describe("the nav", () => {
  const html = renderReport(VERIFIED_RESULT, VERIFIED_META, { cardBuilders: TEST_ONLY_BUILDERS });
  const nav = html.slice(html.indexOf('<nav class="navlinks"'), html.indexOf("</nav>"));

  it("is six links, in the design's order", () => {
    const links = [...nav.matchAll(/<a href="#([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => [
      m[1],
      decodeEntities(m[2] ?? ""),
    ]);
    expect(links).toEqual([
      ["what-happened", "What happened"],
      ["outcomes", "Overview"],
      ["owasp", "OWASP"],
      ["findings", "All findings"],
      ["next", "Next steps"],
      ["privacy", "Privacy"],
    ]);
  });

  it("sits in one row that never wraps", () => {
    const css = reportStyles(true);
    const rule = (selector: string): string => {
      const at = css.indexOf(`\n${selector} {`);
      expect(at, selector).toBeGreaterThan(-1);
      return css.slice(at, css.indexOf("}", at));
    };
    expect(rule(".navlinks")).toContain("white-space: nowrap");
    expect(rule(".navlinks")).toContain("display: flex");
    expect(rule(".navlinks a")).toContain("white-space: nowrap");
  });
});

/** Every number in `value` scaled by `k`, so the matrix also holds large counts. */
function scaled(value: unknown, k: number): unknown {
  if (typeof value === "number") return value === 0 || k === 1 ? value : value * k + 7;
  if (Array.isArray(value)) return value.map((v) => scaled(v, k));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, scaled(v, k)]));
  }
  return value;
}

/** The synthetic pages, each with the card builders whose facts it carries. */
const CORPORA: readonly [string, ScanResult, readonly [string, CardBuilders][]][] = [
  ["secrets lead", VERIFIED_RESULT, [["test-only", TEST_ONLY_BUILDERS]]],
  ["cloud lead", CLOUD_LEAD_RESULT, [["test-only", TEST_ONLY_BUILDERS]]],
  ["fallback", FALLBACK_RESULT, [["test-only", TEST_ONLY_BUILDERS]]],
  ["hiding forms", HIDING_RESULT, [["test-only", TEST_ONLY_BUILDERS]]],
  ["Cursor", CURSOR_RESULT, [["test-only", TEST_ONLY_BUILDERS]]],
  ["Codex", CODEX_ONLY_RESULT, [["test-only", TEST_ONLY_BUILDERS]]],
  [
    "the real checks",
    notesResult(pageVerification()),
    [
      ["shipped", CARD_BUILDERS],
      ["tones", TONE_BUILDERS],
    ],
  ],
];

const MATRIX = CORPORA.flatMap(([name, result, builders]) =>
  [1, 1000].flatMap((k) =>
    builders.map(([label, b]) => {
      const verification = result.verification;
      const page: ScanResult =
        verification === undefined
          ? result
          : {
              ...result,
              verification: {
                ...verification,
                categories: scaled(verification.categories, k) as typeof verification.categories,
              },
            };
      return [`${name}, ${label}, counts ×${k}`, page, b] as const;
    }),
  ),
);

/** The longest a headline may be, and the hero lead, which is at most two sentences. */
const HEADLINE_CHARS = 110;
const LEAD = { sentences: 2, chars: 300 } as const;

describe("the short copy stays short", () => {
  it.each(MATRIX)("%s: every card's short rows are within their limits", (_name, page, b) => {
    const cards = reportPayload(page, VERIFIED_META, b).cards ?? [];
    expect(cards.length).toBe(9);
    for (const card of cards) {
      const short = cardSummary(card);
      for (const row of ["happened", "now", "fix"] as const) {
        const lines = short[row];
        const limit = SUMMARY_LIMITS[row];
        const text = lines.map((l) => l.text).join(" ");
        expect(lines.length, `${card.category} ${row}`).toBeLessThanOrEqual(limit.sentences);
        expect(text.length, `${card.category} ${row}: ${text}`).toBeLessThanOrEqual(limit.chars);
      }
      // A card with something to say shows it.
      if (card.found.length > 0) expect(short.happened.length, card.category).toBeGreaterThan(0);
    }
  });

  it.each(
    MATRIX,
  )("%s: the headline and the hero lead are within their limits", (_name, page, b) => {
    const html = renderReport(page, VERIFIED_META, { cardBuilders: b });
    const h1 = html.match(/<h1 id="headline"[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "";
    const headline = decodeEntities(h1.replace(/<[^>]+>/g, ""));
    expect(headline.length).toBeGreaterThan(10);
    expect(headline.length, headline).toBeLessThanOrEqual(HEADLINE_CHARS);
    const lead = html.match(/<p class="lead" id="lead">([\s\S]*?)<\/p>/)?.[1];
    if (lead !== undefined) {
      const sentences = [...lead.matchAll(/data-template="/g)].length;
      expect(sentences).toBeLessThanOrEqual(LEAD.sentences);
      const text = decodeEntities(lead.replace(/<[^>]+>/g, ""));
      expect(text.length, text).toBeLessThanOrEqual(LEAD.chars);
    }
  });

  it("the headline's three parts are the headline, with the counted phrase emphasised", () => {
    const cards = reportPayload(VERIFIED_RESULT, VERIFIED_META, TEST_ONLY_BUILDERS).cards ?? [];
    const lead = pickHeadline(cards, { ranEvidence: "tool-result" });
    const text = lead?.headline?.sentence.text ?? "";
    const parts = headlineParts(text);
    expect(parts.before + parts.emphasis + parts.after).toBe(text);
    expect(parts.emphasis).toMatch(/\d/);
  });
});
