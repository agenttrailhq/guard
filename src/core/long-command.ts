/**
 * The built-in approval for a call too long to check in full.
 *
 * ── Why it exists ────────────────────────────────────────────────────────────
 * The engine reads at most `MAX_DETAIL_LEN` characters of a command (`mapper.ts`). Past
 * that, the rules see nothing, so padding a command with blank space, a comment or a long
 * string would put whatever follows out of every rule's reach. A call the cap cut is
 * therefore never let through on the rules alone: `evaluate.ts` adds this approval to
 * whatever the rules decided on the part they saw. A block on that part still wins, because
 * the strongest verdict wins.
 *
 * ── Why it is not a guardrail ────────────────────────────────────────────────
 * It is not about a risky shape. It says that nothing checked the rest of the call. So it
 * has no predicate, the allowlist cannot suppress it, `disabledGuardrails` and the action
 * overrides cannot reach it, and a person's own `guardrails.json` cannot replace it.
 *
 * ── The message ──────────────────────────────────────────────────────────────
 * Content-free, like every decision message: it names the length and the limit, never the
 * command. It ends with what the agent can do instead, which is to run the work as shorter
 * commands.
 */

import { MAX_DETAIL_LEN } from "./mapper.js";
import type { CompiledRule } from "./rules.js";
import type { GuardRule } from "./types.js";

/** The id decisions, logs and reports record for it. */
export const COMMAND_TOO_LONG_ID = "guard.command-too-long";

/** Thousands separators that don't depend on the machine's locale. */
function count(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** The built-in, as a rule, so a report can name it like any guardrail. */
export const COMMAND_TOO_LONG_RULE: GuardRule = {
  id: COMMAND_TOO_LONG_ID,
  category: "guard",
  severity: "high",
  defaultAction: "require_approval",
  title: "Too long to check in full",
  description:
    `The guardrails read the first ${count(MAX_DETAIL_LEN)} characters of a command. A longer ` +
    "call needs a person's approval, because nothing checked the rest of it. A block on the " +
    "part that was read still blocks.",
  match: {},
};

/**
 * The built-in as a compiled catalog entry. It never matches on its own: it is added by
 * `evaluate.ts` from the call's `uncheckedLength`, not from the call's text.
 */
export const COMMAND_TOO_LONG: CompiledRule = {
  rule: COMMAND_TOO_LONG_RULE,
  action: "require_approval",
  evaluate: () => ({ matched: false, reasons: [] }),
};

/**
 * What the decision message says after its lead, for a call of `length` characters.
 * `evaluate.ts` puts its approval lead in front, as it does for every guardrail, so the
 * Cursor and Codex emitters can replace that lead the same way.
 */
export function commandTooLongText(length: number): string {
  return (
    `it is too long to check in full (${count(length)} characters; the limit is ` +
    `${count(MAX_DETAIL_LEN)}). Run it as shorter commands. (guardrail ${COMMAND_TOO_LONG_ID})`
  );
}
