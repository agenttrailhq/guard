/**
 * Refusing an allowlist pattern that would not do what the user meant. CLI-only.
 *
 * ── Why a pattern can silence more than it names ─────────────────────────────
 * `compileAllowlist` compiles the pattern with **picomatch** — a glob matcher, not a
 * literal one. With the installed picomatch:
 *
 *   pattern | `rm -rf /` | `git reset --hard` | `anything at all`
 *   `!foo`  |    true    |        true        |      true
 *   `*`     |    true    |        true        |      true
 *   `**`    |    true    |        true        |      true
 *
 * `!` is picomatch's negation prefix, so `guardrails allow wt.reset-hard "!foo"` suppresses
 * that rule on **everything except the literal string `foo`** — while `guardrails list` and
 * `status`'s rule count keep showing it enabled. The per-rule allowlist (`evaluate.ts`)
 * exists to scope a suppression to one rule on one shape, and a pattern like these
 * defeats that while the rule still looks enabled.
 *
 * So "`allow` is scoped to ONE rule, never a global suppression" is NOT satisfied by
 * writing the entry. It has to be enforced at write time.
 *
 * ── Why the check is empirical, not syntactic ────────────────────────────────
 * A denylist of `*`, `**` and a leading `!` is guessable-around: `{*,}`, `?*`, `[a-z]*`
 * and `!(x)` all reach the same place. The hazard is a property of the COMPILED
 * MATCHER, so the check compiles the candidate with the same
 * `picomatch(pattern, {dot: true})` call `compileAllowlist` uses and runs it over a
 * fixed corpus of ordinary commands the rule has no business seeing. If it matches one,
 * it would silence far more than the shape the user named.
 *
 * **This is a bound, not a proof**, like `guardrails`' ReDoS check. A pattern narrow
 * enough to pass the canaries can still be broader than intended. What it does
 * guarantee is that the three shapes above, and everything that behaves like them,
 * cannot be written by accident.
 *
 * ── The other direction: a pattern that can never match ──────────────────────
 * Over-broad is not the only silent success. A pattern that matches NOTHING also
 * produces "Allowlisted." and changes nothing, and there are two ways to get one by
 * copy-paste, both created by `status`:
 *
 *   1. `<your pattern>` — the literal `status` prints when it must withhold a pattern.
 *      It is an instruction, and it arrives on the one line in the product users are
 *      trained to copy.
 *   2. `[REDACTED:secret:env]` — a redaction placeholder. Dead in the way that matters
 *      and over-broad in a way that surprises:
 *      `cat [REDACTED:secret:env]` matches ONLY that literal string, and the real
 *      command never contains it — the placeholder is what replaced the secret. And a
 *      BARE `[REDACTED:secret:env]` is also read as a bracket expression, so it matches
 *      the single characters `R` and `E`. Either way it compiles without complaint and
 *      does not do what the user meant.
 *
 * Both strings come from `core/redaction.ts` rather than being re-declared here, so a
 * change to either cannot silently disable the detection.
 */

import picomatch from "picomatch";
import { isRedacted, PATTERN_PLACEHOLDER, REDACTION_PREFIX } from "./redaction.js";

/**
 * Ordinary commands and paths that no single rule should be silenced across.
 *
 * Deliberately mundane and deliberately fixed: these are things a developer runs many
 * times a day, and a pattern meant to quieten one noisy rule on one shape has no reason
 * to match any of them. Kept beside the check so a reviewer can see exactly what it
 * does and does not prove.
 *
 * Both channels are represented, because `isAllowlisted` tests the pattern against
 * `full_command` AND `file_path` — a pattern that is narrow on commands and wide on
 * paths is still wide.
 */
export const ALLOW_CANARIES: readonly string[] = [
  "ls -la",
  "git status",
  "pnpm install",
  "cat README.md",
  "echo hello",
  "npm test",
  "src/index.ts",
  "docs/README.md",
];

/** Why a pattern was refused, in one line a person can act on. */
export interface PatternRefusal {
  readonly kind: "too-broad" | "placeholder" | "redacted" | "empty";
  readonly reason: string;
}

/**
 * Check a candidate allowlist pattern.
 *
 * @returns `undefined` when the pattern is fine, else the refusal.
 */
export function checkAllowPattern(pattern: string): PatternRefusal | undefined {
  if (pattern.trim().length === 0) {
    return {
      kind: "empty",
      reason: "an empty pattern matches nothing, so it would suppress nothing.",
    };
  }

  // Checked before compiling: these are copy-paste accidents with specific fixes, and
  // "it matches nothing" is a worse explanation than naming what was pasted.
  if (pattern.includes(PATTERN_PLACEHOLDER)) {
    return {
      kind: "placeholder",
      reason: `\`${PATTERN_PLACEHOLDER}\` is a placeholder, not a pattern — replace it with the command shape you want this guardrail to stop matching. \`status\` prints it when the recorded command held a secret and cannot be suggested verbatim.`,
    };
  }
  if (isRedacted(pattern)) {
    return {
      kind: "redacted",
      reason: `a \`${REDACTION_PREFIX}…]\` placeholder cannot be used as a pattern — it is what replaced a secret in the log, so the real command never contains it and this would match nothing. (The brackets are also read as a character class.) Write the pattern against the real command yourself.`,
    };
  }

  let isMatch: (s: string) => boolean;
  try {
    isMatch = picomatch(pattern, { dot: true });
  } catch (error) {
    return {
      kind: "empty",
      reason: `not a usable pattern (${(error as Error).message}).`,
    };
  }

  const hits = ALLOW_CANARIES.filter((c) => isMatch(c));
  if (hits.length > 0) {
    return {
      kind: "too-broad",
      reason: `it also matches ${hits
        .slice(0, 3)
        .map((h) => `\`${h}\``)
        .join(
          ", ",
        )}${hits.length > 3 ? ` and ${hits.length - 3} more` : ""}, which this guardrail has nothing to do with. That is a global mute for this guardrail, not a silence for one shape — the guardrail would keep showing as enabled while enforcing nothing.`,
    };
  }

  return undefined;
}

/** Does this pattern contain a glob character whose behavior is worth explaining? */
export function hasGlob(pattern: string): boolean {
  return /[*?[\]{}]/.test(pattern);
}

/**
 * The note printed when a pattern contains a glob.
 *
 * More surprising than "`*` stops at `/`": picomatch matches in `/`-separated
 * SEGMENTS, and a shell command is not a path. So against `git reset --hard ./x`,
 * neither `git reset --hard*` NOR `git reset --hard**` matches — the pattern is one
 * segment and the subject is two. `**` only crosses a separator when it is a segment of
 * its own, which is why `./generated/**` works and `--hard**` does not, and why the
 * note must not suggest `**` as a way across a separator.
 */
export const GLOB_NOTE =
  "  Note: patterns match in `/`-separated segments, so no `*` crosses a `/`.\n" +
  "  To cover a subtree, give `**` a segment of its own: `./generated/**`.";
