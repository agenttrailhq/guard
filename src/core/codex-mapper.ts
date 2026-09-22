/**
 * Codex CLI hook payload → the calls the engine evaluates.
 *
 * Two of Codex's events are answered. `PreToolUse` fires before a tool call;
 * `PermissionRequest` fires beside it when Codex was already going to ask for approval.
 * Any other event is not mapped, and gets no answer without being evaluated.
 *
 * | Codex call      | `MappedCall.tool`          | Channel                               |
 * |-----------------|----------------------------|---------------------------------------|
 * | `Bash`          | `Bash`                     | `full_command` = `tool_input.command` |
 * | `apply_patch`   | `Write` / `Edit` / `Delete`| `file_path`, one per path in the patch|
 * | `mcp__*`        | the tool name              | `full_command` = the serialized input |
 * | anything else   | —                          | nothing; no opinion, nothing read     |
 *
 * ── The command arrives RAW ──────────────────────────────────────────────────
 * Measured on codex-cli 0.154.0: `tool_input.command` is the command as the agent wrote
 * it, NOT the `/bin/zsh -lc '…'` wrapper Codex executes it through. So a shell rule
 * matches here exactly as it does on the other apps, with no unwrapping.
 *
 * The tool is named `Bash` on Windows too, where the shell is PowerShell. The label names
 * the channel, not the program, and shell rules are labelled `{Bash,PowerShell}`, so both
 * are evaluated the same way.
 *
 * ── An edit carries NO path field ────────────────────────────────────────────
 * Measured: a file edit arrives as `tool_name: "apply_patch"` with the whole patch text in
 * `tool_input.command` and no path field anywhere in the payload. The paths exist only
 * inside the patch, after `*** Add File:`, `*** Update File:`, `*** Delete File:` and
 * `*** Move to:`. So this mapper parses them itself, and a patch it cannot read a path
 * from is evaluated as nothing at all.
 *
 * `Add` is a write, `Update` and `Move to` are edits, `Delete` is a delete — the names the
 * other two mappers give those channels, so one guardrail reads the same on every app. An
 * `Update` followed by a `Move to` names two paths, the old and the new, and both are
 * evaluated: a rule guarding either end of a rename fires.
 *
 * ── Markers are read at COLUMN ZERO only ─────────────────────────────────────
 * A patch body's lines begin with `+`, `-` or a space, so a line of file CONTENT can spell
 * a marker. Trimming a line before looking at it would let that content name a path the
 * patch never touches — a file whose text happens to contain `*** Delete File: /etc/hosts`
 * would be judged as deleting it. Column zero is also what `apply_patch` itself requires,
 * so this reads the patch the way the tool does.
 *
 * ── The patch TEXT is never evaluated as a command ───────────────────────────
 * Only the paths are. Writing `rm -rf /` into a shell script is a write, not an execution,
 * and matching command rules against patch content would report it as one. This is the
 * same rule as "`Write` content is never read" in the other two mappers.
 *
 * ── MCP ──────────────────────────────────────────────────────────────────────
 * Codex names an MCP tool `mcp__<server>__<tool>`, which is already the shape `mapper.ts`
 * recognises, so the name passes through unchanged and the input is serialized and
 * middle-capped exactly as it is there, with the same serialization traps. NOT MEASURED:
 * no MCP server was configured on the machine the rest of this was measured on; the name
 * shape is read off Codex's source.
 *
 * ── Nothing else in the payload is read ──────────────────────────────────────
 * Not `cwd`, `session_id`, `transcript_path`, `model` or `tool_use_id`. In particular not
 * `permission_mode`, which is `bypassPermissions` under `codex exec` whether or not a
 * person is watching, so it says nothing about safety. A relative path stays relative: it
 * is never resolved against a directory.
 */

import { capEnd, capMiddle, safeStringify } from "./mapper.js";
import type { CodexHookPayload, MappedCall } from "./types.js";

/** The Codex events the guard answers. Every other event is left alone. */
export type CodexCheckedEvent = "PreToolUse" | "PermissionRequest";

/** At least one call to evaluate. */
export type CodexCandidates = readonly [MappedCall, ...MappedCall[]];

/** A Codex call, reduced to what the engine reads. */
export interface CodexCall {
  readonly event: CodexCheckedEvent;
  /**
   * What to evaluate. One entry per path named by an `apply_patch`, in the patch's own
   * order, so a tie keeps the path the patch mentioned first.
   */
  readonly candidates: CodexCandidates;
}

/** A patch marker, and the channel name the path it names is evaluated under. */
const PATCH_MARKERS: readonly { readonly marker: string; readonly tool: string }[] = [
  { marker: "*** Add File:", tool: "Write" },
  { marker: "*** Update File:", tool: "Edit" },
  { marker: "*** Move to:", tool: "Edit" },
  { marker: "*** Delete File:", tool: "Delete" },
];

/** The payload's `tool_input` as an object. Anything else is an empty one. */
function toolInput(payload: CodexHookPayload): Record<string, unknown> {
  return payload.tool_input !== null && typeof payload.tool_input === "object"
    ? (payload.tool_input as Record<string, unknown>)
    : {};
}

/**
 * The event this payload is, or `undefined` for one the guard does not answer.
 *
 * A payload with no readable `hook_event_name` is treated as `PreToolUse`: guard installs
 * on the two events below and nothing else, an edit really can arrive with no identity
 * field at all, and the alternative — silence — would switch enforcement off for a payload
 * that is otherwise complete. Any OTHER named event is left alone, because guard did not
 * ask to be there and the payload may not describe a tool call.
 */
function codexEvent(payload: CodexHookPayload): CodexCheckedEvent | undefined {
  const event = payload.hook_event_name;
  if (event === "PermissionRequest") return "PermissionRequest";
  if (event === "PreToolUse" || typeof event !== "string") return "PreToolUse";
  return undefined;
}

/**
 * The paths an `apply_patch` names, one candidate each. See "Markers" in the header.
 *
 * Total, and never throws. A patch naming no path yields an empty list, which is no
 * opinion rather than a guess. A trailing `\r` from a CRLF patch is trimmed off the path,
 * as is the space after the marker's colon; a path with spaces INSIDE it survives.
 *
 * Cost is linear in the patch's line count, and the evaluation that follows is linear in
 * the number of paths — a patch touching many files is checked once per file.
 */
export function patchCandidates(patch: string): MappedCall[] {
  const candidates: MappedCall[] = [];
  for (const line of patch.split("\n")) {
    for (const { marker, tool } of PATCH_MARKERS) {
      // `startsWith`, NOT a trim-then-match: a `+` line of file content must never be
      // able to spell a marker.
      if (!line.startsWith(marker)) continue;
      const filePath = line.slice(marker.length).trim();
      if (filePath !== "") candidates.push({ tool, args: { file_path: filePath } });
      break;
    }
  }
  return candidates;
}

/**
 * The key that makes ONE Codex action ONE decision-log line.
 *
 * `PreToolUse` and `PermissionRequest` both fire for a single action, in the same second,
 * and only the first carries a `tool_use_id` — so the usual key (`core/events.ts`) sees
 * two unrelated records and writes the line twice. Measured on codex-cli 0.154.0.
 *
 * `turn_id` is on both, and within one turn the tool and the command text identify the
 * action, so the two events produce the same key and the second is folded away. The key
 * is HASHED before it is stored (`core/events.ts`), so the command text it contains never
 * reaches disk, and it is never written to a log line.
 *
 * `undefined` when the payload carries no `turn_id` — an `apply_patch` can arrive without
 * one. The recorder then falls back to its content key inside a short window, which is the
 * pre-existing behaviour and still folds the pair in practice.
 *
 * Pure, and never throws.
 */
export function codexCallKey(payload: CodexHookPayload): string | undefined {
  const turnId = payload.turn_id;
  if (typeof turnId !== "string" || turnId === "") return undefined;
  const tool = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const input = toolInput(payload);
  const action = typeof input.command === "string" ? input.command : safeStringify(input);
  return `codex ${turnId} ${tool} ${capEnd(action)}`;
}

/**
 * Map a Codex payload to the calls to evaluate, or `undefined` when there is nothing to
 * evaluate — an event the guard does not answer, a tool it has no channel for, or a patch
 * naming no path.
 *
 * Total: never throws. A malformed payload for an answered event yields either no call at
 * all or a call with no channel, and both evaluate to no match.
 */
export function mapCodexCall(payload: CodexHookPayload): CodexCall | undefined {
  const event = codexEvent(payload);
  if (event === undefined) return undefined;

  const tool = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const input = toolInput(payload);

  if (tool === "Bash") {
    const args: { full_command?: string } = {};
    if (typeof input.command === "string") args.full_command = capEnd(input.command);
    return { event, candidates: [{ tool: "Bash", args }] };
  }
  if (tool === "apply_patch") {
    const patch = typeof input.command === "string" ? input.command : "";
    const [first, ...rest] = patchCandidates(patch);
    return first === undefined ? undefined : { event, candidates: [first, ...rest] };
  }
  if (tool.startsWith("mcp__")) {
    // Middle-truncated, as in `mapper.ts` — a batch call's tail stays visible.
    return {
      event,
      candidates: [{ tool, args: { full_command: capMiddle(safeStringify(input)) } }],
    };
  }

  // Anything else: no channel, and therefore no opinion. Codex has no read tool, so what
  // reaches here is a tool this build does not know — including the desktop app's
  // `shell_command`, which is stated as a limit rather than guessed at.
  return undefined;
}
