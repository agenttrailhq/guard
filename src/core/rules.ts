/**
 * Catalog loading and the COMPILE-ONCE step.
 *
 * Compiling a predicate inside the per-rule loop — compile, evaluate, discard, per
 * rule, per call — is the one thing that could push a 74-rule call toward the 10s
 * ceiling set in `plugin/hooks/hooks.json`, and the guard has no internal watchdog by
 * design. So the catalog is compiled once: parse, skip anything malformed, and keep
 * `{rule, evaluate}` closures.
 *
 * What that buys, precisely: `compilePolicy` pre-compiles `file_glob` patterns and
 * builds the condition closures. It does NOT pre-compile `detail_matches` regexes —
 * those compile lazily inside `matchDetailMatches`, memoized on a module-level cache
 * (`engine/matchers.ts`). And because the hook is a fresh process per tool call,
 * nothing survives between calls either. Compiling once means the closures and globs
 * are built ONCE for the whole catalog instead of once per rule per evaluation.
 */

import { type CompiledEvaluator, compilePolicy } from "../engine/evaluator.js";
import type { PolicyPredicate } from "../engine/policy-predicate.js";
import type { GuardAction, GuardConfig, GuardRule } from "./types.js";

/** A rule with its compiled evaluator and its effective (possibly overridden) action. */
export interface CompiledRule {
  readonly rule: GuardRule;
  readonly action: GuardAction;
  readonly evaluate: CompiledEvaluator;
}

/**
 * Compile a catalog once.
 *
 * A rule whose predicate cannot be compiled is SKIPPED, never fatal — one bad rule
 * must not disable the other 55. It is also the fail-open rule:
 * a throw here would take the whole hook down, and a hook that crashes is a hook
 * that stops protecting anyone.
 */
export function compileCatalog(
  rules: readonly GuardRule[],
  config?: Pick<GuardConfig, "guardrailActionOverrides"> &
    Partial<Pick<GuardConfig, "disabledGuardrails" | "disabledPacks">>,
): CompiledRule[] {
  const compiled: CompiledRule[] = [];
  const overrides = config?.guardrailActionOverrides ?? {};
  // Sets, not `.includes`: this runs once per rule on the hook's hot path, and both
  // lists are user-authored with no bound on their length.
  const disabled = new Set(config?.disabledGuardrails ?? []);
  const disabledPacks = new Set(config?.disabledPacks ?? []);

  for (const rule of rules) {
    // Every pack is on unless the user turned it off, so a pack shipped after install
    // is enforced with no step beyond installing the release that carries it.
    if (disabledPacks.has(rule.category)) continue;
    // Turned off individually by `guardrails disable <guardrail-id>`. Checked after
    // the pack filter so a rule can be off for either reason, and `guardrails list` can say
    // which — see `core/rule-view.ts`.
    if (disabled.has(rule.id)) continue;

    const action = overrides[rule.id] ?? rule.defaultAction;
    const predicate: PolicyPredicate = {
      version: 1,
      match: rule.match,
      action,
    };

    try {
      compiled.push({ rule, action, evaluate: compilePolicy(predicate) });
    } catch {}
  }

  return compiled;
}
