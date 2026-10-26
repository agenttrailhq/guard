// cspell:words hooksPath
/**
 * A synthetic verified corpus for the page: one scan, with a verification covering all nine
 * categories in a realistic mix of tones. Made up, and test-only.
 *
 * The secrets card is the real one (`CARD_BUILDERS`). The other eight categories have no check
 * in this build yet, so their facts and cards here come from TEST-ONLY builders: every template
 * id they use starts with `test-only.`, and none of their wording ships. They exist so the page's
 * frame, ordering, chips, tones and fix commands can be rendered and pinned before those checks
 * land, and they are replaced by the real builders when they do.
 */

import { compileAllowlist } from "../core/evaluate.js";
import type { ReportMeta } from "../core/report.js";
import { compileCatalog } from "../core/rules.js";
import { aggregateScan, type ScanResult } from "../core/scan-report.js";
import { formatCount } from "../core/tokens.js";
import type { GuardRule } from "../core/types.js";
import { CARD_BUILDERS } from "../core/verify/builders.js";
import {
  type CardBuilders,
  type CardSentence,
  type CardView,
  type FixShape,
  HEADLINE_BASIS,
  type HeadlineBasis,
  type SentenceTemplate,
  sentence,
  sentences,
} from "../core/verify/cards.js";
import { countOf } from "../core/verify/copy.js";
import type {
  CheckedCategory,
  SecretsFacts,
  Verification,
  VerifyCategory,
  VerifyStatus,
} from "../core/verify/types.js";
import {
  bash,
  RULE_ENV_FILE,
  RULE_GIT_CHECKOUT,
  RULE_RM_RF,
  session,
  TEST_CATALOG,
  toolUse,
  turn,
} from "./scan-fixtures.js";

export const VERIFIED_META: ReportMeta = {
  version: "9.9.9",
  generatedAt: new Date("2026-10-01T09:00:00.000Z"),
};

/** The fixture's library rules with OWASP ids, as shipped guardrails carry them. */
const RM_RF: GuardRule = { ...RULE_RM_RF, owasp: ["ASI02", "LLM03"] };
const ENV_FILE: GuardRule = { ...RULE_ENV_FILE, owasp: ["LLM02"] };
const GIT_CHECKOUT: GuardRule = { ...RULE_GIT_CHECKOUT, owasp: ["ASI02"] };
const LIBRARY = TEST_CATALOG.map((rule) =>
  rule === RULE_RM_RF
    ? RM_RF
    : rule === RULE_ENV_FILE
      ? ENV_FILE
      : rule === RULE_GIT_CHECKOUT
        ? GIT_CHECKOUT
        : rule,
);

/** The scan the verification is attached to: a few matches of each action. */
export function baseResult(verification: Verification | undefined): ScanResult {
  return aggregateScan(
    {
      sessions: [
        session([
          turn(
            [
              bash("rm -rf /Users/sample/app/build", "1"),
              bash("rm -rf /Users/sample/app/dist", "2"),
              toolUse("Read", { file_path: "/srv/app/.env" }, "3"),
              toolUse("Read", { file_path: "/srv/app/.env.local" }, "4"),
              bash("git checkout -- src/a.ts", "5"),
              bash("npm test", "6"),
              bash("ls -la", "7"),
            ],
            { input_tokens: 900, output_tokens: 210 },
          ),
        ]),
      ],
      quarantined: 0,
      notRead: 0,
      projects: 2,
    },
    compileCatalog(LIBRARY),
    compileAllowlist([]),
    new Set([RM_RF, ENV_FILE, GIT_CHECKOUT]),
    verification,
  );
}

// ── The real secrets check's facts, made up ───────────────────────────────────

export const SECRETS_ACT: SecretsFacts = {
  classes: { "likely-real": 3, "committed-fixture": 1, placeholder: 5, "local-dev": 2 },
  items: [
    { kind: "github-token", via: ["pasted-into-prompt"], files: 4 },
    { kind: "aws-access-key", via: ["printed-by-command"], files: 2 },
    { kind: "named-secret", via: ["typed-into-command", "in-agent-reply"], files: 1 },
  ],
  moreItems: 0,
  filesRead: 18,
  filesNotRead: 0,
  unplaced: 0,
  setAside: { unnamedOutputOnly: 0, namedNotCredentialShaped: 0 },
  fixtureCheck: "complete",
  reposChecked: 2,
  reposNotChecked: 0,
};

export const SECRETS_CLEAN: SecretsFacts = {
  ...SECRETS_ACT,
  classes: { "likely-real": 0, "committed-fixture": 0, placeholder: 2, "local-dev": 1 },
  items: [],
  fixtureCheck: "not-needed",
};

// ── TEST-ONLY builders for the categories with no check yet ──────────────────

/** Counts only: the shape every test-only fact set takes. */
type Counts = Readonly<Record<string, number>>;

/** A test-only template. Its id says so. */
function t(id: string, render: (f: Counts) => string | undefined): SentenceTemplate<Counts> {
  return { id: `test-only.${id}`, render };
}

interface TestCard {
  readonly found: readonly SentenceTemplate<Counts>[];
  readonly now?: readonly SentenceTemplate<Counts>[];
  readonly fixSteps?: readonly SentenceTemplate<Counts>[];
  readonly fixes?: readonly FixShape[];
  readonly headline?: { readonly count: string; readonly template: SentenceTemplate<Counts> };
  readonly chip?: { readonly count: string; readonly template: SentenceTemplate<Counts> };
}

/** The basis a category's claim must have; any basis for a category that never leads. */
export function basisOf(category: VerifyCategory): HeadlineBasis {
  return (HEADLINE_BASIS as Readonly<Record<string, HeadlineBasis>>)[category] ?? "iam-changes";
}

/** A test-only card builder from templates over counts. */
function testBuilder(category: VerifyCategory, spec: TestCard) {
  return (result: CheckedCategory<Counts>): CardView => {
    const f = result.facts;
    const claim = (
      part: { readonly count: string; readonly template: SentenceTemplate<Counts> } | undefined,
    ): { count: number; line: CardSentence } | undefined => {
      if (part === undefined) return undefined;
      const line = sentence(part.template, f);
      return line === undefined ? undefined : { count: f[part.count] ?? 0, line };
    };
    const headline = claim(spec.headline);
    const chip = claim(spec.chip);
    return {
      category,
      tone: result.status,
      count: result.matches,
      found: sentences(spec.found, f),
      now: sentences(spec.now ?? [], f),
      fixSteps: sentences(spec.fixSteps ?? [], f),
      fixes: f.fixable === 0 ? [] : (spec.fixes ?? []),
      codexCaveat: f.codex === 1,
      ...(headline === undefined
        ? {}
        : {
            headline: {
              basis: basisOf(category),
              count: headline.count,
              restsOnCodexRan: f.codex === 1,
              sentence: headline.line,
            },
          }),
      ...(chip === undefined ? {} : { chip: { count: chip.count, label: chip.line } }),
    };
  };
}

const n = (f: Counts, key: string): number => f[key] ?? 0;

const TEST_ONLY_CARDS: Readonly<Record<Exclude<VerifyCategory, "secrets">, TestCard>> = {
  "skipped-checks": {
    found: [
      t("skipped.no-verify", (f) =>
        n(f, "commits") > 0
          ? `${countOf(n(f, "commits"), "commit")} skipped the repo's hooks, and ${formatCount(n(f, "reachedMain"))} of them reached main.`
          : undefined,
      ),
      t("skipped.one-off", (f) =>
        n(f, "oneOff") > 0
          ? `${countOf(n(f, "oneOff"), "command")} turned hooks off for that command only.`
          : undefined,
      ),
      t("skipped.memory", (f) =>
        n(f, "memoryFiles") > 0
          ? `${countOf(n(f, "memoryFiles"), "agent memory file")} tells the agent to skip hooks.`
          : undefined,
      ),
    ],
    now: [
      t("skipped.hooks-on", (f) =>
        n(f, "hooksOffNow") === 0 ? "Hooks are on in every repo checked today." : undefined,
      ),
      t("skipped.memory-present", (f) =>
        n(f, "memoryPresent") > 0 ? "The memory file is still there." : undefined,
      ),
    ],
    fixSteps: [
      t("skipped.fix", (f) =>
        n(f, "memoryPresent") > 0
          ? "Remove the line in the memory file that tells the agent to skip hooks, then review the commits that reached main."
          : undefined,
      ),
    ],
    fixes: [{ shape: "git show --stat <sha>" }],
    headline: {
      count: "reachedMain",
      template: t("skipped.headline", (f) =>
        n(f, "reachedMain") > 0
          ? `${countOf(n(f, "reachedMain"), "commit")} reached main without ${n(f, "reachedMain") === 1 ? "its" : "their"} checks`
          : undefined,
      ),
    },
    chip: {
      count: "reachedMain",
      template: t("skipped.chip", (f) =>
        n(f, "reachedMain") === 1
          ? "commit reached main without its checks"
          : "commits reached main without their checks",
      ),
    },
  },
  "lost-work": {
    found: [
      t("lost.branches", (f) =>
        n(f, "branches") > 0
          ? `${countOf(n(f, "branches"), "force-deleted branch", "force-deleted branches")} still ${n(f, "branches") === 1 ? "has its commit" : "have their commits"} in the object store, on no other branch.`
          : undefined,
      ),
      t("lost.stashes", (f) =>
        n(f, "stashes") > 0
          ? `${countOf(n(f, "stashes"), "dropped stash", "dropped stashes")} still ${n(f, "stashes") === 1 ? "exists" : "exist"}.`
          : undefined,
      ),
      t("lost.scratch", (f) =>
        n(f, "scratch") > 0
          ? `${countOf(n(f, "scratch"), "discarded path")} ${n(f, "scratch") === 1 ? "was" : "were"} in the agent's own scratch copy.`
          : undefined,
      ),
    ],
    now: [
      t("lost.recoverable", (f) =>
        n(f, "branches") + n(f, "stashes") > 0
          ? `All ${formatCount(n(f, "branches") + n(f, "stashes"))} can be recovered by hash today.`
          : undefined,
      ),
    ],
    fixes: [
      { shape: "git branch recovered/<name> <sha>" },
      { shape: "git stash store -m recovered <sha>" },
    ],
    headline: {
      count: "recoverable",
      template: t("lost.headline", (f) =>
        n(f, "recoverable") > 0
          ? `${countOf(n(f, "recoverable"), "piece", "pieces")} of deleted work ${n(f, "recoverable") === 1 ? "is" : "are"} still recoverable`
          : undefined,
      ),
    },
    chip: {
      count: "recoverable",
      template: t("lost.chip", () => "deleted branches and stashes still recoverable"),
    },
  },
  cloud: {
    found: [
      t(
        "cloud.ran",
        (f) =>
          `${countOf(n(f, "iam"), "IAM change")}, ${countOf(n(f, "s3"), "S3 change")} and ${countOf(n(f, "terraform"), "Terraform run")} ran.`,
      ),
    ],
    now: [
      t(
        "cloud.review",
        () => "Cloud changes cannot be checked from this machine, so these need a review by hand.",
      ),
    ],
    fixes: [
      { shape: "aws iam list-access-keys --user-name <name>" },
      { shape: "aws iam list-attached-user-policies --user-name <name>" },
    ],
    headline: {
      count: "iam",
      template: t("cloud.headline", (f) =>
        n(f, "iam") > 0
          ? `${countOf(n(f, "iam"), "IAM change")} ran and ${n(f, "iam") === 1 ? "needs" : "need"} a review by hand`
          : undefined,
      ),
    },
    chip: {
      count: "iam",
      template: t("cloud.chip", (f) =>
        n(f, "iam") === 1 ? "IAM change ran, to review" : "IAM changes ran, to review",
      ),
    },
  },
  "prod-infra": {
    found: [
      t("prod.none", (f) =>
        n(f, "other") === 0
          ? "No database or infrastructure command that ran reached a target off this machine."
          : undefined,
      ),
      t("prod.local", (f) =>
        n(f, "local") > 0
          ? `${countOf(n(f, "local"), "command")} ran against local databases.`
          : undefined,
      ),
    ],
    chip: {
      count: "other",
      template: t("prod.chip", (f) =>
        n(f, "other") === 1 ? "production database touched" : "production databases touched",
      ),
    },
  },
  tests: { found: [] },
  destructive: {
    found: [
      t(
        "destructive.scratch",
        (f) =>
          `${countOf(n(f, "ran"), "recursive delete")} ran, all on scratch, temp or build output.`,
      ),
      t("destructive.tracked", (f) =>
        n(f, "trackedMissing") === 0 ? "No tracked file is missing." : undefined,
      ),
    ],
    chip: {
      count: "unguarded",
      template: t("destructive.chip", (f) =>
        n(f, "unguarded") === 1 ? "unguarded recursive delete" : "unguarded recursive deletes",
      ),
    },
  },
  unreviewed: { found: [] },
  egress: {
    found: [
      t("egress.false-positive", (f) =>
        n(f, "falsePositives") > 0
          ? `${countOf(n(f, "falsePositives"), "match", "matches")} ${n(f, "falsePositives") === 1 ? "was not an upload" : "were not uploads"}: health checks on localhost and text in tests.`
          : undefined,
      ),
    ],
    now: [
      t("egress.tunnels", (f) =>
        n(f, "tunnelsNow") === 0 ? "No tunnel or relay is running now." : undefined,
      ),
    ],
    chip: {
      count: "uploads",
      template: t("egress.chip", (f) =>
        n(f, "uploads") === 1 ? "file sent off this machine" : "files sent off this machine",
      ),
    },
  },
};

/** The real secrets builder, and a test-only builder for every other category. */
export const TEST_ONLY_BUILDERS = {
  ...CARD_BUILDERS,
  ...Object.fromEntries(
    Object.entries(TEST_ONLY_CARDS).map(([category, spec]) => [
      category,
      testBuilder(category as VerifyCategory, spec),
    ]),
  ),
} as unknown as CardBuilders;

/** One category's synthetic result. */
function checked(status: VerifyStatus, matches: number, facts: Counts) {
  return { status, matches, facts };
}

/** The main corpus: three to act on, one to review, three clean, one failed, one unchecked. */
export function verifiedCategories(): Verification["categories"] {
  return {
    secrets: { status: "act", matches: 11, facts: SECRETS_ACT },
    "skipped-checks": checked("act", 6, {
      commits: 4,
      reachedMain: 3,
      oneOff: 1,
      memoryFiles: 1,
      memoryPresent: 1,
      hooksOffNow: 0,
    }),
    "lost-work": checked("act", 3, { branches: 2, stashes: 1, scratch: 4, recoverable: 3 }),
    cloud: checked("review", 4, { iam: 2, s3: 1, terraform: 1 }),
    "prod-infra": checked("clean", 2, { other: 0, local: 2 }),
    tests: checked("could-not-check", 2, {}),
    destructive: checked("clean", 7, { ran: 7, trackedMissing: 0, unguarded: 0 }),
    unreviewed: { status: "not-checked" },
    egress: checked("clean", 3, { uploads: 0, falsePositives: 3, tunnelsNow: 0 }),
  } as unknown as Verification["categories"];
}

/** A verification over `categories`. */
export function verification(
  categories: Verification["categories"] = verifiedCategories(),
  calls: Partial<Pick<Verification, "resultsRecorded" | "ranEvidence">> = {},
): Verification {
  return {
    matchedCalls: { ran: 21, mentioned: 4, unknown: 1 },
    resultsRecorded: calls.resultsRecorded ?? true,
    ranEvidence: calls.ranEvidence ?? "tool-result",
    categories,
  };
}

/** The main corpus as a scan result. Secrets leads. */
export const VERIFIED_RESULT: ScanResult = baseResult(verification());

/** No credential that looks real, and nothing lost or skipped: the IAM changes lead, from review. */
export const CLOUD_LEAD_RESULT: ScanResult = baseResult(
  verification({
    ...verifiedCategories(),
    secrets: { status: "clean", matches: 3, facts: SECRETS_CLEAN },
    "skipped-checks": checked("clean", 1, { commits: 0, reachedMain: 0, hooksOffNow: 0 }),
    "lost-work": checked("clean", 0, { recoverable: 0 }),
  } as unknown as Verification["categories"]),
);

/** Verification ran and nothing may lead: the totals headline stays. */
export const FALLBACK_RESULT: ScanResult = baseResult(
  verification({
    ...verifiedCategories(),
    secrets: { status: "clean", matches: 3, facts: SECRETS_CLEAN },
    "skipped-checks": { status: "not-checked" },
    "lost-work": { status: "not-checked" },
    cloud: checked("review", 1, { iam: 0, s3: 1, terraform: 0 }),
  } as unknown as Verification["categories"]),
);

/**
 * A Codex scan whose skipped-checks claim rests on Codex `ran` records: it may not lead. The
 * scan is the main corpus's, labelled as Codex's, since only the verification differs here.
 */
export const CODEX_ONLY_RESULT: ScanResult = {
  ...baseResult(
    verification(
      {
        ...verifiedCategories(),
        secrets: { status: "clean", matches: 3, facts: SECRETS_CLEAN },
        "skipped-checks": checked("act", 6, {
          commits: 4,
          reachedMain: 3,
          memoryFiles: 0,
          memoryPresent: 0,
          hooksOffNow: 0,
          codex: 1,
        }),
        "lost-work": checked("clean", 0, { recoverable: 0 }),
        cloud: checked("review", 1, { iam: 0, s3: 1, terraform: 0 }),
      } as unknown as Verification["categories"],
      { ranEvidence: "output-record" },
    ),
  ),
  agent: "codex",
};

/** The categories the main corpus writes exact fix commands for. */
export const LOCAL_FIX_CATEGORIES: readonly VerifyCategory[] = ["skipped-checks", "lost-work"];
