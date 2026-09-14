/**
 * The two strings that cross the decision-log / `guardrails` boundary, and nothing else.
 *
 * ── Why a module rather than two constants on each side ─────────────────────
 * The decision log WRITES redaction placeholders (it scrubs commands before they reach
 * `events.jsonl`) and `status` prints `PATTERN_PLACEHOLDER` when it has to withhold a
 * pattern. `guardrails` READS both back: `guardrails allow` must refuse a pattern that is
 * a redaction placeholder, and must refuse the "fill this in yourself" literal if a user
 * pastes the suggestion unedited. Two producers, two consumers, one pair of strings.
 *
 * Declaring them twice would drift: a second copy of a security-relevant literal
 * fails SILENTLY when the original moves — the
 * detection simply stops matching, and `guardrails allow` goes back to accepting a pattern
 * that can never fire. `redaction.test.ts` pins `isRedacted` against a real `scrubText`
 * run rather than against this file's own constant, so a change to the placeholder
 * shape reds the build instead of quietly disabling the check.
 *
 * ── It imports nothing, deliberately ────────────────────────────────────────
 * The obvious home for `isRedacted` was beside the scrubber. It is not here by
 * accident: `guardrails allow` asking "is this string a placeholder?" must not drag the
 * decision-log writer, `io.ts` and the whole 400-line scrubber into the CLI to answer a
 * yes/no question.
 */

/** The prefix every `scrubText` placeholder starts with — `[REDACTED:<kind>:<hint>]`. */
export const REDACTION_PREFIX = "[REDACTED:";

/**
 * The literal `status` prints in place of a pattern it cannot suggest.
 *
 * It is an instruction, not a pattern, and it arrives on the one line in the product
 * users are trained to copy — so `guardrails allow` refuses it by name.
 */
export const PATTERN_PLACEHOLDER = "<your pattern>";

/** Does this text carry a redaction placeholder anywhere in it? */
export function isRedacted(text: string): boolean {
  return text.includes(REDACTION_PREFIX);
}
