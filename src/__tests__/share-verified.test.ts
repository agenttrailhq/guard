/**
 * The share post from verified counts: what it states, when it falls back to the totals post,
 * how long it may be, and that it carries counts and fixed phrases only.
 */

import { describe, expect, it } from "vitest";
import {
  postLength,
  renderReport,
  reportPayload,
  shareLink,
  shareText,
  totalsShareText,
} from "../core/report.js";
import { POST_LIMIT } from "../core/report-script.js";
import type { ScanResult } from "../core/scan-report.js";
import {
  type CardContext,
  type CardView,
  HEADLINE_BASIS,
  HEADLINE_ORDER,
  notCheckedCard,
  pickHeadline,
} from "../core/verify/cards.js";
import { sharePhrase } from "../core/verify/share-copy.js";
import type { VerifyCategory, VerifyStatus } from "../core/verify/types.js";
import {
  baseResult,
  CODEX_ONLY_RESULT,
  CURSOR_RESULT,
  FALLBACK_RESULT,
  HIDING_RESULT,
  LOCAL_FIX_CATEGORIES,
  TEST_ONLY_BUILDERS,
  VERIFIED_META,
  VERIFIED_RESULT,
  verification,
  verifiedCategories,
} from "./verified-corpus.js";

const RECORDED: CardContext = { ranEvidence: "tool-result" };
const CODEX: CardContext = { ranEvidence: "output-record" };

type Leading = (typeof HEADLINE_ORDER)[number];

/** The tone each category leads from: cloud changes are always review. */
const leading = (category: VerifyCategory): VerifyStatus =>
  category === "cloud" ? "review" : "act";

/** A card that claims `count` for its category, with a sentence that must never be shared. */
function claim(
  category: Leading,
  count: number,
  over: Partial<CardView> = {},
  restsOnCodexRan = false,
): CardView {
  return {
    ...notCheckedCard(category),
    tone: leading(category),
    count,
    headline: {
      basis: HEADLINE_BASIS[category],
      count,
      restsOnCodexRan,
      sentence: { template: `test-only.${category}`, text: `SECRET-SENTENCE ${category}` },
    },
    ...over,
  };
}

/** The scan the posts are about. */
const RESULT = VERIFIED_RESULT;
const TOTALS = totalsShareText(RESULT);
const post = (cards: readonly CardView[], context: CardContext = RECORDED) =>
  shareText(RESULT, { cards, context });

/** Each basis's phrase, written out, so a change to the words shows up here. */
const LINES: Readonly<Record<Leading, readonly [string, string]>> = {
  secrets: [
    "1 likely-real credential left in its transcripts",
    "3 likely-real credentials left in its transcripts",
  ],
  "skipped-checks": [
    "1 commit shipped to main without its checks",
    "3 commits shipped to main without their checks",
  ],
  "lost-work": [
    "1 piece of deleted work still recoverable",
    "3 pieces of deleted work still recoverable",
  ],
  cloud: ["1 IAM change ran and needs a review", "3 IAM changes ran and need a review"],
  tests: ["1 lowered test floor", "3 lowered test floors"],
  destructive: ["1 unguarded recursive delete", "3 unguarded recursive deletes"],
};

describe("the post states each verified count that may lead", () => {
  it.each(HEADLINE_ORDER)("%s, in the singular and the plural", (category) => {
    const [one, many] = LINES[category];
    expect(post([claim(category, 1)])).toBe(
      `AgentTrail Guard checked 7 tool calls from Claude Code on my machine: ${one}. Nothing uploaded.`,
    );
    expect(post([claim(category, 3)])).toContain(`: ${many}.`);
  });

  it("several, most important first, apart from the order the cards come in", () => {
    const text = post([claim("destructive", 2), claim("secrets", 3), claim("cloud", 1)]);
    expect(text).toContain(
      ": 3 likely-real credentials left in its transcripts · 1 IAM change ran and needs a review · 2 unguarded recursive deletes.",
    );
  });

  it("the cloud phrase says IAM changes ran and need a review, never that harm was done", () => {
    const words = `${sharePhrase("iam-changes", 1)} ${sharePhrase("iam-changes", 4)}`;
    expect(words).not.toMatch(/\b(breach|compromised|leak|attack|harm|damage|exposed)/i);
  });
});

describe("the totals post when nothing verified may be stated", () => {
  const FALLBACKS: readonly [string, () => string][] = [
    ["no verification", () => shareText(RESULT)],
    ["no card", () => post([])],
    ["a Codex scan, whose reading is unverified", () => post([claim("secrets", 3)], CODEX)],
    [
      "a card that could not confirm what it reports",
      () =>
        post([claim("lost-work", 3, { unconfirmed: { reason: "hiding-forms", forms: ["eval"] } })]),
    ],
    ["a clean card", () => post([claim("secrets", 3, { tone: "clean" })])],
    ["a could-not-check card", () => post([claim("secrets", 3, { tone: "could-not-check" })])],
    ["a not-checked card", () => post([claim("secrets", 3, { tone: "not-checked" })])],
    ["a claim that rests on Codex ran records", () => post([claim("skipped-checks", 3, {}, true)])],
    ["a cloud card to act on", () => post([claim("cloud", 3, { tone: "act" })])],
    ["a count of zero", () => post([claim("secrets", 0)])],
    [
      "a category that never leads",
      () => post([{ ...claim("secrets", 3), category: "prod-infra" }]),
    ],
    [
      "a claim with another category's basis",
      () =>
        post([
          claim("cloud", 3, {
            headline: {
              basis: "likely-real-credentials",
              count: 3,
              restsOnCodexRan: false,
              sentence: { template: "x", text: "x" },
            },
          }),
        ]),
    ],
  ];

  it.each(FALLBACKS)("%s", (_name, make) => {
    expect(make()).toBe(TOTALS);
  });

  it("a scan that read no tool calls", () => {
    const empty = { ...RESULT, toolCalls: 0 };
    expect(shareText(empty, { cards: [claim("secrets", 3)], context: RECORDED })).toBe(
      totalsShareText(empty),
    );
  });

  it.each([
    ["a fraction", 2.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a negative count", -3],
    ["a number in a string", "9"],
  ] as const)("a claim whose count is %s, which only a type-violating builder could pass", (_n, bad) => {
    const card = claim("secrets", 3);
    const broken = {
      ...card,
      headline: { ...(card.headline as NonNullable<CardView["headline"]>), count: bad as number },
    };
    expect(post([broken])).toBe(TOTALS);
    expect(pickHeadline([broken], RECORDED)).toBeUndefined();
  });

  it.each([
    ["NaN", Number.NaN],
    ["a fraction", 1.5],
    ["a number in a string", "7"],
  ] as const)("a scan whose tool-call count is %s", (_n, bad) => {
    const odd = { ...RESULT, toolCalls: bad as number };
    expect(shareText(odd, { cards: [claim("secrets", 3)], context: RECORDED })).toBe(
      totalsShareText(odd),
    );
  });

  it("negative control: the same claim, recorded and confirmed, is stated", () => {
    expect(post([claim("secrets", 3)])).not.toBe(TOTALS);
  });
});

describe("the post fits in an X post", () => {
  it("drops the least important counts until it fits, and never goes over", () => {
    const huge = HEADLINE_ORDER.map((c) => claim(c, 987_654_321));
    const text = post(huge);
    expect(postLength(text)).toBeLessThanOrEqual(POST_LIMIT);
    expect(text).toContain("987,654,321 likely-real credentials left in its transcripts");
    expect(text).not.toContain("unguarded recursive deletes");
  });

  it("keeps whole a post that weighs exactly the limit", () => {
    const cards = [claim("secrets", 1000), claim("skipped-checks", 1000), claim("lost-work", 1000)];
    const text = post(cards);
    expect(postLength(text)).toBe(POST_LIMIT);
    expect(text).toContain("1,000 pieces of deleted work still recoverable");
  });

  it("drops the last count when keeping it would weigh one over the limit", () => {
    const cards = [
      claim("secrets", 1000),
      claim("skipped-checks", 1000),
      claim("lost-work", 10000),
    ];
    const whole = `AgentTrail Guard checked 7 tool calls from Claude Code on my machine: ${[
      sharePhrase("likely-real-credentials", 1000),
      sharePhrase("commits-on-main-without-checks", 1000),
      sharePhrase("recoverable-deleted-work", 10000),
    ].join(" · ")}. Nothing uploaded.`;
    expect(postLength(whole)).toBe(POST_LIMIT + 1);
    const text = post(cards);
    expect(text).not.toContain("deleted work");
    expect(text).toContain("1,000 commits shipped to main without their checks");
    expect(postLength(text)).toBeLessThanOrEqual(POST_LIMIT);
  });

  it("states as many as fit, in order: the next one would not have", () => {
    const cards = HEADLINE_ORDER.map((c) => claim(c, 2));
    const text = post(cards);
    expect(postLength(text)).toBeLessThanOrEqual(POST_LIMIT);
    const stated = text.split(": ")[1]?.replace(". Nothing uploaded.", "").split(" · ") ?? [];
    expect(stated.length).toBeGreaterThan(1);
    expect(stated.length).toBeLessThan(6);
    // In priority order, with no gap.
    expect(stated).toEqual(
      HEADLINE_ORDER.slice(0, stated.length).map((c) => sharePhrase(HEADLINE_BASIS[c], 2)),
    );
    const next = sharePhrase(HEADLINE_BASIS[HEADLINE_ORDER[stated.length] ?? "secrets"], 2);
    const longer = text.replace(". Nothing uploaded.", ` · ${next}. Nothing uploaded.`);
    expect(postLength(longer)).toBeGreaterThan(POST_LIMIT);
  });
});

describe("counts and fixed phrases only", () => {
  /** A card whose every free slot holds a marker, a path, a name and markup, built in code. */
  const OPEN = "<";
  const MARK = `MARKER /Users/someone/project-zebra ${OPEN}b>x${OPEN}/b> "internal-name"`;
  const loud = (category: Leading): CardView => ({
    ...claim(category, 2),
    found: [{ template: MARK, text: MARK }],
    now: [{ template: MARK, text: MARK }],
    fixSteps: [{ template: MARK, text: MARK }],
    fixes: [{ shape: MARK }],
    chip: { count: 2, label: { template: MARK, text: MARK } },
    read: { template: MARK, text: MARK },
    headline: {
      basis: HEADLINE_BASIS[category],
      count: 2,
      restsOnCodexRan: false,
      sentence: { template: MARK, text: MARK },
    },
  });

  it("no card sentence, label, shape or title reaches the post", () => {
    const text = post(HEADLINE_ORDER.map(loud));
    for (const piece of ["MARKER", "/Users", "zebra", "<b>", "internal-name", "SECRET-SENTENCE"]) {
      expect(text).not.toContain(piece);
    }
  });

  it("with the fixed head, tail and phrases taken out, only counts and separators are left", () => {
    const text = post(HEADLINE_ORDER.map(loud));
    let rest = text
      .replace("AgentTrail Guard checked 7 tool calls from Claude Code on my machine: ", "")
      .replace(". Nothing uploaded.", "");
    expect(rest.length).toBeGreaterThan(20);
    for (const [one, many] of Object.values(LINES)) {
      for (const phrase of [one, many]) rest = rest.split(phrase.replace(/^\d+ /, "")).join("");
    }
    expect(rest).toMatch(/^[\d,· ]+$/);
  });

  it("a guardrail the user wrote never reaches a verified post", () => {
    const withOwn = {
      ...RESULT,
      findings: [
        ...RESULT.findings,
        {
          ruleId: "team.internal",
          title: "Block deploys to project-zebra",
          severity: "high",
          action: "block" as const,
          count: 99,
          examples: [],
          owasp: [],
          source: "yours" as const,
        },
      ],
    };
    const text = shareText(withOwn, { cards: [claim("secrets", 3)], context: RECORDED });
    expect(text).not.toContain("zebra");
    expect(text).not.toContain("team.internal");
  });
});

describe("on the page", () => {
  const OPTIONS = { cardBuilders: TEST_ONLY_BUILDERS, localFixCategories: LOCAL_FIX_CATEGORIES };
  const shareSection = (html: string): string =>
    html.slice(
      html.indexOf('<section id="share"'),
      html.indexOf("</section>", html.indexOf('<section id="share"')),
    );

  it("the verified page's post states its verified counts, in the box and the X link", () => {
    const payload = reportPayload(VERIFIED_RESULT, VERIFIED_META, TEST_ONLY_BUILDERS);
    expect(payload.shareText).toBe(
      "AgentTrail Guard checked 7 tool calls from Claude Code on my machine: 3 likely-real credentials left in its transcripts · 3 commits shipped to main without their checks · 3 pieces of deleted work still recoverable. Nothing uploaded.",
    );
    expect(postLength(payload.shareText)).toBeLessThanOrEqual(POST_LIMIT);
    const section = shareSection(renderReport(VERIFIED_RESULT, VERIFIED_META, OPTIONS));
    expect(section).toContain("Counts from the checks on this machine, and nothing else");
    expect(section).toContain(
      ">AgentTrail Guard checked 7 tool calls from Claude Code on my machine: 3 likely-real",
    );
    // The X link is a plain link holding the same text, with no script needed.
    expect(section).toContain(
      `href="${shareLink(payload.shareText, "claude").replace(/&/g, "&amp;")}"`,
    );
    expect(section).not.toMatch(/\son[a-z]+=/i);
  });

  it.each([
    ["a Codex scan", CODEX_ONLY_RESULT],
    ["a scan where nothing may lead", FALLBACK_RESULT],
  ] as const)("%s shares the totals post, with its own note", (_n, result) => {
    const html = renderReport(result, VERIFIED_META, OPTIONS);
    expect(reportPayload(result, VERIFIED_META, TEST_ONLY_BUILDERS).shareText).toBe(
      totalsShareText(result),
    );
    expect(shareSection(html)).toContain("Totals and at most one library guardrail&#39;s name");
  });

  it("a card that could not confirm is left out of the page's post", () => {
    const text = reportPayload(HIDING_RESULT, VERIFIED_META, TEST_ONLY_BUILDERS).shareText;
    expect(text).toContain("3 likely-real credentials left in its transcripts");
    expect(text).not.toContain("deleted work");
  });
});

describe("a Cursor scan, whose sessions record no command output", () => {
  const CURSOR: CardContext = { ranEvidence: "none" };

  it("still states a credential, which is found in text rather than in a call that ran", () => {
    expect(post([claim("secrets", 3)], CURSOR)).toContain(
      ": 3 likely-real credentials left in its transcripts.",
    );
  });

  it("never states a count its card could not confirm for want of output", () => {
    const unconfirmed = claim("destructive", 2, {
      unconfirmed: { reason: "no-output", forms: [] },
    });
    expect(post([unconfirmed], CURSOR)).toBe(TOTALS);
    expect(post([claim("secrets", 3), unconfirmed], CURSOR)).not.toContain("recursive");
  });

  it("on the page, the post states only confirmed counts, and never a zero", () => {
    const text = reportPayload(CURSOR_RESULT, VERIFIED_META, TEST_ONLY_BUILDERS).shareText;
    expect(text).toContain("AgentTrail Guard checked 7 tool calls from Cursor on my machine: ");
    expect(text).toContain("3 likely-real credentials left in its transcripts");
    expect(text).not.toMatch(/: 0 |· 0 /);
    expect(postLength(text)).toBeLessThanOrEqual(POST_LIMIT);
  });
});

describe("a Codex scan whose credentials card is to act on shares the totals post", () => {
  // The secrets claim does not rest on Codex ran records, so only the scan's own Codex
  // evidence, passed from the payload, keeps it out of the post.
  const codex: ScanResult = {
    ...baseResult(verification(verifiedCategories(), { ranEvidence: "output-record" })),
    agent: "codex",
  };

  it("health: its secrets card is to act on, with a claim that does not rest on Codex ran records", () => {
    const cards = reportPayload(codex, VERIFIED_META, TEST_ONLY_BUILDERS).cards ?? [];
    const secrets = cards.find((c) => c.category === "secrets");
    expect(secrets?.tone).toBe("act");
    expect(secrets?.headline?.restsOnCodexRan).toBe(false);
  });

  it("the post is the totals post, under the totals note", () => {
    const payload = reportPayload(codex, VERIFIED_META, TEST_ONLY_BUILDERS);
    expect(payload.shareText).toBe(totalsShareText(codex));
    const html = renderReport(codex, VERIFIED_META, {
      cardBuilders: TEST_ONLY_BUILDERS,
      localFixCategories: LOCAL_FIX_CATEGORIES,
    });
    expect(html).toContain("Totals and at most one library guardrail&#39;s name");
    expect(html).not.toContain("credentials left in its transcripts");
  });
});
