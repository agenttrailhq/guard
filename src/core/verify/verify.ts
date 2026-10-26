// cspell:words Fingerprinter
/**
 * `scan --verify`: check a scan's matches against this machine, read-only, and say what was
 * found as a `Verification`.
 *
 * Offline: nothing here reaches the network, and no value is checked with the service it
 * belongs to. Read-only: the only things it starts are the allow-listed `git` calls on
 * `VerifyIO`, and it writes nothing.
 *
 * Today it runs: whether each matched call ran (`ran.ts`), the secrets check (`secrets.ts`),
 * and the git-backed checks for skipped checks, lost work and destructive commands
 * (`git-checks.ts`). Every other category reads `not-checked` until its check exists, which the
 * report states as such and never as clean.
 */

import { homedir } from "node:os";
import type { CompiledAllowlist } from "../evaluate.js";
import type { CompiledRule } from "../rules.js";
import type { ScanCorpus } from "../scan-report.js";
import type { LocalFix, UnsafeFix } from "./cards.js";
import { createFingerprinter, type Fingerprinter } from "./fingerprint.js";
import { checkGitBacked } from "./git-checks.js";
import { tallyMatchedCalls } from "./ran.js";
import { checkSecrets } from "./secrets.js";
import type { PendingCheck, Verification, VerifyIO } from "./types.js";

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
  /** For tests: folders whose contents are scratch. Production uses `TEMP_ROOTS`. */
  readonly scratchRoots?: readonly string[];
}

/**
 * Whether `scan` verifies without being asked. The one switch for turning verification on by
 * default; until it is `true`, `scan --verify` is how to ask for it.
 */
export const VERIFY_BY_DEFAULT = false;

/**
 * What verification produced: the value-free `Verification` that `ScanResult` carries, and,
 * beside it and never inside it, the exact fix commands for the local fixes file.
 */
export interface VerifyOutcome {
  readonly verification: Verification;
  readonly localFixes: readonly LocalFix[];
  /**
   * Fixes a check could not make a safe command for, each with its note. No command text.
   * For the local fixes file to list as notes; the categories' facts count them too.
   */
  readonly unsafeFixes?: readonly UnsafeFix[];
}

/** A category with no check yet. */
const NOT_CHECKED: PendingCheck = { status: "not-checked" };

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
  });
  const git = await checkGitBacked({
    corpus: input.corpus,
    io: input.io,
    home: input.home ?? homedir(),
    ...(input.scratchRoots === undefined ? {} : { scratchRoots: input.scratchRoots }),
  });
  const verification: Verification = {
    matchedCalls: matched.tally,
    resultsRecorded: matched.resultsRecorded,
    ranEvidence: matched.ranEvidence,
    categories: {
      secrets,
      "skipped-checks": git["skipped-checks"],
      "lost-work": git["lost-work"],
      cloud: NOT_CHECKED,
      "prod-infra": NOT_CHECKED,
      tests: NOT_CHECKED,
      destructive: git.destructive,
      unreviewed: NOT_CHECKED,
      egress: NOT_CHECKED,
    },
  };
  return { verification, localFixes: git.localFixes, unsafeFixes: git.unsafeFixes };
}
