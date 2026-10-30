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
    "1 real credential left in its transcripts",
    "3 real credentials left in its transcripts",
  ],
  "skipped-checks": [
    "1 commit shipped without its checks",
    "3 commits shipped without their checks",
  ],
  "lost-work": [
    "1 piece of deleted work it could still bring back",
    "3 pieces of deleted work it could still bring back",
  ],
  cloud: ["1 IAM change that needs a review", "3 IAM changes that need a review"],
  tests: ["1 test floor it lowered", "3 test floors it lowered"],
  destructive: [
    "1 recursive delete with nothing guarding it",
    "3 recursive deletes with nothing guarding them",
  ],
};

/** The post's fixed opening, before its middle lines. */
const OPENING = (agent = "Claude Code", calls = "7") =>
  `Gave ${agent} its first performance review.\n\n@agenttrailhq Guard checked ${calls} of its tool calls, locally:\n`;

/** The post's fixed close, after its middle lines. */
const CLOSE = (flag = "claude") =>
  `\n\nHow did yours do?\nnpm i -g @agenttrail/guard\nagenttrail-guard scan --agent ${flag}`;

/** The whole post for these middle lines. */
const POST = (lines: readonly string[], agent = "Claude Code", flag = "claude") =>
  `${OPENING(agent)}${lines.join("\n")}${CLOSE(flag)}`;

/** A post's middle lines. */
const middle = (text: string): string[] =>
  text.slice(text.indexOf(":\n") + 2, text.indexOf("\n\nHow did yours do?")).split("\n");

describe("the post follows the template", () => {
  it("is the fixed opening, the counts one per line, and the fixed close", () => {
    expect(post([claim("secrets", 4), claim("skipped-checks", 5)])).toBe(
      [
        "Gave Claude Code its first performance review.",
        "",
        "@agenttrailhq Guard checked 7 of its tool calls, locally:",
        "4 real credentials left in its transcripts",
        "5 commits shipped without their checks",
        "",
        "How did yours do?",
        "npm i -g @agenttrail/guard",
        "agenttrail-guard scan --agent claude",
      ].join("\n"),
    );
  });

  it.each([
    ["claude", "Claude Code"],
    ["cursor", "Cursor"],
    ["codex", "Codex"],
  ] as const)("names the app and its --agent for a %s scan", (agent, name) => {
    const text = totalsShareText({ ...RESULT, agent });
    expect(text.startsWith(`Gave ${name} its first performance review.`)).toBe(true);
    expect(text.endsWith(`agenttrail-guard scan --agent ${agent}`)).toBe(true);
  });

  it("writes the tool-call count with separators", () => {
    expect(totalsShareText({ ...RESULT, toolCalls: 54321 })).toContain(
      "Guard checked 54,321 of its tool calls, locally:",
    );
  });
});

describe("the post states each verified count that may lead", () => {
  it.each(HEADLINE_ORDER)("%s, in the singular and the plural", (category) => {
    const [one, many] = LINES[category];
    expect(post([claim(category, 1)])).toBe(POST([one]));
    expect(post([claim(category, 3)])).toBe(POST([many]));
  });

  it("several, most important first, apart from the order the cards come in", () => {
    const text = post([claim("destructive", 2), claim("secrets", 3), claim("cloud", 1)]);
    expect(middle(text)).toEqual([
      "3 real credentials left in its transcripts",
      "1 IAM change that needs a review",
    ]);
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

describe("the totals post's lines", () => {
  it("say how many actions it would have blocked, asked about and warned about, as many as fit", () => {
    const result = { ...RESULT, riskyByAction: { block: 445, require_approval: 1, warn: 9 } };
    const text = totalsShareText(result);
    expect(middle(text)).toEqual([
      "445 actions it would have blocked",
      "1 action it would have asked me about",
    ]);
    expect(postLength(text)).toBeLessThanOrEqual(POST_LIMIT);
    const warned = { ...RESULT, riskyByAction: { block: 0, require_approval: 0, warn: 1 } };
    expect(middle(totalsShareText(warned))).toEqual(["1 action it would have warned me about"]);
  });

  it("leave out an action that never came up, and say so when nothing matched", () => {
    const some = { ...RESULT, riskyByAction: { block: 0, require_approval: 2, warn: 0 } };
    expect(middle(totalsShareText(some))).toEqual(["2 actions it would have asked me about"]);
    const none = { ...RESULT, riskyByAction: { block: 0, require_approval: 0, warn: 0 } };
    expect(middle(totalsShareText(none))).toEqual(["nothing that matched a guardrail"]);
  });

  it("name no guardrail, not even a library one", () => {
    for (const finding of RESULT.findings) {
      expect(TOTALS).not.toContain(finding.title);
    }
  });
});

describe("the post fits in an X post", () => {
  it("drops the least important counts until it fits, and never goes over", () => {
    const huge = HEADLINE_ORDER.map((c) => claim(c, 987_654_321));
    const text = post(huge);
    expect(postLength(text)).toBeLessThanOrEqual(POST_LIMIT);
    expect(text).toContain("987,654,321 real credentials left in its transcripts");
    expect(text).not.toContain("recursive deletes");
  });

  it("keeps whole a post that weighs exactly the limit", () => {
    const text = post([claim("secrets", 1000), claim("skipped-checks", 100_000)]);
    expect(postLength(text)).toBe(POST_LIMIT);
    expect(text).toContain("100,000 commits shipped without their checks");
  });

  it("drops the last count when keeping it would weigh one over the limit", () => {
    const lines = [
      sharePhrase("likely-real-credentials", 10_000),
      sharePhrase("commits-on-main-without-checks", 100_000),
    ];
    expect(postLength(POST(lines))).toBe(POST_LIMIT + 1);
    const text = post([claim("secrets", 10_000), claim("skipped-checks", 100_000)]);
    expect(text).toBe(POST(lines.slice(0, 1)));
  });

  it("states as many as fit, in order: the next one would not have", () => {
    const cards = HEADLINE_ORDER.map((c) => claim(c, 2));
    const text = post(cards);
    expect(postLength(text)).toBeLessThanOrEqual(POST_LIMIT);
    const stated = middle(text);
    expect(stated.length).toBeGreaterThan(1);
    expect(stated.length).toBeLessThan(6);
    // In priority order, with no gap.
    expect(stated).toEqual(
      HEADLINE_ORDER.slice(0, stated.length).map((c) => sharePhrase(HEADLINE_BASIS[c], 2)),
    );
    const next = sharePhrase(HEADLINE_BASIS[HEADLINE_ORDER[stated.length] ?? "secrets"], 2);
    expect(postLength(POST([...stated, next]))).toBeGreaterThan(POST_LIMIT);
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

  it("with the fixed opening, close and phrases taken out, only counts and line breaks are left", () => {
    const text = post(HEADLINE_ORDER.map(loud));
    let rest = text.replace(OPENING(), "").replace(CLOSE(), "");
    expect(rest.length).toBeGreaterThan(20);
    for (const [one, many] of Object.values(LINES)) {
      for (const phrase of [one, many]) rest = rest.split(phrase.replace(/^\d+ /, "")).join("");
    }
    expect(rest).toMatch(/^[\d,\n ]+$/);
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
      POST([
        "3 real credentials left in its transcripts",
        "3 commits shipped without their checks",
      ]),
    );
    expect(postLength(payload.shareText)).toBeLessThanOrEqual(POST_LIMIT);
    const section = shareSection(renderReport(VERIFIED_RESULT, VERIFIED_META, OPTIONS));
    expect(section).toContain("Counts from the checks on this machine, and nothing else");
    expect(section).toContain(">Gave Claude Code its first performance review.\n\n@agenttrailhq");
    // The X link is a plain link holding the same text, with no script needed.
    expect(section).toContain(`href="${shareLink(payload.shareText)}"`);
    expect(section).not.toMatch(/\son[a-z]+=/i);
  });

  it("the X link's text is encoded, and decodes to exactly the post", () => {
    const payload = reportPayload(VERIFIED_RESULT, VERIFIED_META, TEST_ONLY_BUILDERS);
    const section = shareSection(renderReport(VERIFIED_RESULT, VERIFIED_META, OPTIONS));
    const raw = section.match(/href="(https:\/\/x\.com\/intent\/post\?[^"]*)"/)?.[1];
    expect(raw).toBeDefined();
    const href = (raw ?? "").replace(/&amp;/g, "&");
    // Read from the page, not from the function that made it: no raw space or separator.
    expect(href).not.toMatch(/[\s·]/);
    expect(new URL(href).searchParams.get("text")).toBe(payload.shareText);
    // The text is the only parameter: no link or hashtag is added to the post.
    expect([...new URL(href).searchParams.keys()]).toEqual(["text"]);
    expect(href).toContain("%0A");
    // The post itself does hold spaces and line breaks, so the check above is not vacuous.
    expect(payload.shareText).toMatch(/ /);
    expect(payload.shareText).toContain("\n");
  });

  it.each([
    ["a Codex scan", CODEX_ONLY_RESULT],
    ["a scan where nothing may lead", FALLBACK_RESULT],
  ] as const)("%s shares the totals post, with its own note", (_n, result) => {
    const html = renderReport(result, VERIFIED_META, OPTIONS);
    expect(reportPayload(result, VERIFIED_META, TEST_ONLY_BUILDERS).shareText).toBe(
      totalsShareText(result),
    );
    expect(shareSection(html)).toContain("Totals from this scan, and nothing else");
  });

  it("a card that could not confirm is left out of the page's post", () => {
    const text = reportPayload(HIDING_RESULT, VERIFIED_META, TEST_ONLY_BUILDERS).shareText;
    expect(text).toContain("3 real credentials left in its transcripts");
    expect(text).not.toContain("deleted work");
  });
});

describe("a Cursor scan, whose sessions record no command output", () => {
  const CURSOR: CardContext = { ranEvidence: "none" };

  it("still states a credential, which is found in text rather than in a call that ran", () => {
    expect(middle(post([claim("secrets", 3)], CURSOR))).toEqual([
      "3 real credentials left in its transcripts",
    ]);
  });

  it("never states a count its card could not confirm for want of output", () => {
    const unconfirmed = claim("destructive", 2, {
      unconfirmed: { reason: "no-output", forms: [] },
    });
    expect(post([unconfirmed], CURSOR)).toBe(TOTALS);
    expect(post([claim("secrets", 3), unconfirmed], CURSOR)).not.toContain("recursive delete");
  });

  it("on the page, the post states only confirmed counts, and never a zero", () => {
    const text = reportPayload(CURSOR_RESULT, VERIFIED_META, TEST_ONLY_BUILDERS).shareText;
    expect(text.startsWith(OPENING("Cursor"))).toBe(true);
    expect(text.endsWith(CLOSE("cursor"))).toBe(true);
    expect(text).toContain("3 real credentials left in its transcripts");
    expect(text).not.toMatch(/\n0 /);
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
    expect(html).toContain("Totals from this scan, and nothing else");
    expect(html).not.toContain("credentials left in its transcripts");
  });
});
