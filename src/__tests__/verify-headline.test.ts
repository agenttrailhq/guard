/**
 * The page's headline: the strongest verified finding leads, in a fixed priority order, and the
 * totals headline is the fallback.
 *
 * Asserted on the RENDERED page, so the wiring from verification to `<h1>` is what is tested:
 * each category leading on its own, each losing to every higher one, a clean, not-checked or
 * could-not-check category never leading, a Codex-only finding never leading, and the totals
 * headline whenever nothing may lead, verification absent included.
 *
 * Secrets is driven through its real card. Every other category's claim comes from a TEST-ONLY
 * builder, since those checks do not exist in this build.
 */

import { describe, expect, it } from "vitest";
import { headline, renderReport } from "../core/report.js";
import type { ScanResult } from "../core/scan-report.js";
import { CARD_BUILDERS } from "../core/verify/builders.js";
import { type CardBuilders, type CardView, HEADLINE_ORDER } from "../core/verify/cards.js";
import {
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
}

/** TEST-ONLY: a card whose headline claim is `facts.claim`, named after its category. */
function claimCard(category: VerifyCategory) {
  return (result: {
    readonly status: VerifyStatus;
    readonly matches: number;
    readonly facts: { readonly claim: number; readonly codex: boolean };
  }): CardView => ({
    category,
    tone: result.status,
    count: result.matches,
    found: [],
    now: [],
    fixes: [],
    codexCaveat: result.facts.codex,
    ...(result.facts.claim > 0
      ? {
          headline: {
            basis: basisOf(category),
            count: result.facts.claim,
            restsOnCodexRan: result.facts.codex,
            sentence: { template: `test-only.headline.${category}`, text: `Lead from ${category}` },
          },
        }
      : {}),
  });
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
function verificationOf(entries: Partial<Record<VerifyCategory, Entry>>): Verification {
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
              facts: { claim: entry.claim, codex: entry.codex ?? false },
            },
      ];
    }),
  );
  return {
    matchedCalls: { ran: 5, mentioned: 0, unknown: 0 },
    resultsRecorded: true,
    ranEvidence: "tool-result",
    categories: categories as unknown as Verification["categories"],
  };
}

/** The `<h1>` of a page: its template, or `undefined` for the totals headline, and its text. */
function h1(html: string): { template: string | undefined; text: string } {
  const m = html.match(/<h1(?: data-template="([^"]+)")?>([^<]*)<\/h1>/);
  return { template: m?.[1], text: m?.[2] ?? "" };
}

function page(entries: Partial<Record<VerifyCategory, Entry>>, result?: ScanResult): string {
  return renderReport(result ?? baseResult(verificationOf(entries)), VERIFIED_META, {
    cardBuilders: BUILDERS,
  });
}

/** The template a category's claim is rendered from. */
const templateOf = (category: VerifyCategory): string =>
  category === "secrets" ? "secrets.headline" : `test-only.headline.${category}`;

/** The tone a category leads from: cloud changes are always review. */
const leading = (category: VerifyCategory): VerifyStatus =>
  category === "cloud" ? "review" : "act";

const TOTALS = headline(baseResult(undefined));

describe("the headline picks the strongest verified finding", () => {
  it.each(HEADLINE_ORDER)("%s leads on its own", (category) => {
    const html = page({ [category]: { status: leading(category), claim: 2 } });
    expect(h1(html).template).toBe(templateOf(category));
    // The totals headline moves to the line under it.
    expect(html).toContain(`<p class="lead totals">${TOTALS}.</p>`);
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

  it.each([
    "prod-infra",
    "unreviewed",
    "egress",
  ] as const)("a %s finding, even to act on", (category) => {
    expect(h1(page({ [category]: { status: "act", claim: 4 } })).template).toBeUndefined();
  });

  it.each(
    HEADLINE_ORDER.filter((c) => c !== "secrets"),
  )("a %s finding seen only through Codex output records", (category) => {
    const html = page({ [category]: { status: leading(category), claim: 4, codex: true } });
    expect(h1(html)).toEqual({ template: undefined, text: TOTALS });
  });

  it("a Codex-only finding gives way to a lower one that does not rest on Codex", () => {
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
      template: "secrets.headline",
      text: "3 likely-real credentials are still in the agent&#39;s transcripts",
    });
  });

  it("uses the singular for one", () => {
    expect(h1(secretsPage(secretsFacts(1))).text).toBe(
      "1 likely-real credential is still in the agent&#39;s transcripts",
    );
  });

  it("makes no claim when none is likely real", () => {
    expect(h1(secretsPage(secretsFacts(0))).template).toBeUndefined();
  });

  it("still leads on Codex: a credential is found in text, not in a call that ran", () => {
    expect(h1(secretsPage(SECRETS_ACT, "output-record")).template).toBe("secrets.headline");
  });
});
