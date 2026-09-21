/**
 * Transcript tool calls → the exact payload shape the hook is fed.
 *
 * ── This adapter is the whole reason `scan` and `hook` agree ─────────────────
 * `scan` maps each tool call through the same mapper the live hook uses, so a rule
 * behaves identically in `scan` and in `hook`. The temptation is to read `ToolUse.input.command` directly
 * here — it is one line shorter and it is wrong in three ways at once. It would skip
 * `mapToolCall`'s 8192-char cap, its middle-truncation for `mcp__*`, and its
 * unknown-tool fallback; a rule would then match in a scan and not in the hook, or the
 * reverse, and the report would be advertising an enforcement behavior that does not
 * exist. So this module's entire job is to produce a `PreToolUsePayload` and hand it
 * to the same `mapToolCall` the hook calls, unchanged.
 *
 * ── Sidechain turns are INCLUDED, deliberately ───────────────────────────────
 * A sidechain is a sub-agent the user's agent spawned. Its tool calls ran on the
 * user's machine, against the user's files, and the guard's hook intercepts them like
 * any other — `hooks.json` matches on tool name and knows nothing about sidechains. A
 * scan that dropped them would under-report exactly the work the user delegated and
 * watched least closely.
 *
 * ── One tool call, counted once ──────────────────────────────────────────────
 * `commands/scan.ts` folds a session's separate sub-agent transcript files into the same
 * `ParsedSession`. A tool call that appears both inline in the main transcript and in a
 * sub-agent's file would then be seen twice, so `toolCallsOf` de-duplicates by
 * `tool_use_id` — unique per call, so this never drops a distinct call, only a repeat.
 */

import type { ParsedSession, ToolUse } from "./transcript/transcript-types.js";
import type { PreToolUsePayload } from "./types.js";

/**
 * One tool call from a transcript, in payload form.
 *
 * `tool_name` and `tool_input` are the two keys `mapToolCall` reads, spelled exactly
 * as Claude Code spells them on stdin. `PreToolUsePayload` types both as `unknown`
 * because the hook's input is untrusted; here they come from a parsed transcript and
 * are already `string` / `Record<string, unknown>`, but the payload type is the one
 * the mapper accepts and widening back to it costs nothing.
 */
export function toolCallPayload(use: ToolUse): PreToolUsePayload {
  return { tool_name: use.name, tool_input: use.input };
}

/** Every tool call in a session, in transcript order, as hook payloads. */
export function toolCallsOf(session: ParsedSession): PreToolUsePayload[] {
  const payloads: PreToolUsePayload[] = [];
  const seen = new Set<string>();
  for (const turn of session.turns) {
    for (const use of turn.toolUses) {
      // De-dup by `tool_use_id`: a session merged from a main transcript and its
      // sub-agents' files can carry one call twice, and it must count once. Ids are unique
      // per call, so this drops only a repeat, never a distinct call. A call with no id
      // (the parser only keeps tool_uses that had one, so this is defensive) is always kept.
      if (use.toolUseId !== "" && seen.has(use.toolUseId)) continue;
      seen.add(use.toolUseId);
      payloads.push(toolCallPayload(use));
    }
  }
  return payloads;
}
