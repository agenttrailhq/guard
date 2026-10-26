/**
 * The enums and keys the git-backed checks' facts use: skipped checks, lost work and destructive
 * commands. `types.ts` adds them to `FACT_VALUE_ENUMS` and `FACT_KEYS`, so the report boundary
 * keeps these facts and drops anything else.
 *
 * A leaf module: it imports nothing, so `types.ts` can include it without a cycle.
 */

/** The classes of an `rm -rf` target. See `destructive.ts`. */
export const RM_TARGET_CLASSES = [
  "unguarded-variable",
  "guarded-variable",
  "scratch",
  "tracked",
  "untracked",
  "home",
  "other",
] as const;

/** The classes of a database a destructive command was aimed at. See `destructive.ts`. */
export const DATABASE_CLASSES = ["local", "scratch", "other", "unresolved"] as const;

/** The enums the git-backed checks' facts hold as values. */
export const GIT_FACT_ENUMS: readonly (readonly string[])[] = [RM_TARGET_CLASSES, DATABASE_CLASSES];

/** The keys the git-backed checks' facts use. */
export const GIT_FACT_KEYS: readonly string[] = [
  // Shared by every tally of calls.
  "calls",
  "ran",
  "mentioned",
  "unknown",
  "couldNotCheck",
  // Skipped checks.
  "noVerify",
  "commits",
  "notIdentified",
  "withoutHooks",
  "onMain",
  "offMain",
  "noMainToCheck",
  "gone",
  "otherNoVerify",
  "husky",
  "hooksPath",
  "off",
  "on",
  "none",
  "instructions",
  "read",
  "sayToSkip",
  "agentWrote",
  "agentWroteStill",
  "agentWroteRemoved",
  "couldNotRead",
  // Lost work.
  "branches",
  "deleted",
  "recoverable",
  "onAnotherRef",
  "stashes",
  "dropped",
  "cleared",
  "listed",
  "discards",
  "paths",
  "ownCopy",
  "agentEdited",
  "mainCheckout",
  // Destructive commands.
  "rm",
  "targets",
  "trackedBack",
  "trackedGone",
  "trackedPartlyBack",
  "databases",
];
