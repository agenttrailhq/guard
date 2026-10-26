/**
 * The git-backed checks: skipped safety checks, lost work and destructive commands, run over one
 * reading of the corpus with one repository probe.
 *
 * Never throws. A check that fails on input it cannot read reports could-not-check, never clean,
 * and the others still run.
 */

import type { ScanCorpus } from "../scan-report.js";
import type { CardBuilders, LocalFix } from "./cards.js";
import {
  checkDestructive,
  DATABASE_CLASSES,
  type DestructiveCheck,
  destructiveCard,
  RM_TARGET_CLASSES,
} from "./destructive.js";
import { type GitCheckContext, TEMP_ROOTS } from "./git-copy.js";
import { checkLostWork, type LostWorkCheck, lostWorkCard } from "./lost-work.js";
import { RepoProbe } from "./repo-probe.js";
import { readCalls } from "./shell-calls.js";
import { checkSkippedChecks, type SkippedChecksCheck, skippedChecksCard } from "./skipped.js";
import type { RunTally, VerifyIO } from "./types.js";

/** What the git-backed checks need. */
export interface GitChecksInput {
  readonly corpus: ScanCorpus;
  readonly io: VerifyIO;
  /** The home folder, for `~` and for "under the home folder". */
  readonly home: string;
  /** Folders whose contents are scratch. `TEMP_ROOTS` unless a test sets its own. */
  readonly scratchRoots?: readonly string[];
}

/** The three results, and the exact local fix commands they made. */
export interface GitChecksOutcome {
  readonly "skipped-checks": SkippedChecksCheck;
  readonly "lost-work": LostWorkCheck;
  readonly destructive: DestructiveCheck;
  /** For the local fixes file only. Never part of the verification. */
  readonly localFixes: readonly LocalFix[];
}

/** No calls. */
const NONE: RunTally = { ran: 0, mentioned: 0, unknown: 0 };

/** A check that threw: could-not-check, with every count zero. */
const FAILED_SKIPPED: SkippedChecksCheck = {
  status: "could-not-check",
  matches: 0,
  facts: {
    noVerify: {
      calls: NONE,
      commits: 0,
      notIdentified: 0,
      withoutHooks: 0,
      onMain: 0,
      offMain: 0,
      noMainToCheck: 0,
      gone: 0,
      couldNotCheck: 0,
    },
    otherNoVerify: NONE,
    husky: NONE,
    hooksPath: { calls: NONE, off: 0, on: 0, none: 0, couldNotCheck: 0 },
    instructions: {
      read: 0,
      sayToSkip: 0,
      agentWrote: 0,
      agentWroteStill: 0,
      agentWroteRemoved: 0,
      couldNotRead: 0,
    },
  },
};

/** A check that threw: could-not-check, with every count zero. */
const FAILED_LOST_WORK: LostWorkCheck = {
  status: "could-not-check",
  matches: 0,
  facts: {
    branches: {
      calls: NONE,
      deleted: 0,
      notIdentified: 0,
      recoverable: 0,
      onAnotherRef: 0,
      gone: 0,
      couldNotCheck: 0,
    },
    stashes: {
      calls: NONE,
      dropped: 0,
      cleared: 0,
      notIdentified: 0,
      recoverable: 0,
      listed: 0,
      gone: 0,
      couldNotCheck: 0,
    },
    discards: {
      calls: NONE,
      paths: 0,
      ownCopy: 0,
      agentEdited: 0,
      mainCheckout: 0,
      couldNotCheck: 0,
    },
  },
};

/** A check that threw: could-not-check, with every count zero. */
const FAILED_DESTRUCTIVE: DestructiveCheck = {
  status: "could-not-check",
  matches: 0,
  facts: {
    rm: {
      calls: NONE,
      targets: 0,
      classes: Object.fromEntries(
        RM_TARGET_CLASSES.map((c) => [c, 0]),
      ) as DestructiveCheck["facts"]["rm"]["classes"],
      trackedBack: 0,
      trackedGone: 0,
      trackedPartlyBack: 0,
      couldNotCheck: 0,
    },
    databases: {
      calls: NONE,
      classes: Object.fromEntries(
        DATABASE_CLASSES.map((c) => [c, 0]),
      ) as DestructiveCheck["facts"]["databases"]["classes"],
    },
  },
};

/** Run a check, or give its could-not-check result if it throws. */
async function guarded<R>(
  run: () => Promise<{ readonly result: R; readonly localFixes: readonly LocalFix[] }>,
  failed: R,
): Promise<{ readonly result: R; readonly localFixes: readonly LocalFix[] }> {
  try {
    return await run();
  } catch {
    return { result: failed, localFixes: [] };
  }
}

/** Run the three git-backed checks. See the module header. */
export async function checkGitBacked(input: GitChecksInput): Promise<GitChecksOutcome> {
  let context: GitCheckContext;
  try {
    context = {
      log: readCalls(input.corpus, input.home),
      probe: new RepoProbe(input.io),
      scratchRoots: input.scratchRoots ?? TEMP_ROOTS,
    };
  } catch {
    return {
      "skipped-checks": FAILED_SKIPPED,
      "lost-work": FAILED_LOST_WORK,
      destructive: FAILED_DESTRUCTIVE,
      localFixes: [],
    };
  }
  const skipped = await guarded(() => checkSkippedChecks(context), FAILED_SKIPPED);
  const lost = await guarded(() => checkLostWork(context), FAILED_LOST_WORK);
  const destructive = await guarded(() => checkDestructive(context), FAILED_DESTRUCTIVE);
  return {
    "skipped-checks": skipped.result,
    "lost-work": lost.result,
    destructive: destructive.result,
    localFixes: [...skipped.localFixes, ...lost.localFixes, ...destructive.localFixes],
  };
}

/** The card builders for the git-backed categories, for the page's registry. */
export const GIT_CARD_BUILDERS: Pick<CardBuilders, "skipped-checks" | "lost-work" | "destructive"> =
  {
    "skipped-checks": skippedChecksCard,
    "lost-work": lostWorkCard,
    destructive: destructiveCard,
  };
