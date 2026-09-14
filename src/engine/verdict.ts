import type { Action, PolicyVerdict } from "./shared.js";

export interface VerdictMatch {
  readonly policyId: string;
  readonly action: Action;
}

export function strongestVerdict(matches: readonly VerdictMatch[]): {
  verdict: PolicyVerdict;
  policyId: string | null;
} {
  let denyId: string | null = null;
  let approvalId: string | null = null;
  for (const m of matches) {
    if (m.action === "block") {
      if (denyId === null) denyId = m.policyId;
    } else if (m.action === "require_approval") {
      if (approvalId === null) approvalId = m.policyId;
    }
  }
  if (denyId !== null) return { verdict: "deny", policyId: denyId };
  if (approvalId !== null) return { verdict: "require_approval", policyId: approvalId };
  return { verdict: "allow", policyId: null };
}
