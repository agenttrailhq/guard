/**
 * THE ONLY WRITER TO STDOUT ON THE CURSOR PATH, and the rule that turns a verdict into
 * Cursor's answer.
 *
 * ── Cursor's answers ─────────────────────────────────────────────────────────
 *
 *   deny        → {"permission":"deny","user_message":R,"agent_message":R + relay}
 *   ask         → {"permission":"ask","user_message":R,"agent_message":R + relay}
 *   no opinion  → {}
 *
 * At most one object is written, and nothing else.
 *
 * ── The two messages differ ──────────────────────────────────────────────────
 * `user_message` is the sentence Cursor shows. `agent_message` is that same sentence plus
 * `RELAY_INSTRUCTION`, because the agent RETELLS what it is handed instead of quoting it,
 * and the product name is the part it drops. Cursor shows no reason of its own, so that
 * retelling is all the user gets.
 *
 * Claude Code's hook protocol has ONE reason field (`core/emit.ts`) and Claude Code renders
 * it itself, so there is nothing to split there and that file is untouched.
 *
 * ── Never `allow` ────────────────────────────────────────────────────────────
 * The guard only ever tightens a call, so no branch here builds an `allow`. `{}` is the
 * no-opinion answer: the call goes through Cursor's own approval as if the guard were not
 * installed. Empty output behaves the same, but Cursor's Hooks log reports it as no valid
 * response, which reads like a broken hook.
 *
 * ── Always exit 0, never exit 2 ──────────────────────────────────────────────
 * Exit 2 blocks in Cursor, the same as a deny. As in `emit.ts`, nothing here exits, and
 * the process ends at 0.
 *
 * ── `ask` works only at `beforeShellExecution` ───────────────────────────────
 * Cursor accepts `ask` at `preToolUse` but does not enforce it: the call runs with no
 * prompt. So:
 * - a terminal command's approval is left to `beforeShellExecution`, which shows Cursor's
 *   approval card. `preToolUse` answers `{}` for it and does not log it;
 * - any other tool has no second checkpoint, so an approval rule denies it with
 *   `cursorApprovalMessage`, which says both that a person has to approve and that Cursor
 *   cannot ask.
 *
 * ── One log line per decision ────────────────────────────────────────────────
 * A terminal command passes both checkpoints, and each decision is logged once:
 * - a block where it is answered (a `preToolUse` deny ends the call before
 *   `beforeShellExecution`);
 * - an approval at `beforeShellExecution`, where it is asked;
 * - a warning at `preToolUse`, and not again at `beforeShellExecution`.
 *
 * ── Launched by another app's copy of guard ──────────────────────────────────
 * Cursor can also run guard's Claude Code plugin, handing it Cursor's payload. That copy
 * has no `beforeShellExecution` entry, so it cannot leave an approval for later.
 * - With guard's Cursor entry installed, the Cursor entry answers approvals and warnings
 *   and writes every log line. The plugin copy still denies a block, but answers `{}` to an
 *   approval: Cursor lets any deny win over an ask, so a deny from it would cancel the card
 *   the Cursor entry is about to show.
 * - Without it, the plugin copy is the only checkpoint: it denies blocks and approvals and
 *   logs every decision.
 */

import { unhandledAgent } from "./agent.js";
import type { CursorCheckedEvent } from "./cursor-mapper.js";
import type { StdoutSink } from "./emit.js";
import { APPROVAL_LEAD } from "./evaluate.js";
import type { AgentSource, GuardDecision, MappedCall } from "./types.js";

/** Cursor's no-opinion answer. */
export const NO_OPINION = "{}";

/**
 * Is this run guard's own Cursor entry, rather than another app's copy of guard that has
 * been handed a Cursor payload?
 *
 * Only guard's Cursor install writes `--agent cursor`, so the flag answers it. A checked
 * switch rather than `launchedAs === "claude"`, which is what it used to be: Codex can
 * import Claude Code hooks and load Claude-style plugins, so a third app arriving here
 * would have been read as guard's own Cursor entry — the branch that assumes a
 * `beforeShellExecution` checkpoint exists to hold an approval, which in that case there
 * is not. Anything that is not `cursor`, including no flag, is the other-copy case.
 *
 * Pure, and never throws for any member of the union.
 */
export function isGuardsCursorEntry(launchedAs: AgentSource | undefined): boolean {
  switch (launchedAs) {
    case "cursor":
      return true;
    case "claude":
    case "codex":
    case undefined:
      return false;
    default:
      return unhandledAgent(launchedAs);
  }
}

/** What an approval reads as when Cursor has no way to ask, and the guard denies instead. */
export const CURSOR_APPROVAL_LEAD =
  "agenttrail-guard needs a person to approve this, and Cursor cannot ask: ";

/**
 * The message for an approval Cursor cannot show a card for.
 *
 * `APPROVAL_LEAD`'s sentence is REPLACED, not prefixed: both leads say a person has to
 * approve, so prefixing would say it twice in one line. Everything after the lead — the
 * guardrail's title and id — is kept exactly as `core/evaluate.ts` built it.
 *
 * A reason that does not start with the lead is kept whole, so a decision built some other
 * way still produces one readable sentence rather than a truncated one.
 */
export function cursorApprovalMessage(reason: string): string {
  const rest = reason.startsWith(APPROVAL_LEAD) ? reason.slice(APPROVAL_LEAD.length) : reason;
  return `${CURSOR_APPROVAL_LEAD}${rest}`;
}

/**
 * Appended to `agent_message`, and to that field ONLY.
 *
 * Measured: handed one sentence for both fields, the agent paraphrased it and dropped the
 * product name every time — "Access is blocked until someone approves production config
 * edits" names no tool the user can go and look at. This asks for the sentence to be passed
 * on as written instead.
 *
 * CONTENT-FREE, like the message it follows: no command, no path, nothing it judged. It
 * never goes on `user_message`, which Cursor shows to the user as it is — an instruction
 * addressed to the agent would read as noise there.
 */
export const RELAY_INSTRUCTION =
  ". Relay this to the user verbatim, naming agenttrail-guard and the guardrail, and do not work around it.";

/** The agent's copy of a decision message: the sentence, plus the instruction to relay it. */
export function agentMessage(message: string): string {
  return `${message}${RELAY_INSTRUCTION}`;
}

/** What decides Cursor's answer for one call. */
export interface CursorAnswerInput {
  /**
   * The app whose hook configuration launched the hook, or `undefined` when its command
   * line named none. Only `cursor` is guard's own Cursor entry — see `isGuardsCursorEntry`.
   */
  readonly launchedAs: AgentSource | undefined;
  readonly event: CursorCheckedEvent;
  /** Cursor's tool name at `preToolUse` (`Shell`, `Read`, …). Not read at `beforeShellExecution`. */
  readonly tool: string;
  readonly decision: GuardDecision;
  /**
   * Whether guard's own Cursor hook entries are installed. Read only when launched as
   * `claude`; absent counts as not installed.
   */
  readonly cursorEntryPresent?: boolean;
}

/** Cursor's answer for one call, and whether this checkpoint logs the decision. */
export interface CursorAnswer {
  /** The one JSON object to write: `{}`, a deny or an ask. */
  readonly output: string;
  /** Whether this checkpoint writes the decision-log line. */
  readonly record: boolean;
}

/** A deny or an ask: the user's sentence, and the agent's copy of it with the relay line. */
function permission(kind: "deny" | "ask", message: string): string {
  return JSON.stringify({
    permission: kind,
    user_message: message,
    agent_message: agentMessage(message),
  });
}

/**
 * Cursor's answer for a verdict.
 *
 * Pure, and never throws. `cursor-emit.test.ts` covers every row.
 */
export function buildCursorAnswer(input: CursorAnswerInput): CursorAnswer {
  const { launchedAs, event, tool, decision } = input;
  const matched = decision.matches.length > 0;
  const approvalDeny = permission("deny", cursorApprovalMessage(decision.reason));

  if (!isGuardsCursorEntry(launchedAs)) {
    const onlyCheckpoint = input.cursorEntryPresent !== true;
    if (decision.decision === "deny") {
      return { output: permission("deny", decision.reason), record: onlyCheckpoint };
    }
    if (decision.decision === "ask") {
      return onlyCheckpoint
        ? { output: approvalDeny, record: true }
        : { output: NO_OPINION, record: false };
    }
    return { output: NO_OPINION, record: onlyCheckpoint && matched };
  }

  if (decision.decision === "deny") {
    return { output: permission("deny", decision.reason), record: true };
  }
  if (decision.decision === "ask") {
    if (event === "beforeShellExecution") {
      return { output: permission("ask", decision.reason), record: true };
    }
    if (tool === "Shell") return { output: NO_OPINION, record: false };
    return { output: approvalDeny, record: true };
  }
  // `allow`: a warning when a rule matched, and no match at all otherwise.
  return { output: NO_OPINION, record: matched && event === "preToolUse" };
}

/** One evaluated candidate from `mapCursorCall`. */
export interface EvaluatedCandidate {
  readonly mapped: MappedCall;
  readonly decision: GuardDecision;
}

/** Strictness order: deny, then ask, then a warning, then no match. */
function strictness(decision: GuardDecision): number {
  if (decision.decision === "deny") return 3;
  if (decision.decision === "ask") return 2;
  return decision.matches.length > 0 ? 1 : 0;
}

/**
 * The strictest of a call's evaluated candidates. On a tie the earlier one is kept, which
 * for a `Grep` is the path that names the file.
 *
 * Pure, and never throws.
 */
export function strictestCandidate(
  results: readonly [EvaluatedCandidate, ...EvaluatedCandidate[]],
): EvaluatedCandidate {
  let kept = results[0];
  for (const result of results.slice(1)) {
    if (strictness(result.decision) > strictness(kept.decision)) kept = result;
  }
  return kept;
}

/**
 * Write Cursor's answer. The first call wins, so a late error path can never append a
 * second object and turn a valid answer into invalid JSON, which Cursor treats as a block.
 */
export function createCursorEmitter(stdout: StdoutSink): {
  emit(output: CursorAnswer["output"]): void;
  hasEmitted(): boolean;
} {
  let done = false;
  return {
    emit(output) {
      if (done) return;
      done = true;
      stdout.write(output);
    },
    hasEmitted() {
      return done;
    },
  };
}
