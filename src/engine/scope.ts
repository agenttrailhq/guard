import type { PolicyPredicate } from "./policy-predicate.js";
import type { SpanContext } from "./types.js";

type PredicateScope = PolicyPredicate["scope"];

function isInScopeArray(scopeArray: readonly string[], value: string): boolean {
  return scopeArray.includes("*") || scopeArray.includes(value);
}

export function matchScope(
  scope: PredicateScope,
  context: SpanContext,
): { matched: boolean; reason: string } {
  if (scope === undefined) {
    return { matched: true, reason: "scope: no scope filter (applies globally)" };
  }

  const failures: string[] = [];

  if (scope.agent_in !== undefined) {
    if (!isInScopeArray(scope.agent_in, context.agentId)) {
      failures.push(`agent_in: "${context.agentId}" not in [${scope.agent_in.join(", ")}]`);
    }
  }

  if (scope.project_in !== undefined) {
    if (!isInScopeArray(scope.project_in, context.projectId)) {
      failures.push(`project_in: "${context.projectId}" not in [${scope.project_in.join(", ")}]`);
    }
  }

  if (failures.length > 0) {
    return {
      matched: false,
      reason: `scope: ${failures.join("; ")}`,
    };
  }

  return { matched: true, reason: "scope: all scope filters matched" };
}
