/**
 * The git-backed checks: skipped safety checks, lost work and destructive commands, run over one
 * reading of the corpus with one repository probe.
 *
 * Never throws. A check that fails on input it cannot read reports could-not-check, never clean,
 * and the others still run.
 */

import type { ScanCorpus } from "../scan-report.js";
import type { CardBuilders, LocalFix, UnsafeFix } from "./cards.js";
import { checkDestructive, type DestructiveCheck, destructiveCard } from "./destructive.js";
import { type GitCheckContext, TEMP_ROOTS } from "./git-copy.js";
import { checkLostWork, type LostWorkCheck, lostWorkCard } from "./lost-work.js";
import { RepoProbe } from "./repo-probe.js";
import { readCalls } from "./shell-calls.js";
import { checkSkippedChecks, type SkippedChecksCheck, skippedChecksCard } from "./skipped.js";
import type { CouldNotCheckResult, VerifyIO } from "./types.js";

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
  readonly "skipped-checks": SkippedChecksCheck | CouldNotCheckResult;
  readonly "lost-work": LostWorkCheck | CouldNotCheckResult;
  readonly destructive: DestructiveCheck | CouldNotCheckResult;
  /** For the local fixes file only. Never part of the verification. */
  readonly localFixes: readonly LocalFix[];
  /**
   * Fixes that could not be made safe, each with its note ("could not make a safe command").
   * No command text. Each category's facts count its own.
   */
  readonly unsafeFixes: readonly UnsafeFix[];
}

/** A check that threw: could-not-check, with no facts. */
const FAILED: CouldNotCheckResult = { status: "could-not-check", matches: 0 };

/** What one check produced. */
interface Produced<R> {
  readonly result: R;
  readonly localFixes: readonly LocalFix[];
  readonly unsafeFixes: readonly UnsafeFix[];
}

/** Run a check, or give could-not-check if it throws. */
async function guarded<R>(
  run: () => Promise<Produced<R>>,
): Promise<Produced<R | CouldNotCheckResult>> {
  try {
    return await run();
  } catch {
    return { result: FAILED, localFixes: [], unsafeFixes: [] };
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
      "skipped-checks": FAILED,
      "lost-work": FAILED,
      destructive: FAILED,
      localFixes: [],
      unsafeFixes: [],
    };
  }
  const skipped = await guarded(() => checkSkippedChecks(context));
  const lost = await guarded(() => checkLostWork(context));
  const destructive = await guarded(() => checkDestructive(context));
  return {
    "skipped-checks": skipped.result,
    "lost-work": lost.result,
    destructive: destructive.result,
    localFixes: [...skipped.localFixes, ...lost.localFixes, ...destructive.localFixes],
    unsafeFixes: [...skipped.unsafeFixes, ...lost.unsafeFixes, ...destructive.unsafeFixes],
  };
}

/** The card builders for the git-backed categories, for the page's registry. */
export const GIT_CARD_BUILDERS: Pick<CardBuilders, "skipped-checks" | "lost-work" | "destructive"> =
  {
    "skipped-checks": skippedChecksCard,
    "lost-work": lostWorkCard,
    destructive: destructiveCard,
  };
