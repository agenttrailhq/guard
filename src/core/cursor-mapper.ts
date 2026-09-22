/**
 * Cursor hook payload → the calls the engine evaluates.
 *
 * Two of Cursor's events are checked. `preToolUse` fires before an agent tool call;
 * `beforeShellExecution` fires before a terminal command, after `preToolUse` has let it
 * through. Any other event is not mapped, and gets no opinion without being evaluated.
 *
 * | Cursor call                             | `MappedCall.tool`     | Channel                               |
 * |-----------------------------------------|-----------------------|---------------------------------------|
 * | `preToolUse` `Shell`                    | `Bash`                | `full_command` = `tool_input.command` |
 * | `beforeShellExecution`                  | `Bash`                | `full_command` = `command`            |
 * | `preToolUse` `Read`, `Write`, `Delete`  | the same name         | `file_path` = `tool_input.file_path`  |
 * | `preToolUse` `Grep`                     | `Grep`                | `file_path`, see "Grep" below         |
 * | `preToolUse` `MCP:<tool>`               | `mcp__cursor__<tool>` | `full_command` = the serialized input |
 * | `preToolUse`, any other tool            | the tool name         | `command` and `file_path`, if present |
 *
 * ── `Shell` is evaluated as `Bash` ───────────────────────────────────────────
 * Shell rules are labelled `{Bash,PowerShell}`. The label names the channel, not the app,
 * so a Cursor terminal command is evaluated as a `Bash` call and every shell rule applies
 * unchanged.
 *
 * ── `Write` content is never read ────────────────────────────────────────────
 * Only the path is evaluated. File rules match paths, and the content can be a whole file.
 *
 * ── Grep ─────────────────────────────────────────────────────────────────────
 * File rules match the WHOLE path. A search's folder alone (`/home/user/project`) matches
 * no file rule, so a search for `.env` files under it would pass unseen. A `Grep` with a
 * glob is therefore evaluated as up to two candidates, most specific first:
 *
 *   folder and a relative glob   → [`<folder>/<glob>`, `<folder>`]
 *   folder only                  → [`<folder>`]
 *   glob only, or an absolute glob → [`<glob>`]
 *
 * An empty string counts as absent: Cursor sends `""` where it has no value (its `cwd`
 * is `""`), and `""` joined to a glob would read as the filesystem root. A brace glob
 * (`{.env,.env.local}`) is not expanded, and the search `pattern` is not read: no rule
 * matches file contents.
 *
 * ── MCP ──────────────────────────────────────────────────────────────────────
 * `preToolUse` names an MCP tool `MCP:<tool>` and carries no server name, so the call is
 * labelled `mcp__cursor__<tool>`. The input is serialized and middle-capped, as `mapper.ts`
 * treats `mcp__*`, with the same serialization traps.
 *
 * ── Nothing else in the payload is read ──────────────────────────────────────
 * Not `cwd`, `tool_use_id`, `sandbox`, the workspace folders or the account. A relative
 * path stays relative: it is never resolved against a directory.
 */

import { capEnd, capMiddle, isAbsoluteGlob, joinSearchPath, safeStringify } from "./mapper.js";
import type { CursorHookPayload, MappedCall } from "./types.js";

/** The Cursor events the guard evaluates. Every other event gets no opinion. */
export type CursorCheckedEvent = "preToolUse" | "beforeShellExecution";

/** At least one call to evaluate. */
export type CursorCandidates = readonly [MappedCall, ...MappedCall[]];

/** A Cursor call, reduced to what the engine reads. */
export interface CursorCall {
  readonly event: CursorCheckedEvent;
  /** Cursor's own tool name at `preToolUse` (`Shell`, `Read`, …); `""` at `beforeShellExecution`. */
  readonly cursorTool: string;
  /**
   * What to evaluate, most specific first. Two entries only for a `Grep` with both a folder
   * and a relative glob.
   */
  readonly candidates: CursorCandidates;
}

/** Cursor's prefix for an MCP tool at `preToolUse`. */
const MCP_PREFIX = "MCP:";

/** Cursor tools whose `tool_input.file_path` feeds `file_glob`. */
const CURSOR_FILE_TOOLS = new Set(["Read", "Write", "Delete"]);

/** The value when it is a non-empty string. */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The paths a `Grep` is evaluated on. See "Grep" in the header.
 *
 * Pure, and never throws.
 */
export function grepCandidates(folder: unknown, glob: unknown): CursorCandidates {
  const dir = nonEmpty(folder);
  const pattern = nonEmpty(glob);
  if (pattern !== undefined && (dir === undefined || isAbsoluteGlob(pattern))) {
    return [{ tool: "Grep", args: { file_path: pattern } }];
  }
  if (dir === undefined) return [{ tool: "Grep", args: {} }];
  if (pattern === undefined) return [{ tool: "Grep", args: { file_path: dir } }];
  // One `/` between the two, whatever separator the folder ended with. Shared with
  // `mapper.ts`, which joins a Claude Code `Grep`/`Glob` the same way.
  const joined = joinSearchPath(dir, pattern);
  return [
    { tool: "Grep", args: { file_path: joined } },
    { tool: "Grep", args: { file_path: dir } },
  ];
}

/**
 * Map a Cursor payload to the calls to evaluate, or `undefined` for an event the guard
 * does not check.
 *
 * Total: never throws. A malformed payload for a checked event yields a call with no
 * channel, which evaluates to no match.
 */
export function mapCursorCall(payload: CursorHookPayload): CursorCall | undefined {
  const event = payload.hook_event_name;

  if (event === "beforeShellExecution") {
    const args: { full_command?: string } = {};
    if (typeof payload.command === "string") args.full_command = capEnd(payload.command);
    return { event, cursorTool: "", candidates: [{ tool: "Bash", args }] };
  }
  if (event !== "preToolUse") return undefined;

  const cursorTool = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const input =
    payload.tool_input !== null && typeof payload.tool_input === "object"
      ? (payload.tool_input as Record<string, unknown>)
      : {};
  const call = (candidates: CursorCandidates): CursorCall => ({ event, cursorTool, candidates });

  if (cursorTool === "Shell") {
    const args: { full_command?: string } = {};
    if (typeof input.command === "string") args.full_command = capEnd(input.command);
    return call([{ tool: "Bash", args }]);
  }
  if (CURSOR_FILE_TOOLS.has(cursorTool)) {
    const args: { file_path?: string } = {};
    if (typeof input.file_path === "string") args.file_path = input.file_path;
    return call([{ tool: cursorTool, args }]);
  }
  if (cursorTool === "Grep") {
    return call(grepCandidates(input.file_path, input.glob));
  }
  if (cursorTool.startsWith(MCP_PREFIX)) {
    // A string input is already serialized; anything else is serialized here.
    const raw = typeof payload.tool_input === "string" ? payload.tool_input : safeStringify(input);
    return call([
      {
        tool: `mcp__cursor__${cursorTool.slice(MCP_PREFIX.length)}`,
        args: { full_command: capMiddle(raw) },
      },
    ]);
  }

  // Any other tool: carry a command and a file path if the payload happens to have them.
  const args: { full_command?: string; file_path?: string } = {};
  if (typeof input.command === "string") args.full_command = capEnd(input.command);
  if (typeof input.file_path === "string") args.file_path = input.file_path;
  return call([{ tool: cursorTool, args }]);
}
