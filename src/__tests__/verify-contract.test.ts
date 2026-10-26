// cspell:words LOCALFIXCANARY
/**
 * The shapes later checks and the page build on (`core/verify/cards.ts`, `types.ts`): cards,
 * sentences, the headline order, the local-only fix channel, the payload copy of a category's
 * facts, and the switch for verifying by default.
 */

import { describe, expect, it } from "vitest";
import { compileAllowlist } from "../core/evaluate.js";
import { MAX_ROWS, renderJson, renderReport, reportPayload } from "../core/report.js";
import { compileCatalog } from "../core/rules.js";
import { aggregateScan } from "../core/scan-report.js";
import {
  type CardBuilders,
  type CardView,
  COULD_NOT_CHECK_SENTENCE,
  cardsFor,
  couldNotCheckCard,
  HEADLINE_ORDER,
  isLocalFix,
  LOCAL_FIX_SERIALIZED,
  localFix,
  NOT_CHECKED_SENTENCE,
  notCheckedCard,
  orderCards,
  pickHeadline,
  type SentenceTemplate,
  sentence,
  sentences,
  TONE_ORDER,
} from "../core/verify/cards.js";
import {
  type SecretsFacts,
  VERIFY_CATEGORIES,
  type Verification,
  type VerifyCategory,
  type VerifyStatus,
} from "../core/verify/types.js";
import { VERIFY_BY_DEFAULT } from "../core/verify/verify.js";
import { RULE_RM_RF } from "./scan-fixtures.js";

/** Secrets facts with every count zero. */
const NO_FACTS: SecretsFacts = {
  classes: { "likely-real": 0, "committed-fixture": 0, placeholder: 0, "local-dev": 0 },
  items: [],
  moreItems: 0,
  filesRead: 1,
  filesNotRead: 0,
  unplaced: 0,
  setAside: { unnamedOutputOnly: 0, namedNotCredentialShaped: 0 },
  fixtureCheck: "not-needed",
  reposChecked: 0,
  reposNotChecked: 0,
};

/** A verification with the secrets result given and every other category not checked. */
function verification(secretsStatus: VerifyStatus = "act", likely = 2): Verification {
  const pending = { status: "not-checked" } as const;
  return {
    matchedCalls: { ran: 0, mentioned: 0, unknown: 0 },
    resultsRecorded: true,
    ranEvidence: "tool-result",
    categories: {
      secrets: {
        status: secretsStatus,
        matches: likely,
        facts: { ...NO_FACTS, classes: { ...NO_FACTS.classes, "likely-real": likely } },
      },
      "skipped-checks": pending,
      "lost-work": pending,
      cloud: pending,
      "prod-infra": pending,
      tests: pending,
      destructive: pending,
      unreviewed: pending,
      egress: pending,
    },
  };
}

/** A template that states the likely-real count. */
const LIKELY: SentenceTemplate<SecretsFacts> = {
  id: "secrets.likely-real",
  render: (f) =>
    f.classes["likely-real"] > 0
      ? `${f.classes["likely-real"]} likely-real credentials.`
      : undefined,
};

/** The builders the tests use: a secrets card only, as the contract requires. */
const BUILDERS: CardBuilders = {
  secrets: (result, context) => ({
    category: "secrets",
    tone: result.status,
    count: result.matches,
    found: sentences([LIKELY], result.facts),
    now: [],
    fixes: [{ shape: "agenttrail-guard scan --scrub" }],
    codexCaveat: context.ranEvidence === "output-record",
    headline: {
      count: result.facts.classes["likely-real"],
      restsOnCodexRan: false,
      sentence: sentence(LIKELY, result.facts) ?? { template: LIKELY.id, text: "" },
    },
  }),
};

describe("sentences come from templates", () => {
  it("names the template a line came from, and skips a template the facts do not support", () => {
    expect(
      sentence(LIKELY, { ...NO_FACTS, classes: { ...NO_FACTS.classes, "likely-real": 3 } }),
    ).toEqual({ template: "secrets.likely-real", text: "3 likely-real credentials." });
    expect(sentence(LIKELY, NO_FACTS)).toBeUndefined();
    expect(sentences([LIKELY, NOT_CHECKED_SENTENCE], NO_FACTS)).toEqual([
      { template: "not-checked", text: "Not checked yet." },
    ]);
  });
});

describe("cards", () => {
  it("a category with no check gets the not-checked card, never a clean one", () => {
    expect(notCheckedCard("egress")).toEqual({
      category: "egress",
      tone: "not-checked",
      count: 0,
      found: [{ template: NOT_CHECKED_SENTENCE.id, text: "Not checked yet." }],
      now: [],
      fixes: [],
      codexCaveat: false,
    });
  });

  it("a check that could not finish gets the could-not-check card", () => {
    const card = couldNotCheckCard("lost-work", 4);
    expect(card.tone).toBe("could-not-check");
    expect(card.count).toBe(4);
    expect(card.found.map((s) => s.template)).toEqual([COULD_NOT_CHECK_SENTENCE.id]);
  });

  it("builds all nine, in page order: act, review, clean, could-not-check, not-checked", () => {
    const cards = cardsFor(verification("act"), BUILDERS);
    expect(cards).toHaveLength(9);
    expect(cards[0]?.category).toBe("secrets");
    expect(cards[0]?.found.map((s) => s.text)).toEqual(["2 likely-real credentials."]);
    expect(cards.slice(1).map((c) => c.category)).toEqual(VERIFY_CATEGORIES.slice(1));
    expect(cards.slice(1).every((c) => c.tone === "not-checked")).toBe(true);
  });

  it("a checked category whose check could not finish gets the default card, not its builder's", () => {
    const [secrets] = cardsFor(verification("could-not-check"), BUILDERS).filter(
      (c) => c.category === "secrets",
    );
    expect(secrets?.tone).toBe("could-not-check");
  });

  it("a result with facts and no builder is shown as could-not-check, never as clean", () => {
    const cards = cardsFor(verification("clean"), {} as CardBuilders);
    expect(cards.find((c) => c.category === "secrets")?.tone).toBe("could-not-check");
  });

  it("passes the Codex evidence to the builder", () => {
    const codex = { ...verification(), ranEvidence: "output-record" as const };
    expect(cardsFor(codex, BUILDERS).find((c) => c.category === "secrets")?.codexCaveat).toBe(true);
  });

  it("orders by tone, then by category", () => {
    const card = (category: VerifyCategory, tone: VerifyStatus): CardView => ({
      ...notCheckedCard(category),
      tone,
    });
    const ordered = orderCards([
      card("egress", "clean"),
      card("tests", "not-checked"),
      card("cloud", "review"),
      card("destructive", "act"),
      card("secrets", "clean"),
      card("lost-work", "could-not-check"),
    ]);
    expect(ordered.map((c) => `${c.tone}:${c.category}`)).toEqual([
      "act:destructive",
      "review:cloud",
      "clean:secrets",
      "clean:egress",
      "could-not-check:lost-work",
      "not-checked:tests",
    ]);
    expect(TONE_ORDER).toEqual(["act", "review", "clean", "could-not-check", "not-checked"]);
  });
});

/** A card that claims `count` for the headline. */
function claim(
  category: VerifyCategory,
  tone: VerifyStatus = "act",
  count = 1,
  restsOnCodexRan = false,
): CardView {
  return {
    ...notCheckedCard(category),
    tone,
    count,
    headline: { count, restsOnCodexRan, sentence: { template: `${category}.headline`, text: "x" } },
  };
}

describe("the headline", () => {
  it("is in the fixed priority order", () => {
    expect(HEADLINE_ORDER).toEqual([
      "secrets",
      "skipped-checks",
      "lost-work",
      "cloud",
      "tests",
      "destructive",
    ]);
  });

  it.each(HEADLINE_ORDER)("%s wins on its own", (category) => {
    const tone = category === "cloud" ? "review" : "act";
    expect(pickHeadline([claim(category, tone)])?.category).toBe(category);
  });

  it.each(
    HEADLINE_ORDER.flatMap((lower, i) =>
      HEADLINE_ORDER.slice(0, i).map((higher) => [higher, lower] as const),
    ),
  )("%s beats %s", (higher, lower) => {
    const tone = (c: VerifyCategory) => (c === "cloud" ? "review" : "act");
    expect(pickHeadline([claim(lower, tone(lower)), claim(higher, tone(higher))])?.category).toBe(
      higher,
    );
  });

  it.each(
    HEADLINE_ORDER,
  )("a clean, not-checked or could-not-check %s is never the headline", (category) => {
    for (const tone of ["clean", "not-checked", "could-not-check"] as const) {
      expect(pickHeadline([claim(category, tone)])).toBeUndefined();
    }
  });

  it("only a cloud change may lead from review, since that is the only tone it has", () => {
    expect(pickHeadline([claim("secrets", "review")])).toBeUndefined();
    expect(pickHeadline([claim("cloud", "review")])?.category).toBe("cloud");
  });

  it.each(
    HEADLINE_ORDER,
  )("a %s claim that rests on Codex ran counts is never the headline", (category) => {
    const tone = category === "cloud" ? "review" : "act";
    expect(pickHeadline([claim(category, tone, 5, true)])).toBeUndefined();
  });

  it("a Codex-only claim gives way to a lower one that does not rest on Codex", () => {
    expect(
      pickHeadline([claim("skipped-checks", "act", 9, true), claim("destructive", "act", 1)])
        ?.category,
    ).toBe("destructive");
  });

  it("a zero count, a card with no claim, and the other three categories never lead", () => {
    expect(pickHeadline([claim("secrets", "act", 0)])).toBeUndefined();
    expect(pickHeadline([{ ...notCheckedCard("secrets"), tone: "act" }])).toBeUndefined();
    for (const category of ["prod-infra", "unreviewed", "egress"] as const) {
      expect(pickHeadline([claim(category)])).toBeUndefined();
    }
    expect(pickHeadline([])).toBeUndefined();
  });
});

describe("exact fix commands stay in the local channel", () => {
  const CANARY = "git branch recovered/LOCALFIXCANARY 0123abc";

  it("a local fix refuses to become JSON", () => {
    const fix = localFix("lost-work", CANARY);
    expect(isLocalFix(fix)).toBe(true);
    expect(isLocalFix({ category: "lost-work", command: CANARY })).toBe(false);
    expect(Object.isFrozen(fix)).toBe(true);
    expect(() => JSON.stringify(fix)).toThrow(LOCAL_FIX_SERIALIZED);
    expect(() => JSON.stringify({ nested: [fix] })).toThrow(LOCAL_FIX_SERIALIZED);
  });

  it("the payload, the page and --json cannot carry one, even placed in a category's facts by mistake", () => {
    const leaked = {
      ...verification(),
      categories: {
        ...verification().categories,
        "lost-work": {
          status: "act",
          matches: 1,
          facts: { fixes: [localFix("lost-work", CANARY)] },
        },
      },
    } as unknown as Verification;
    const result = aggregateScan(
      { sessions: [], quarantined: 0, notRead: 0, projects: 0 },
      compileCatalog([RULE_RM_RF]),
      compileAllowlist([]),
      new Set(),
      leaked,
    );
    const meta = { version: "0.0.0", generatedAt: new Date(0) };
    expect(() => reportPayload(result, meta)).toThrow(LOCAL_FIX_SERIALIZED);
    expect(() => renderReport(result, meta)).toThrow(LOCAL_FIX_SERIALIZED);
    expect(() => renderJson(result, meta)).toThrow(LOCAL_FIX_SERIALIZED);
  });

  it("Verification has no field for them", () => {
    const v: Verification = {
      ...verification(),
      // @ts-expect-error — local fixes travel beside the verification, never inside it.
      localFixes: [],
    };
    expect(v).toBeDefined();
  });
});

describe("a checked category's facts reach the file as plain data", () => {
  const meta = { version: "0.0.0", generatedAt: new Date(0) };

  it("counts and enums are copied, lists capped at the row cap, and anything else dropped", () => {
    class NotPlain {
      readonly x = 1;
    }
    const facts = {
      count: 3,
      flag: true,
      kind: "act",
      rows: Array.from({ length: MAX_ROWS + 5 }, (_, i) => ({ n: i })),
      fn: () => 1,
      map: new Map([["a", 1]]),
      instance: new NotPlain(),
      nothing: null,
      deep: { a: { b: { c: { d: { e: { f: 1 } } } } } },
    };
    const v = {
      ...verification(),
      categories: { ...verification().categories, tests: { status: "act", matches: 3, facts } },
    } as unknown as Verification;
    const result = aggregateScan(
      { sessions: [], quarantined: 0, notRead: 0, projects: 0 },
      compileCatalog([RULE_RM_RF]),
      compileAllowlist([]),
      new Set(),
      v,
    );
    const tests = reportPayload(result, meta).verification?.categories.tests as unknown as {
      status: string;
      matches: number;
      facts: Record<string, unknown>;
    };
    expect(tests.status).toBe("act");
    expect(tests.matches).toBe(3);
    expect(tests.facts.count).toBe(3);
    expect(tests.facts.flag).toBe(true);
    expect(tests.facts.kind).toBe("act");
    expect(tests.facts.rows).toHaveLength(MAX_ROWS);
    expect(Object.keys(tests.facts).sort()).toEqual(["count", "deep", "flag", "kind", "rows"]);
    expect(JSON.stringify(tests.facts.deep)).toBe('{"a":{"b":{"c":{"d":{}}}}}');
  });

  it("a category with no check stays status only", () => {
    const payload = reportPayload(
      aggregateScan(
        { sessions: [], quarantined: 0, notRead: 0, projects: 0 },
        compileCatalog([RULE_RM_RF]),
        compileAllowlist([]),
        new Set(),
        verification(),
      ),
      meta,
    );
    expect(payload.verification?.categories.egress).toEqual({ status: "not-checked" });
  });
});

describe("verifying by default", () => {
  it("is off until the one switch is flipped", () => {
    expect(VERIFY_BY_DEFAULT).toBe(false);
  });
});
