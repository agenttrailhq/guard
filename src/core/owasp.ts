/**
 * OWASP ids on guardrails and scan findings, the per-risk tally, and where each id is explained.
 *
 * The id lists, `OwaspId` and each risk's title come from `@agenttrail/guardrails` through its
 * zod-free entry and are re-exported here, so there is one list.
 *
 * Every id the guard shows comes from a shipped guardrail's own `owasp` field. Nothing is
 * inferred from a guardrail's pack, title or what it matched.
 */

import {
  isOwaspId,
  OWASP_AGENTIC,
  OWASP_IDS,
  OWASP_LLM,
  type OwaspId,
  owaspIndex,
  owaspTitle,
} from "@agenttrail/guardrails/guardrails";

export { isOwaspId, OWASP_AGENTIC, OWASP_IDS, OWASP_LLM, type OwaspId, owaspTitle };

/** The page that explains, risk by risk, what the guardrails do and do not cover. */
export const OWASP_PAGE_URL = "https://www.agenttrail.sh/security/owasp";

/** The link to one risk's row on that page, e.g. `…/security/owasp#asi02`. */
export function owaspAnchorUrl(id: OwaspId): string {
  return `${OWASP_PAGE_URL}#${id.toLowerCase()}`;
}

/** What a scan found for one OWASP risk. */
export interface OwaspTally {
  readonly id: OwaspId;
  /** Distinct tool calls matched by at least one guardrail carrying this id. */
  readonly callCount: number;
  /**
   * Sum of the per-guardrail match counts for guardrails carrying this id. A call matched by
   * two such guardrails adds 2 here and 1 to `callCount`.
   */
  readonly ruleMatches: number;
  /** Distinct guardrails carrying this id that matched at least once. */
  readonly guardrailCount: number;
}

/** The fields of a finding the tally reads. */
interface TalliedFinding {
  readonly count: number;
  readonly owasp: readonly OwaspId[];
}

/**
 * Tally a scan by OWASP risk.
 *
 * @param findings - per-guardrail findings, each carrying its guardrail's own ids.
 * @param callIds - one entry per matched tool call: the ids of every guardrail that matched
 *   it. A per-call count cannot be rebuilt from per-guardrail findings, so the caller collects
 *   this while it walks the calls.
 * @returns one entry per risk with at least one match, in `OWASP_IDS` order.
 */
export function owaspTally(
  findings: readonly TalliedFinding[],
  callIds: readonly (readonly OwaspId[])[],
): readonly OwaspTally[] {
  const calls = new Map<OwaspId, number>();
  for (const ids of callIds) {
    for (const id of new Set(ids)) calls.set(id, (calls.get(id) ?? 0) + 1);
  }
  const matches = new Map<OwaspId, number>();
  const guardrails = new Map<OwaspId, number>();
  for (const finding of findings) {
    for (const id of finding.owasp) {
      matches.set(id, (matches.get(id) ?? 0) + finding.count);
      guardrails.set(id, (guardrails.get(id) ?? 0) + 1);
    }
  }
  return [...guardrails.keys()]
    .sort((a, b) => owaspIndex(a) - owaspIndex(b))
    .map((id) => ({
      id,
      callCount: calls.get(id) ?? 0,
      ruleMatches: matches.get(id) ?? 0,
      guardrailCount: guardrails.get(id) ?? 0,
    }));
}
