/**
 * Synthetic facts for the verified notes, made up and test-only.
 *
 * Each check's facts here satisfy that check's own facts type: `SkippedChecksFacts`,
 * `LostWorkFacts` and `DestructiveFacts` (the git-backed checks), and `TestsFacts`, `CloudFacts`,
 * `ProdInfraFacts`, `UnreviewedFacts`, `EgressFacts` and `DependencyFacts` (the command checks).
 * A field a check adds, renames or drops fails to compile here, so the notes are tested against
 * the shape the checks produce.
 *
 * The scan the page corpus renders matches guardrails by their shipped ids, through synthetic
 * rules written here: the notes table is keyed by shipped id.
 */

import { compileAllowlist } from "../core/evaluate.js";
import { compileCatalog } from "../core/rules.js";
import { aggregateScan, type ScanResult } from "../core/scan-report.js";
import type { GuardRule } from "../core/types.js";
import type { CardBuilders, CardView } from "../core/verify/cards.js";
import type { CloudFacts } from "../core/verify/cloud.js";
import type { DependencyFacts } from "../core/verify/deps.js";
import type { DestructiveFacts } from "../core/verify/destructive.js";
import type { EgressFacts } from "../core/verify/egress.js";
import type { LostWorkFacts } from "../core/verify/lost-work.js";
import type { ProdInfraFacts } from "../core/verify/prod-infra.js";
import type { SkippedChecksFacts } from "../core/verify/skipped.js";
import type { TestsFacts } from "../core/verify/tests.js";
import {
  type RunTally,
  VERIFY_CATEGORIES,
  type Verification,
  type VerifyCategory,
  type VerifyStatus,
} from "../core/verify/types.js";
import type { UnreviewedFacts } from "../core/verify/unreviewed.js";
import { bash, session, turn } from "./scan-fixtures.js";
import { SECRETS_ACT } from "./verified-corpus.js";

/** A tally of calls by whether they ran. */
export function tally(ran: number, mentioned = 0, unknown = 0): RunTally {
  return { ran, mentioned, unknown };
}

/** Skipped safety checks: hooks skipped on four commits, three of them on main now. */
export const SKIPPED_FACTS = {
  noVerify: {
    calls: tally(4),
    commits: 4,
    notIdentified: 0,
    failed: 0,
    withoutHooks: 0,
    onMain: 3,
    offMain: 1,
    noMainToCheck: 0,
    gone: 0,
    couldNotCheck: 0,
  },
  otherNoVerify: tally(0),
  husky: tally(1),
  oneCommand: tally(0),
  hooksPath: { calls: tally(1), off: 0, on: 1, none: 0, couldNotCheck: 0 },
  instructions: {
    read: 2,
    sayToSkip: 1,
    agentWrote: 0,
    agentWroteStill: 0,
    agentWroteRemoved: 0,
    couldNotRead: 0,
  },
  unsafeFixes: 0,
  hidingCalls: 0,
  hidingForms: [],
} satisfies SkippedChecksFacts;

/** Lost work: two branches and a stash recoverable, four discards in the agent's own copy. */
export const LOST_WORK_FACTS = {
  branches: {
    calls: tally(2),
    deleted: 2,
    notIdentified: 0,
    failed: 0,
    recoverable: 2,
    onAnotherRef: 0,
    gone: 0,
    couldNotCheck: 0,
  },
  stashes: {
    calls: tally(1),
    dropped: 1,
    cleared: 0,
    notIdentified: 0,
    failed: 0,
    recoverable: 1,
    listed: 0,
    gone: 0,
    couldNotCheck: 0,
  },
  discards: {
    calls: tally(3),
    paths: 4,
    ownCopy: 4,
    agentEdited: 0,
    mainCheckout: 0,
    couldNotCheck: 0,
  },
  unsafeFixes: 0,
  hidingCalls: 0,
  hidingForms: [],
} satisfies LostWorkFacts;

/** Destructive commands: seven recursive deletes, mostly build output, nothing tracked lost. */
export const DESTRUCTIVE_FACTS = {
  rm: {
    calls: tally(7),
    targets: 7,
    classes: {
      "home-or-above": 0,
      "unguarded-variable": 0,
      "guarded-variable": 0,
      scratch: 5,
      tracked: 1,
      untracked: 1,
      home: 0,
      other: 0,
    },
    trackedBack: 1,
    trackedGone: 0,
    trackedPartlyBack: 0,
    couldNotCheck: 0,
  },
  databases: {
    calls: tally(2),
    classes: { local: 2, scratch: 0, other: 0, unresolved: 0 },
  },
  unsafeFixes: 0,
  hidingCalls: 0,
  hidingForms: [],
} satisfies DestructiveFacts;

/** Cloud and permissions: two IAM changes and one Terraform apply that ran. */
export const CLOUD_FACTS = {
  iamChanges: 2,
  iamSubjects: ["access-keys", "policies"],
  autoScalingChanges: 0,
  s3Changes: 1,
  terraformChanges: 1,
  terraformAutoApprove: 1,
  localStack: 0,
  mentioned: 0,
  unconfirmed: 0,
  couldHide: 0,
  hidingForms: [],
} satisfies CloudFacts;

/** Production infrastructure: one Kubernetes change, databases all local. */
export const PROD_INFRA_FACTS = {
  databaseTargets: { local: 2, scratch: 0, other: 0 },
  databaseCheck: "checked",
  infraMatches: 1,
  infraKinds: ["kubernetes"],
  localInfra: 0,
  mentioned: 0,
  unconfirmed: 0,
  couldHide: 0,
  hidingForms: [],
} satisfies ProdInfraFacts;

/** Gaming tests: a test deleted after it failed; two threshold drops that undid a raise. */
export const TESTS_FACTS = {
  thresholdsLowered: 0,
  autoUpdateReverts: 2,
  autoUpdateNow: { on: 1, off: 0, unread: 0 },
  configsRewritten: 0,
  excludesAdded: 0,
  passWithNoTests: 1,
  ciStepsForcedTrue: 0,
  testFilesDeleted: 1,
  deletedAfterFailing: 1,
  deletedFailureUnknown: 0,
  unreadEdits: 0,
  mentioned: 0,
  unconfirmed: 0,
  couldHide: 0,
  hidingForms: [],
} satisfies TestsFacts;

/** Unreviewed code: one push straight to main with two commits still on it. */
export const UNREVIEWED_FACTS = {
  pushesToMain: 1,
  commitsOnMain: 2,
  commitsNotOnMain: 0,
  pushesNotChecked: 0,
  pushesCreatingMain: 0,
  mentioned: 0,
  unconfirmed: 0,
  couldHide: 0,
  hidingForms: [],
} satisfies UnreviewedFacts;

/** Data leaving the machine: nothing left it; three calls went to this machine. */
export const EGRESS_FACTS = {
  uploads: 0,
  uploadKinds: [],
  tunnelsStarted: 0,
  localOnly: 3,
  tunnelsRunning: 0,
  tunnelPrograms: [],
  processCheck: "checked",
  mentioned: 0,
  unconfirmed: 0,
  couldHide: 0,
  hidingForms: [],
} satisfies EgressFacts;

/** Dependencies: two installs, three lockfile restores left out. */
export const DEPENDENCY_FACTS = {
  installs: 2,
  lockfileRestores: 3,
  managers: ["npm"],
  packageAge: "not-checked-offline",
  mentioned: 0,
  unconfirmed: 0,
  couldHide: 0,
  hidingForms: [],
} satisfies DependencyFacts;

/** Every category's facts, by category. */
export const FACTS: Readonly<Record<VerifyCategory, object>> = {
  secrets: SECRETS_ACT,
  "skipped-checks": SKIPPED_FACTS,
  "lost-work": LOST_WORK_FACTS,
  cloud: CLOUD_FACTS,
  "prod-infra": PROD_INFRA_FACTS,
  tests: TESTS_FACTS,
  destructive: DESTRUCTIVE_FACTS,
  unreviewed: UNREVIEWED_FACTS,
  egress: EGRESS_FACTS,
};

/** The tone each category has in the full corpus. */
const TONES: Readonly<Record<VerifyCategory, VerifyStatus>> = {
  secrets: "act",
  "skipped-checks": "act",
  "lost-work": "act",
  cloud: "review",
  "prod-infra": "review",
  tests: "act",
  destructive: "clean",
  unreviewed: "act",
  egress: "clean",
};

/** One checked category: its tone, a match count and its facts. */
export function checked(status: VerifyStatus, facts: object, matches = 3) {
  return { status, matches, facts };
}

/**
 * A verification over the full corpus, every category checked, with `overrides` replacing
 * categories and `dependencies` the dependency facts (absent when `null`).
 */
export function notesVerification(
  overrides: Partial<Record<VerifyCategory, unknown>> = {},
  calls: Partial<Pick<Verification, "resultsRecorded" | "ranEvidence">> = {},
  dependencies: object | null = DEPENDENCY_FACTS,
): Verification {
  const categories = Object.fromEntries(
    VERIFY_CATEGORIES.map((category) => [
      category,
      category in overrides ? overrides[category] : checked(TONES[category], FACTS[category]),
    ]),
  );
  return {
    matchedCalls: { ran: 21, mentioned: 2, unknown: 0 },
    resultsRecorded: calls.resultsRecorded ?? true,
    ranEvidence: calls.ranEvidence ?? "tool-result",
    categories: categories as unknown as Verification["categories"],
    ...(dependencies === null ? {} : { dependencies }),
  } as Verification;
}

/** A card that states only its tone and count: what the notes read off a card. */
function toneCard(category: VerifyCategory) {
  return (result: { readonly status: VerifyStatus; readonly matches: number }): CardView => ({
    category,
    tone: result.status,
    count: result.matches,
    found: [],
    now: [],
    fixes: [],
    codexCaveat: false,
  });
}

/** A tone-only card builder for every category, so every category has a card. */
export const TONE_BUILDERS = Object.fromEntries(
  VERIFY_CATEGORIES.map((category) => [category, toneCard(category)]),
) as unknown as CardBuilders;

/** A library finding with `ruleId`. */
export function library(ruleId: string): { ruleId: string; source: "library" } {
  return { ruleId, source: "library" };
}

// ── The page corpus ───────────────────────────────────────────────────────────

/** A synthetic rule with a shipped guardrail's id, matching one fixed command text. */
function rule(
  id: string,
  category: string,
  title: string,
  contains: string,
  action: GuardRule["defaultAction"] = "require_approval",
): GuardRule {
  return {
    id,
    category,
    severity: "high",
    defaultAction: action,
    title,
    description: "A synthetic rule with a shipped id, for the notes corpus.",
    match: { any_of: [{ kind: "execute_tool", label: "Bash", detail_contains: [contains] }] },
  };
}

/** The library rules the page corpus matches: mapped ones, and one the table leaves out. */
export const NOTES_LIBRARY: readonly GuardRule[] = [
  rule("se.env-print", "secret-exposure", "Printing the environment", "printenv", "warn"),
  rule("dd.rm-rf-absolute", "destructive-data", "Deleting an absolute path", "rm -rf /", "block"),
  rule("wt.stash-drop", "working-tree", "Dropping a stash", "git stash drop"),
  rule("ti.test-file-delete", "test-integrity", "Deleting a test file", "rm tests/"),
  rule("ex.file-upload", "exfiltration", "Uploading a file", "curl -T "),
  rule("flag-dependency-install", "privilege-supply-chain", "A new dependency", "npm install "),
  rule("ps.persistence", "privilege-supply-chain", "Running again later", "crontab "),
];

/** A guardrail the user wrote that reuses a shipped id: it gets no note. */
export const OWN_RULE_WITH_SHIPPED_ID: GuardRule = rule(
  "wt.reset-hard",
  "team",
  "Ask before a hard reset",
  "git reset --hard",
);

/** The scan behind the page corpus: one call for each rule above. */
export function notesResult(verification: Verification | undefined): ScanResult {
  return aggregateScan(
    {
      sessions: [
        session([
          turn([
            bash("printenv", "1"),
            bash("rm -rf /Users/sample/app/dist", "2"),
            bash("git stash drop", "3"),
            bash("rm tests/old.test.ts", "4"),
            bash("curl -T report.txt http://localhost:9000/upload", "5"),
            bash("npm install left-pad", "6"),
            bash("crontab -l", "7"),
            bash("git reset --hard", "8"),
          ]),
        ]),
      ],
      quarantined: 0,
      notRead: 0,
      projects: 1,
    },
    compileCatalog([...NOTES_LIBRARY, OWN_RULE_WITH_SHIPPED_ID]),
    compileAllowlist([]),
    new Set(NOTES_LIBRARY),
    verification,
  );
}

/**
 * The page corpus's verification: secrets to act on, lost work that could not be checked, a
 * test check that could not confirm, and the rest from the full corpus.
 */
export function pageVerification(): Verification {
  return notesVerification({
    "lost-work": { status: "could-not-check", matches: 1 },
    tests: checked("act", { ...TESTS_FACTS, couldHide: 1, hidingForms: ["xargs"] }),
    unreviewed: { status: "not-checked" },
  });
}
