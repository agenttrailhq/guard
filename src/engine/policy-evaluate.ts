import type { AgentVendor } from "./agent-vendor.js";
import type { Severity } from "./common.js";
import type { Action, PolicyPredicate } from "./policy-predicate.js";
import type { SpanKind } from "./trace.js";

export type PolicyVerdict = "allow" | "deny" | "require_approval";

export type PolicyFailMode = "closed" | "open";

export const POLICY_EVALUATE_DEFAULT_KIND: SpanKind = "execute_tool";

export interface PolicyEvaluateScope {
  readonly agent_id?: string;
  readonly project_id?: string;

  readonly developer_id?: string | null;

  readonly vendor?: AgentVendor;
}

export interface PolicyEvaluateRequest {
  readonly tool: string;

  readonly args: Readonly<Record<string, string>>;

  readonly kind?: SpanKind;

  readonly scope?: PolicyEvaluateScope;
}

export const POLICY_HOLD_MAX_WINDOW_SECONDS = 590;

export interface PolicyHoldRequest extends PolicyEvaluateRequest {
  readonly correlation_id: string;

  readonly max_window_seconds?: number;
}

export type PolicyHoldOutcome = "approved" | "denied" | "unanswered";

export interface PolicyHoldResponse {
  readonly outcome: PolicyHoldOutcome;

  readonly approval_id: string | null;

  readonly reason: string;
}

export interface PolicyMatchedPolicy {
  readonly id: string;
  readonly name: string;
  readonly action: Action;
  readonly severity: Severity;
}

export interface PolicyEvaluateResponse {
  readonly verdict: PolicyVerdict;

  readonly policy_id: string | null;

  readonly reason: string;

  readonly matched_policies: readonly PolicyMatchedPolicy[];

  readonly fail_mode: PolicyFailMode;

  readonly snapshot_version: string;
}

export interface PolicyCompiledEntry {
  readonly id: string;
  readonly name: string;
  readonly action: Action;
  readonly severity: Severity;

  readonly predicate: PolicyPredicate;
}

export interface PolicyCompiledSnapshot {
  readonly version: string;
  readonly fail_mode: PolicyFailMode;
  readonly policies: readonly PolicyCompiledEntry[];
}
