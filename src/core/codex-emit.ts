/**
 * THE ONLY WRITER TO STDOUT ON THE CODEX PATH, and the rule that turns a verdict into
 * Codex's answer.
 *
 * ── Codex's answers ──────────────────────────────────────────────────────────
 *
 *   PreToolUse        block, approval → {"hookSpecificOutput":{"hookEventName":"PreToolUse",
 *                                        "permissionDecision":"deny",
 *                                        "permissionDecisionReason":R}}
 *                     warning         → {"systemMessage":R}
 *                     no match        → nothing at all
 *
 *   PermissionRequest block, approval → {"hookSpecificOutput":{"hookEventName":
 *                                        "PermissionRequest","decision":
 *                                        {"behavior":"deny","message":R}}}
 *                     anything else   → nothing at all
 *
 * At most one object is written, and nothing else.
 *
 * ── EXACTLY those fields, or the answer is void ──────────────────────────────
 * Measured on codex-cli 0.154.0: a valid deny carrying ONE extra field was discarded
 * whole, the hook run was marked failed, and the action RAN. So the deny above is built
 * from a literal with those three keys and nothing may be added to it — not a rule id,
 * not a severity, not a timestamp.
 *
 * ── An approval is a BLOCK here ──────────────────────────────────────────────
 * Measured: `permissionDecision: "ask"` is rejected, the run is marked failed and the
 * action RUNS. Most of the library asks rather than blocks, so answering Codex the way
 * Claude Code is answered would silently disable most of the catalogue. There is no third
 * option at this layer — `PermissionRequest` only fires when Codex was already going to
 * ask — so an approval denies, and the message says a person has to approve.
 *
 * ── Never `allow`, on either event ───────────────────────────────────────────
 * At `PreToolUse` a bare allow is rejected outright: Codex reserves it for an answer that
 * also rewrites the tool input, which the guard never does. At `PermissionRequest` an
 * allow would be honoured and would SKIP Codex's own approval card — the guard only ever
 * tightens a call, so it must not answer a question on the user's behalf. Silence leaves
 * Codex's normal flow exactly as it was.
 *
 * ── The reason is read by a person, verbatim ─────────────────────────────────
 * Measured: Codex prints the reason on screen under "Blocked by hook", and the model then
 * repeats it to the user. Unlike Cursor, nothing paraphrases it and nothing drops the
 * product name, so the sentence has to stand on its own — it names the product, what
 * happened, and the guardrail's title and id, and nothing it judged.
 *
 * A warning is shown in the terminal UI (`↳ Hook · …`) and is invisible under
 * `codex exec`, where the transcript records only that the hook completed.
 *
 * ── Always exit 0, never exit 2 ──────────────────────────────────────────────
 * Exit 2 blocks in Codex, the same as a deny. As in `emit.ts`, nothing here exits, and
 * the process ends at 0.
 *
 * ── One answer per event, one log line per ACTION ────────────────────────────
 * Both events fire for one action, so both answer — the deny at `PreToolUse` stops it
 * first, and the deny at `PermissionRequest` is a second line of defence that holds even
 * when an automatic reviewer is answering the card. The pair is folded into a single
 * decision-log line by the key in `core/codex-mapper.ts`.
 */

import type { CodexCheckedEvent } from "./codex-mapper.js";
import type { StdoutSink } from "./emit.js";
import { APPROVAL_LEAD } from "./evaluate.js";
import type { GuardDecision } from "./types.js";

/** Codex's no-opinion answer: nothing at all on stdout. */
export const NO_ANSWER = "";

/** What an approval reads as when Codex has no way to ask, and the guard denies instead. */
export const CODEX_APPROVAL_LEAD =
  "agenttrail-guard needs a person to approve this, and Codex cannot ask, so it is blocked: ";

/**
 * The message for an approval Codex cannot show a card for.
 *
 * `APPROVAL_LEAD`'s sentence is REPLACED, not prefixed: both leads say a person has to
 * approve, so prefixing would say it twice in one line. Everything after the lead — the
 * guardrail's title and id — is kept exactly as `core/evaluate.ts` built it.
 *
 * A reason that does not start with the lead is kept whole, so a decision built some other
 * way still produces one readable sentence rather than a truncated one.
 */
export function codexApprovalMessage(reason: string): string {
  const rest = reason.startsWith(APPROVAL_LEAD) ? reason.slice(APPROVAL_LEAD.length) : reason;
  return `${CODEX_APPROVAL_LEAD}${rest}`;
}

/**
 * A message with no decision — a warning, or a call the guard could not evaluate.
 *
 * Accepted on every Codex event, and it decides nothing: the action proceeds through
 * Codex's own flow, as if the guard were not installed.
 */
export function codexSystemMessage(message: string): string {
  return JSON.stringify({ systemMessage: message });
}

/** The deny Codex honours at `PreToolUse`. Three fields, and a fourth voids it. */
function preToolUseDeny(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

/** The deny Codex honours at `PermissionRequest`, which beats its own approval reviewer. */
function permissionRequestDeny(message: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "deny", message },
    },
  });
}

/** What decides Codex's answer for one call. */
export interface CodexAnswerInput {
  readonly event: CodexCheckedEvent;
  readonly decision: GuardDecision;
}

/** Codex's answer for one call, and whether this event logs the decision. */
export interface CodexAnswer {
  /** The one JSON object to write, or `""` for nothing at all. */
  readonly output: string;
  /** Whether this event offers the decision to the log. The key folds the pair into one line. */
  readonly record: boolean;
}

/**
 * Codex's answer for a verdict.
 *
 * Pure, and never throws. `codex-emit.test.ts` covers every row.
 */
export function buildCodexAnswer({ event, decision }: CodexAnswerInput): CodexAnswer {
  if (decision.decision === "deny" || decision.decision === "ask") {
    // An approval is a deny here, with a message that says why nobody was asked.
    const message =
      decision.decision === "deny" ? decision.reason : codexApprovalMessage(decision.reason);
    return {
      output:
        event === "PermissionRequest" ? permissionRequestDeny(message) : preToolUseDeny(message),
      record: true,
    };
  }

  // `allow`: a warning when a rule matched, and no match at all otherwise. The warning is
  // said once, at `PreToolUse`; repeating it at `PermissionRequest` would print the same
  // sentence twice for one action.
  const matched = decision.matches.length > 0;
  const warn = matched && event === "PreToolUse";
  return { output: warn ? codexSystemMessage(decision.reason) : NO_ANSWER, record: matched };
}

/**
 * Write Codex's answer. The first call wins — including a first call that writes nothing —
 * so a late error path can never append a second object and turn a valid answer into
 * output Codex discards.
 */
export function createCodexEmitter(stdout: StdoutSink): {
  emit(output: CodexAnswer["output"]): void;
  hasEmitted(): boolean;
} {
  let done = false;
  return {
    emit(output) {
      if (done) return;
      done = true;
      if (output !== NO_ANSWER) stdout.write(output);
    },
    hasEmitted() {
      return done;
    },
  };
}
