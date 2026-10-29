/**
 * Every new slot of the verified sections escapes what a card builder puts in it.
 *
 * A TEST-ONLY builder puts markup, quotes, an ampersand and a closing script tag into every
 * slot a card has: the headline, its count line, what checking found, now, the fix in words,
 * a fix shape, the chip's label, the read line and each template id. The page must carry them
 * as text: no element, attribute or script they spell may appear in it. A negative control
 * shows the matchers fire on a page that does not escape.
 */

import { describe, expect, it } from "vitest";
import { renderReport } from "../core/report.js";
import { CARD_BUILDERS } from "../core/verify/builders.js";
import { type CardBuilders, type CardView, HEADLINE_BASIS } from "../core/verify/cards.js";
import { VERIFY_CATEGORIES, type VerifyCategory } from "../core/verify/types.js";
import { joinCommandWords } from "./html-text.js";
import {
  baseResult,
  LOCAL_FIX_CATEGORIES,
  SECRETS_CLEAN,
  VERIFIED_META,
  verification,
  verifiedCategories,
} from "./verified-corpus.js";

/** Markup, quotes and a script, built here so no source line spells a working tag. */
const OPEN = "<";
const HOSTILE = `${OPEN}b>bold${OPEN}/b> & "quoted" 'single' ${OPEN}/script>${OPEN}script>hostile()${OPEN}/script>`;
const HOSTILE_ID = `id"><b class="x`;

/** TEST-ONLY: a card with the hostile text in every slot. */
function hostileCard(
  category: VerifyCategory,
): (result: { status: string; matches: number }) => CardView {
  return (result) => {
    const line = { template: `${HOSTILE_ID}.${category}`, text: `${category}: ${HOSTILE}` };
    return {
      category,
      tone: result.status as CardView["tone"],
      count: result.matches,
      countLine: line,
      found: [line],
      now: [line],
      fixSteps: [line],
      fixes: [{ shape: `git show ${HOSTILE}` }],
      codexCaveat: false,
      read: line,
      chip: { count: 1, label: line },
      ...(category === "skipped-checks"
        ? {
            headline: {
              basis: HEADLINE_BASIS["skipped-checks"],
              count: 2,
              restsOnCodexRan: false,
              sentence: line,
            },
          }
        : {}),
    };
  };
}

const BUILDERS = {
  ...Object.fromEntries(VERIFY_CATEGORIES.map((c) => [c, hostileCard(c)])),
  secrets: CARD_BUILDERS.secrets,
} as unknown as CardBuilders;

// Secrets is clean here, so the hostile skipped-checks claim takes the headline slot.
const HTML = renderReport(
  baseResult(
    verification({
      ...verifiedCategories(),
      secrets: { status: "clean", matches: 3, facts: SECRETS_CLEAN },
    }),
  ),
  VERIFIED_META,
  { cardBuilders: BUILDERS, localFixCategories: LOCAL_FIX_CATEGORIES },
);

/** The page without its data block, which is JSON and escapes on its own terms. */
const markup = HTML.replace(
  /<script type="application\/json" id="report-data">[\s\S]*?<\/script>/,
  "",
);

/** What an unescaped slot would leave in the page. */
const LEAKS: readonly [string, RegExp][] = [
  ["an element", /<b>bold<\/b>/],
  ["an attribute breakout", /id"><b class="x/],
  ["a script", /<script>hostile\(\)/],
  ["a raw quote in text", />[^<]*"quoted"[^<]*</],
];

describe("the verified sections escape every slot", () => {
  it("the hostile text reached the page, in every slot", () => {
    // Health: the slots were filled, so an absence below is escaping, not a missing slot.
    expect(HTML).toContain(
      '<h1 id="headline" data-template="id&quot;&gt;&lt;b class=&quot;x.skipped-checks">',
    );
    // The evidence rows hold only fixed kind labels and counts, so it is not a slot here.
    for (const slot of ["also-checked", "what-happened"]) {
      expect(HTML).toContain(`id="${slot}"`);
    }
    expect(markup.split("&lt;b&gt;bold&lt;/b&gt;").length - 1).toBeGreaterThan(40);
    expect(joinCommandWords(markup)).toContain("git show &lt;b&gt;bold");
  });

  it.each(LEAKS)("leaves no %s", (_name, pattern) => {
    expect(markup).not.toMatch(pattern);
  });

  it("carries exactly two script elements: the data block and the page script", () => {
    expect(HTML.split("<script").length - 1).toBe(2);
  });

  it("the data block cannot be closed from inside", () => {
    const block = HTML.match(
      /<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/,
    )?.[1];
    expect(block).toContain("\\u003c/script>");
    expect(block).not.toContain("</script>");
  });

  it.each(
    LEAKS,
  )("negative control: the %s matcher fires on an unescaped slot", (_name, pattern) => {
    const unescaped = `<p data-template="${HOSTILE_ID}">${HOSTILE}</p>`;
    expect(unescaped).toMatch(pattern);
  });
});
