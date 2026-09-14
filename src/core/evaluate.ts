/**
 * The evaluate loop: allowlist → evaluate → strongest verdict → map.
 *
 * ── Why the guard keeps its OWN match list ───────────────────────────────────
 * `strongestVerdict` (`engine/verdict.ts`) folds `warn` into `allow` and returns
 * `policyId: null` for it — a warn-only result is indistinguishable from no match
 * at all. But `warn` must allow **and be recorded**, and `status` has to name
 * the rule that fired. So the combined verdict decides the DECISION and the guard's
 * own `matches` array carries the RECORD. Reading the record off the verdict would
 * silently lose every warn.
 *
 * ── The allowlist is per-rule, never global ──────────────────────────────────
 * A `{guardrail, pattern}` entry suppresses THAT guardrail on THAT shape. Silencing
 * one noisy rule must leave the other 55 firing — a global mute is how a security tool
 * becomes decorative while still looking installed.
 */

import picomatch from "picomatch";
import type { SpanContext } from "../engine/evaluator.js";
import { strongestVerdict } from "../engine/verdict.js";
import type { CompiledRule } from "./rules.js";
import type { AllowlistEntry, GuardDecision, MappedCall, RuleMatch } from "./types.js";

/** Compiled allowlist matchers, built once alongside the catalog. */
export interface CompiledAllowlist {
  readonly entries: readonly { rule: string; isMatch: (s: string) => boolean }[];
}

/**
 * Compile the allowlist patterns once.
 *
 * A pattern that picomatch cannot compile is DROPPED rather than thrown: a broken
 * allowlist entry must not crash the hook, and — more importantly — must not
 * accidentally suppress anything. Dropping it fails toward enforcement.
 */
export function compileAllowlist(entries: readonly AllowlistEntry[]): CompiledAllowlist {
  const compiled: { rule: string; isMatch: (s: string) => boolean }[] = [];
  for (const entry of entries) {
    try {
      compiled.push({ rule: entry.guardrail, isMatch: picomatch(entry.pattern, { dot: true }) });
    } catch {}
  }
  return { entries: compiled };
}

/**
 * Is this rule allowlisted for this specific call?
 *
 * The pattern is tested against each populated channel. Only an entry naming THIS
 * rule id can suppress it.
 */
function isAllowlisted(ruleId: string, mapped: MappedCall, allowlist: CompiledAllowlist): boolean {
  for (const entry of allowlist.entries) {
    if (entry.rule !== ruleId) continue;
    const command = mapped.args.full_command;
    const filePath = mapped.args.file_path;
    if (command !== undefined && entry.isMatch(command)) return true;
    if (filePath !== undefined && entry.isMatch(filePath)) return true;
  }
  return false;
}

/**
 * Evaluate one mapped call against the compiled catalog.
 *
 * Total by construction: a rule whose evaluator throws is skipped, not propagated.
 * With no channels populated (an unknown tool, a malformed payload, `WebFetch`)
 * nothing can match and the result is `allow`.
 */
export function evaluateCall(
  catalog: readonly CompiledRule[],
  context: SpanContext,
  mapped: MappedCall,
  allowlist: CompiledAllowlist,
): GuardDecision {
  const matches: RuleMatch[] = [];

  for (const entry of catalog) {
    if (isAllowlisted(entry.rule.id, mapped, allowlist)) continue;
    let matched = false;
    try {
      matched = entry.evaluate(context).matched;
    } catch {
      // A malformed predicate must never crash enforcement — skip it.
      continue;
    }
    if (matched) matches.push({ ruleId: entry.rule.id, action: entry.action });
  }

  const { verdict, policyId } = strongestVerdict(
    matches.map((m) => ({ policyId: m.ruleId, action: m.action })),
  );

  if (verdict === "deny") {
    return { decision: "deny", reason: `blocked by guardrail: ${policyId}`, matches };
  }
  if (verdict === "require_approval") {
    return { decision: "ask", reason: `approval required by guardrail: ${policyId}`, matches };
  }
  // `allow` — either nothing matched, or only `warn` rules did. The warns are in
  // `matches` even though the verdict discarded them.
  const warned = matches.length > 0;
  return {
    decision: "allow",
    reason: warned ? `warning from guardrail: ${matches[0]?.ruleId}` : "",
    matches,
  };
}
