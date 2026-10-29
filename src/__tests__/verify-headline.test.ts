/**
 * The page's headline: the strongest verified finding leads, in a fixed priority order, and the
 * totals headline is the fallback.
 *
 * Asserted on the RENDERED page, so the wiring from verification to `<h1>` is what is tested:
 * each category leading on its own, each losing to every higher one, a clean, not-checked or
 * could-not-check category never leading, a card that could not confirm never leading (but a
 * skipped-checks or lost-work count read from git state, which may), nothing leading a Codex
 * scan (its reading is limited and unverified) or resting on Codex ran records, and the totals
 * headline whenever nothing may lead, verification absent included.
 *
 * Secrets is driven through its real card. Every other category's claim comes from a TEST-ONLY
 * builder (`claimCard`), so the picking order and its rules are tested apart from what each
 * category's own check finds; each real card's headline claim is tested with that card.
 */

import { describe, expect, it } from "vitest";
import { headline, renderReport } from "../core/report.js";
import type { ScanResult } from "../core/scan-report.js";
import { CARD_BUILDERS } from "../core/verify/builders.js";
import {
  type CardBuilders,
  type CardView,
  GIT_STATE_CLAIMS,
  HEADLINE_BASIS,
  HEADLINE_ORDER,
  type HeadlineClaim,
  notCheckedCard,
  pickHeadline,
  type Unconfirmed,
} from "../core/verify/cards.js";
import { shareCounts } from "../core/verify/share-copy.js";
import {
  type HidingForm,
  type RanEvidence,
  type SecretsFacts,
  VERIFY_CATEGORIES,
  type Verification,
  type VerifyCategory,
  type VerifyStatus,
} from "../core/verify/types.js";
import { baseResult, basisOf, SECRETS_ACT, VERIFIED_META } from "./verified-corpus.js";

/** What one category reports. */
interface Entry {
  readonly status: VerifyStatus;
  /** The count it would put in the headline: for secrets, the likely-real count. */
  readonly claim: number;
  /** Its claim rests on Codex `ran` records. Secrets never does. */
  readonly codex?: boolean;
  /** Hiding forms its check names, so it could not confirm what it reports. */
  readonly forms?: readonly HidingForm[];
}

/** TEST-ONLY: a card whose headline claim is `facts.claim`, named after its category. */
function claimCard(category: VerifyCategory) {
  return (result: {
    readonly status: VerifyStatus;
    readonly matches: number;
    readonly facts: { readonly items: readonly number[] };
  }): CardView => {
    // Registered keys only: the claim and the Codex flag ride in `items`.
    const claim = result.facts.items[0] ?? 0;
    const codex = result.facts.items[1] === 1;
    return {
      category,
      tone: result.status,
      count: result.matches,
      found: [],
      now: [],
      fixes: [],
      codexCaveat: codex,
      ...(claim > 0
        ? {
            headline: {
              basis: basisOf(category),
              count: claim,
              restsOnCodexRan: codex,
              sentence: {
                template: `test-only.headline.${category}`,
                text: `Lead from ${category}`,
              },
            },
          }
        : {}),
    };
  };
}

/** The real secrets card, and a test-only card for every other category. */
const BUILDERS = {
  ...Object.fromEntries(VERIFY_CATEGORIES.map((category) => [category, claimCard(category)])),
  secrets: CARD_BUILDERS.secrets,
} as unknown as CardBuilders;

/** Secrets facts with `n` likely-real credentials. */
function secretsFacts(n: number): SecretsFacts {
  return {
    ...SECRETS_ACT,
    classes: { ...SECRETS_ACT.classes, "likely-real": n },
    items: n > 0 ? SECRETS_ACT.items : [],
  };
}

/** A verification where the named categories report, and every other is not checked. */
function verificationOf(
  entries: Partial<Record<VerifyCategory, Entry>>,
  ranEvidence: RanEvidence = "tool-result",
): Verification {
  const categories = Object.fromEntries(
    VERIFY_CATEGORIES.map((category) => {
      const entry = entries[category];
      if (category === "secrets") {
        // The secrets check always carries its facts, whatever its status.
        return [
          category,
          entry === undefined
            ? { status: "not-checked", matches: 0, facts: { ...secretsFacts(0), filesRead: 0 } }
            : { status: entry.status, matches: entry.claim, facts: secretsFacts(entry.claim) },
        ];
      }
      return [
        category,
        entry === undefined
          ? { status: "not-checked" }
          : {
              status: entry.status,
              matches: entry.claim,
              facts: {
                items: [entry.claim, entry.codex === true ? 1 : 0],
                ...(entry.forms === undefined ? {} : { hidingForms: entry.forms }),
              },
            },
      ];
    }),
  );
  return {
    matchedCalls: { ran: 5, mentioned: 0, unknown: 0 },
    resultsRecorded: true,
    ranEvidence,
    categories: categories as unknown as Verification["categories"],
  };
}

/**
 * The `<h1>` of a page: its template, or `undefined` for the totals headline, and its text with
 * the emphasis around its counted phrase taken out.
 */
function h1(html: string): { template: string | undefined; text: string } {
  const m = html.match(/<h1 id="headline"(?: data-template="([^"]+)")?>(.*?)<\/h1>/);
  return { template: m?.[1], text: (m?.[2] ?? "").replace(/<\/?em>/g, "") };
}

function page(entries: Partial<Record<VerifyCategory, Entry>>, result?: ScanResult): string {
  return renderReport(result ?? baseResult(verificationOf(entries)), VERIFIED_META, {
    cardBuilders: BUILDERS,
  });
}

/** The template a category's claim is rendered from. */
const templateOf = (category: VerifyCategory): string =>
  category === "secrets" ? "hero.headline.secrets" : `test-only.headline.${category}`;

/** The tone a category leads from: cloud changes are always review. */
const leading = (category: VerifyCategory): VerifyStatus =>
  category === "cloud" ? "review" : "act";

const TOTALS = headline(baseResult(undefined));

const TOOL_RESULT = { ranEvidence: "tool-result" } as const;

describe("the headline picks the strongest verified finding", () => {
  it.each(HEADLINE_ORDER)("%s leads on its own", (category) => {
    const html = page({ [category]: { status: leading(category), claim: 2 } });
    expect(h1(html).template).toBe(templateOf(category));
    // The totals are not the headline: they are the counts of "What Guard would have done".
    expect(html).not.toContain(TOTALS);
    expect(html).toContain('id="outcomes"');
  });

  it.each(
    HEADLINE_ORDER.flatMap((lower, i) =>
      HEADLINE_ORDER.slice(0, i).map((higher) => [higher, lower] as const),
    ),
  )("%s beats %s", (higher, lower) => {
    const html = page({
      [lower]: { status: leading(lower), claim: 9 },
      [higher]: { status: leading(higher), claim: 1 },
    });
    expect(h1(html).template).toBe(templateOf(higher));
  });

  it("the order: credentials, skipped checks, lost work, IAM, test floors, recursive deletes", () => {
    expect(HEADLINE_ORDER).toEqual([
      "secrets",
      "skipped-checks",
      "lost-work",
      "cloud",
      "tests",
      "destructive",
    ]);
  });
});

describe("what never leads", () => {
  it.each(
    HEADLINE_ORDER.flatMap((category) =>
      (["clean", "could-not-check", "not-checked"] as const).map(
        (tone) => [category, tone] as const,
      ),
    ),
  )("a %s finding that is %s", (category, tone) => {
    const html = page({ [category]: { status: tone, claim: 4 } });
    expect(h1(html)).toEqual({ template: undefined, text: TOTALS });
  });

  it.each(HEADLINE_ORDER.filter((c) => c !== "cloud"))("a %s finding in review", (category) => {
    expect(h1(page({ [category]: { status: "review", claim: 4 } })).template).toBeUndefined();
  });

  it.each(
    HEADLINE_ORDER.flatMap((category) =>
      (
        [
          { reason: "hiding-forms", forms: ["eval"] },
          { reason: "no-output", forms: [] },
        ] as const satisfies readonly Unconfirmed[]
      ).map((unconfirmed) => [category, unconfirmed.reason, unconfirmed] as const),
    ),
  )("a %s finding whose card could not confirm (%s), whatever its tone", (category, _r, unconfirmed) => {
    const card: CardView = {
      ...notCheckedCard(category),
      tone: leading(category),
      count: 4,
      headline: {
        basis: HEADLINE_BASIS[category],
        count: 4,
        restsOnCodexRan: false,
        sentence: { template: "x", text: "x" },
      },
    };
    // The same card, confirmed, leads, so the test is not vacuous.
    expect(pickHeadline([card], { ranEvidence: "tool-result" })?.category).toBe(category);
    expect(
      pickHeadline([{ ...card, unconfirmed }], { ranEvidence: "tool-result" }),
    ).toBeUndefined();
  });

  it.each(
    HEADLINE_ORDER.flatMap((category) =>
      (
        [
          { reason: "hiding-forms", forms: ["eval"], found: true },
          { reason: "no-output", forms: [] },
        ] as const satisfies readonly Unconfirmed[]
      ).map((unconfirmed) => [category, unconfirmed.reason, unconfirmed] as const),
    ),
  )("a %s claim confirmed by git state, whose card could not confirm (%s)", (category, _r, unconfirmed) => {
    const marked: HeadlineClaim = {
      basis: HEADLINE_BASIS[category],
      count: 4,
      restsOnCodexRan: false,
      confirmedBy: "git-state",
      sentence: { template: "x", text: "x" },
    };
    const card: CardView = {
      ...notCheckedCard(category),
      tone: leading(category),
      count: 4,
      headline: marked,
      unconfirmed,
    };
    // Only the two categories whose count git confirms may carry the mark; a forged one elsewhere
    // is ignored, and the card stays out of the headline and the share post.
    const gitState = GIT_STATE_CLAIMS.has(category);
    expect(pickHeadline([card], TOOL_RESULT)?.category).toBe(gitState ? category : undefined);
    expect(shareCounts([card], TOOL_RESULT)).toHaveLength(gitState ? 1 : 0);
    // Without the mark it never leads, so the exception is the mark and nothing else.
    const { confirmedBy: _mark, ...unmarked } = marked;
    expect(pickHeadline([{ ...card, headline: unmarked }], TOOL_RESULT)).toBeUndefined();
    expect(shareCounts([{ ...card, headline: unmarked }], TOOL_RESULT)).toEqual([]);
    // And the mark never lets a claim lead a Codex scan.
    expect(pickHeadline([card], { ranEvidence: "output-record" })).toBeUndefined();
  });

  it("the git-state categories are skipped checks and lost work", () => {
    expect([...GIT_STATE_CLAIMS].sort()).toEqual(["lost-work", "skipped-checks"]);
  });

  it.each(
    HEADLINE_ORDER.filter((c) => c !== "secrets"),
  )("a %s finding to act on whose calls held hiding forms, on the page", (category) => {
    // Its card keeps its tone, and says it could not confirm; the page's headline is the totals.
    const html = page({ [category]: { status: leading(category), claim: 4, forms: ["eval"] } });
    expect(html).toContain(`id="check-${category}"`);
    expect(html).toContain('data-template="could-not-confirm">Could not confirm everything: ');
    expect(h1(html)).toEqual({ template: undefined, text: TOTALS });
    expect(h1(page({ [category]: { status: leading(category), claim: 4 } })).template).toBe(
      templateOf(category),
    );
  });

  it.each([
    "prod-infra",
    "unreviewed",
    "egress",
  ] as const)("a %s finding, even to act on", (category) => {
    expect(h1(page({ [category]: { status: "act", claim: 4 } })).template).toBeUndefined();
  });

  it.each(
    HEADLINE_ORDER,
  )("a %s finding on a Codex scan, whose reading is unverified", (category) => {
    const entries = { [category]: { status: leading(category), claim: 4 } };
    // The same finding leads a scan whose results are recorded, so the test is not vacuous.
    expect(h1(page(entries)).template).toBe(templateOf(category));
    const codex = renderReport(
      baseResult(verificationOf(entries, "output-record")),
      VERIFIED_META,
      { cardBuilders: BUILDERS },
    );
    expect(h1(codex)).toEqual({ template: undefined, text: TOTALS });
  });

  it.each(
    HEADLINE_ORDER.filter((c) => c !== "secrets"),
  )("a %s claim that rests on Codex ran records", (category) => {
    const html = page({ [category]: { status: leading(category), claim: 4, codex: true } });
    expect(h1(html)).toEqual({ template: undefined, text: TOTALS });
  });

  it("a cloud card to act on: cloud leads only from review", () => {
    expect(h1(page({ cloud: { status: "act", claim: 4 } })).template).toBeUndefined();
    expect(h1(page({ cloud: { status: "review", claim: 4 } })).template).toBe(
      "test-only.headline.cloud",
    );
  });

  it("a claim that rests on Codex ran records gives way to a lower one that does not", () => {
    const html = page({
      "skipped-checks": { status: "act", claim: 9, codex: true },
      destructive: { status: "act", claim: 1 },
    });
    expect(h1(html).template).toBe("test-only.headline.destructive");
  });

  it("a count of zero", () => {
    expect(h1(page({ "lost-work": { status: "act", claim: 0 } })).template).toBeUndefined();
    expect(h1(page({ secrets: { status: "act", claim: 0 } })).template).toBeUndefined();
  });
});

describe("the totals headline is the fallback", () => {
  it("with no verification, the page is the totals page: no verified section, no moved line", () => {
    const html = renderReport(baseResult(undefined), VERIFIED_META);
    expect(h1(html)).toEqual({ template: undefined, text: TOTALS });
    for (const part of ['id="found"', 'id="also-checked"', 'id="what-happened"', "lead totals"]) {
      expect(html).not.toContain(part);
    }
    expect(html).toContain("What your coding agent actually did");
  });

  it("with verification and every category clean, the cards still render under the totals headline", () => {
    const html = page(
      Object.fromEntries(HEADLINE_ORDER.map((c) => [c, { status: "clean", claim: 3 }])),
    );
    expect(h1(html)).toEqual({ template: undefined, text: TOTALS });
    expect(html).toContain('id="what-happened"');
    expect(html).toContain('id="also-checked"');
    expect(html).not.toContain("lead totals");
  });

  it("a scan that read no tool calls keeps the empty state, with no verified lead", () => {
    const empty: ScanResult = {
      ...baseResult(verificationOf({ secrets: { status: "act", claim: 3 } })),
      toolCalls: 0,
      sessions: 0,
    };
    const html = page({}, empty);
    expect(h1(html).text).toBe("No sessions found to scan");
    expect(html).not.toContain('id="what-happened"');
    expect(html).not.toContain('id="found"');
  });
});

describe("the secrets card's own headline", () => {
  /** A page from the real builders, with the secrets facts given. */
  function secretsPage(facts: SecretsFacts, evidence: Verification["ranEvidence"] = "tool-result") {
    const pending = verificationOf({});
    const v: Verification = {
      ...pending,
      ranEvidence: evidence,
      categories: {
        ...pending.categories,
        secrets: {
          status: facts.classes["likely-real"] > 0 ? "act" : "clean",
          matches: 3,
          facts,
        },
      },
    };
    return renderReport(baseResult(v), VERIFIED_META, { cardBuilders: CARD_BUILDERS });
  }

  it("states the likely-real count, and never a value or a name", () => {
    expect(h1(secretsPage(SECRETS_ACT))).toEqual({
      template: "hero.headline.secrets",
      text: "Claude Code left 3 likely-real credentials in its transcripts.",
    });
  });

  it("uses the singular for one", () => {
    expect(h1(secretsPage(secretsFacts(1))).text).toBe(
      "Claude Code left 1 likely-real credential in its transcripts.",
    );
  });

  it("makes no claim when none is likely real", () => {
    expect(h1(secretsPage(secretsFacts(0))).template).toBeUndefined();
  });

  it("never leads a Codex scan, and its card and chip still render", () => {
    const html = secretsPage(SECRETS_ACT, "output-record");
    expect(h1(html)).toEqual({ template: undefined, text: TOTALS });
    expect(html).toContain('id="check-secrets"');
    expect(html).toContain('id="found"');
    expect(html).not.toContain("lead totals");
  });
});
