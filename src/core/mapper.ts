/**
 * Tool call → the two channels the engine can read.
 *
 * | Tool                                   | Channel        | Value                       |
 * |----------------------------------------|----------------|-----------------------------|
 * | `Bash`, `PowerShell`                   | `full_command` | `tool_input.command`        |
 * | `Edit`, `Write`, `Read`, `NotebookEdit`| `file_path`    | `file_path`/`notebook_path` |
 * | `WebSearch`                            | `full_command` | `tool_input.query`          |
 * | `mcp__*`                               | `full_command` | the serialized input        |
 *
 * ── There is no `url` channel, and `WebFetch` is NOT intercepted ──────────────
 * The engine reads only `detail` and `file_path` (`engine/matchers.ts`), and
 * `MatchConditionSchema` has no `url` field, so a `url` channel would be read by
 * nothing and a `WebFetch` rule would silently match nothing.
 *
 * The URL is deliberately NOT aliased onto the command channel: rules written for
 * commands would then be matched against URLs. The README states the gap instead.
 *
 * So `WebFetch` is absent from the matcher in `plugin/hooks/hooks.json` AND falls to
 * the unknown-tool branch here, which finds no `command` and no `file_path` and
 * yields no channel → `allow`. That omission is intentional.
 *
 * ── Truncation ────────────────────────────────────────────────────────────────
 * A command-channel value is capped at `MAX_DETAIL_LEN`. Shell commands, `WebSearch`
 * and the unknown-tool fallback keep the FIRST `MAX_DETAIL_LEN` chars (`capEnd`);
 * `mcp__*` keeps the head AND the tail (`capMiddle`), so a batch call's tail stays
 * visible.
 *
 * ── The MCP serialization traps, documented beside the mapper ─────────
 * 1. Key names match as TEXT — a rule containing `token` fires on any input with a
 *    field merely NAMED token.
 * 2. JSON escaping alters the bytes, so shell-syntax patterns do not transfer: a
 *    rule written for `rm -rf /` will not see the same string inside `{"cmd":"..."}`.
 * 3. The payload is capped, so without middle truncation a batch call's tail would be
 *    invisible.
 *
 * Path separators are NOT normalized here. That happens at span synthesis
 * (`normalize.ts`), before any matching.
 */

import type { MappedCall, PreToolUsePayload } from "./types.js";

/** Longest command-channel value handed to the engine. */
export const MAX_DETAIL_LEN = 8192;

/** Marker inserted where `capMiddle` removed the middle of an oversized payload. */
export const TRUNCATION_MARKER = "…[truncated]…";

/** Shell tools. Field-identical (`command`), so they share one branch. */
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

/**
 * File-operating tools whose path feeds `file_glob`.
 *
 * `MultiEdit` is not among the hooks matcher's literal alternatives but STAYS
 * classified here: `Edit` substring-matches `MultiEdit` under `RegExp.prototype.test`,
 * so such a call is still intercepted, and this entry is what keeps it a file tool
 * instead of dropping to the fallback below (which carries a command channel too).
 */
const FILE_TOOLS = new Set(["Edit", "Write", "Read", "MultiEdit", "NotebookEdit"]);

/** Keep the FIRST `MAX_DETAIL_LEN` chars. */
export function capEnd(s: string): string {
  return s.length > MAX_DETAIL_LEN ? s.slice(0, MAX_DETAIL_LEN) : s;
}

/**
 * Keep the head AND the tail, dropping the middle (MCP only).
 *
 * A batch MCP call puts its most interesting content last as often as first, and an
 * end cap would drop that tail silently. The marker makes the loss visible in the
 * matched text rather than implied.
 */
export function capMiddle(s: string): string {
  if (s.length <= MAX_DETAIL_LEN) return s;
  const budget = MAX_DETAIL_LEN - TRUNCATION_MARKER.length;
  const head = Math.ceil(budget / 2);
  const tail = budget - head;
  return `${s.slice(0, head)}${TRUNCATION_MARKER}${s.slice(s.length - tail)}`;
}

/** `JSON.stringify` that cannot throw (cycles, BigInt) — returns "" instead. */
export function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

/**
 * Map a `PreToolUse` payload to `{tool, args}`.
 *
 * Total: never throws, and an unrecognized or malformed payload yields no channel,
 * which evaluates to `allow`. Fail-open starts here.
 */
export function mapToolCall(payload: PreToolUsePayload): MappedCall {
  const tool = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const input =
    payload.tool_input !== null && typeof payload.tool_input === "object"
      ? (payload.tool_input as Record<string, unknown>)
      : {};
  const args: { full_command?: string; file_path?: string } = {};

  if (SHELL_TOOLS.has(tool)) {
    if (typeof input.command === "string") args.full_command = capEnd(input.command);
  } else if (FILE_TOOLS.has(tool)) {
    const fp = input.file_path ?? input.notebook_path;
    if (typeof fp === "string") args.file_path = fp;
  } else if (tool === "WebSearch") {
    if (typeof input.query === "string") args.full_command = capEnd(input.query);
  } else if (tool.startsWith("mcp__")) {
    // Middle-truncated, unlike every other channel — see the header.
    args.full_command = capMiddle(safeStringify(input));
  } else {
    // Unknown/other built-in — including `WebFetch`, deliberately. Best-effort:
    // carry a command and/or a file path if the payload happens to have one.
    if (typeof input.command === "string") args.full_command = capEnd(input.command);
    if (typeof input.file_path === "string") args.file_path = input.file_path;
  }

  return { tool, args };
}
