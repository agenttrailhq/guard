/**
 * OWASP ids on guardrails, and on scan findings.
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
  owaspTitle,
} from "@agenttrail/guardrails/guardrails";

export { isOwaspId, OWASP_AGENTIC, OWASP_IDS, OWASP_LLM, type OwaspId, owaspTitle };
