// cspell:words Fingerprinter
/**
 * `scan --verify`: check a scan's matches against this machine, read-only, and say what was
 * found as a `Verification`.
 *
 * Offline: nothing here reaches the network, and no value is checked with the service it
 * belongs to. Read-only: the only things it starts are the allow-listed `git` calls on
 * `VerifyIO`, and it writes nothing.
 *
 * It runs whether each matched call ran (`ran.ts`), the secrets check (`secrets.ts`), the
 * git-backed checks for skipped checks, lost work and destructive commands (`git-checks.ts`),
 * and the checks that read what commands and edits did (`calls.ts`): tests, cloud, production
 * infrastructure, unreviewed code, egress and dependencies. A category without a check reads
 * `not-checked`, which the report states as such and never as clean.
 */

import { homedir } from "node:os";
import type { CompiledAllowlist } from "../evaluate.js";
import type { CompiledRule } from "../rules.js";
import type { ScanCorpus } from "../scan-report.js";
import { readCalls } from "./calls.js";
import type { LocalFix, UnsafeFix } from "./cards.js";
import { checkCloud } from "./cloud.js";
import { checkDependencies } from "./deps.js";
import { databaseTargetClasses } from "./destructive.js";
import { checkEgress } from "./egress.js";
import { createFingerprinter, type Fingerprinter } from "./fingerprint.js";
import { checkGitBacked } from "./git-checks.js";
import { checkProdInfra, type DatabaseTargetCounts } from "./prod-infra.js";
import { tallyMatchedCalls } from "./ran.js";
import { checkSecrets, type SecretsCollector } from "./secrets.js";
import { checkTests } from "./tests.js";
import type { Verification, VerifyIO } from "./types.js";
import { checkUnreviewed } from "./unreviewed.js";

/** What verification needs. */
export interface VerifyInput {
  readonly corpus: ScanCorpus;
  readonly catalog: readonly CompiledRule[];
  readonly allowlist: CompiledAllowlist;
  /** Streams a transcript file's lines: the same reader `scan` uses. */
  readonly readLines: (path: string) => AsyncIterable<string>;
  readonly io: VerifyIO;
  /** For tests. Production gets a fresh random key for every run. */
  readonly fingerprint?: Fingerprinter;
  /** The home folder, for `~` in commands. Production uses the user's. */
  readonly home?: string;
  /**
   * What `scan` already collected for the secrets check while it read the transcripts. Files it
   * holds are not read again.
   */
  readonly secretsCollector?: SecretsCollector;
  /** For tests: folders whose contents are scratch. Production uses `TEMP_ROOTS`. */
  readonly scratchRoots?: readonly string[];
}

/**
 * Whether `scan` verifies without being asked. The one switch for verification by default:
 * while it is `true`, a plain `scan` runs the checks and `--no-checks` skips them; set to
 * `false`, `scan --verify` is how to ask for them. Both values are tested.
 */
export const VERIFY_BY_DEFAULT = true;

/**
 * What verification produced: the value-free `Verification` that `ScanResult` carries, and,
 * beside it and never inside it, the exact fix commands for the local fixes file. A command
 * that could not be made safe is an `UnsafeFix`, which carries no command text.
 */
export interface VerifyOutcome {
  readonly verification: Verification;
  /**
   * Every fix for the local fixes file, from every check: an exact command, or a fix that could
   * not be made safe, which the file lists with its note and no command text.
   */
  readonly localFixes: readonly (LocalFix | UnsafeFix)[];
  /**
   * The git-backed checks' fixes that could not be made safe, also in `localFixes`. Kept apart
   * for the checks' own tests; the categories' facts count them too.
   */
  readonly unsafeFixes?: readonly UnsafeFix[];
}

/**
 * A `VerifyIO` that can do nothing: every call fails as `missing`. Verification run with it
 * reads the transcripts and reports every repo-backed result as could-not-check.
 */
export const UNAVAILABLE_VERIFY_IO: VerifyIO = {
  git: () => Promise.resolve({ ok: false, reason: "missing" }),
  isDirectory: () => undefined,
  readFile: () => Promise.resolve({ ok: false, reason: "missing" }),
  processNames: () => Promise.resolve({ ok: false, reason: "missing" }),
};

/**
 * Charge in-process work to the run's one time budget, where the seam keeps one (`charge`);
 * a seam without a budget is left alone.
 */
function chargeTime(io: VerifyIO, ms: number): void {
  (io as VerifyIO & { charge?: (ms: number) => boolean }).charge?.(Math.max(0, ms));
}

/** Run every check there is. Never throws. */
export async function verifyScan(input: VerifyInput): Promise<VerifyOutcome> {
  const agent = input.corpus.agent ?? "claude";
  const matched = tallyMatchedCalls(input.corpus, input.catalog, input.allowlist);
  const secrets = await checkSecrets({
    agent,
    files: input.corpus.files ?? [],
    readLines: input.readLines,
    io: input.io,
    fingerprint: input.fingerprint ?? createFingerprinter(),
    ...(input.secretsCollector === undefined ? {} : { collector: input.secretsCollector }),
  });
  const git = await checkGitBacked({
    corpus: input.corpus,
    io: input.io,
    rules: { catalog: input.catalog, allowlist: input.allowlist },
    home: input.home ?? homedir(),
    ...(input.scratchRoots === undefined ? {} : { scratchRoots: input.scratchRoots }),
  });

  // The checks that read what commands and edits did share one reading of the calls. That
  // reading and the checks that need nothing else run in-process first.
  const started = Date.now();
  const calls = readCalls(input.corpus, input.catalog, input.allowlist);
  const rules = { catalog: input.catalog, allowlist: input.allowlist };
  const cloud = checkCloud({ calls, ...rules });
  // Database targets by class (local, scratch, other), from the destructive-commands check. A
  // target it could not resolve is never local: the production check counts it as unconfirmed.
  // When that check could not run, the targets are not available.
  const classes = databaseTargetClasses(git.destructive);
  const databaseTargets: DatabaseTargetCounts | undefined =
    classes === undefined
      ? undefined
      : { local: classes.local, scratch: classes.scratch, other: classes.other };
  const prodInfra = checkProdInfra({
    calls,
    ...rules,
    databaseTargets,
    databaseTargetsUnresolved: classes?.unresolved ?? 0,
  });
  const dependencies = checkDependencies(calls);
  chargeTime(input.io, Date.now() - started);

  const tests = await checkTests({ calls, io: input.io });
  const unreviewed = await checkUnreviewed({ calls, io: input.io, rules });
  const egress = await checkEgress({ calls, ...rules, io: input.io });

  const verification: Verification = {
    matchedCalls: matched.tally,
    resultsRecorded: matched.resultsRecorded,
    ranEvidence: matched.ranEvidence,
    categories: {
      secrets,
      "skipped-checks": git["skipped-checks"],
      "lost-work": git["lost-work"],
      cloud: cloud.check,
      "prod-infra": prodInfra,
      tests: tests.check,
      destructive: git.destructive,
      unreviewed: unreviewed.check,
      egress: egress.check,
    },
    dependencies,
  };
  return {
    verification,
    localFixes: [
      ...git.localFixes,
      ...git.unsafeFixes,
      ...tests.localFixes,
      ...cloud.localFixes,
      ...unreviewed.localFixes,
      ...egress.localFixes,
    ],
    unsafeFixes: git.unsafeFixes,
  };
}
