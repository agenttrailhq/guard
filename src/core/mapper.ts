/**
 * Tool call → the two channels the engine can read.
 *
 * | Tool                                   | Channel        | Value                       |
 * |----------------------------------------|----------------|-----------------------------|
 * | `Bash`, `PowerShell`                   | `full_command` | `tool_input.command`        |
 * | `Edit`, `Write`, `Read`, `NotebookEdit`| `file_path`    | `file_path`/`notebook_path` |
 * | `Grep`, `Glob`                         | `file_path`    | the searched path, see below|
 * | `WebSearch`                            | `full_command` | `tool_input.query`          |
 * | `mcp__*`                               | `full_command` | the serialized input        |
 *
 * ── Search reads files, so `Grep` and `Glob` are file tools ──────────────────
 * Both were absent from the matcher in `plugin/hooks/hooks.json` and fell to the
 * unknown-tool branch, which finds no `command` and no `file_path` and yields no channel.
 * So a guardrail on `**​/.env` stopped `Read` on the file and said nothing about
 * `Grep` `-n AWS_SECRET --glob .env` over the folder that holds it — the same content,
 * through a tool nobody was checking. Cursor's mapper already intercepts its `Grep`; this
 * is the Claude Code half of the same hole.
 *
 * The searched path is the FOLDER and the GLOB joined, most specific form only, because
 * this mapper yields one call: `path` + `glob` (`Grep`) or `path` + `pattern` (`Glob`).
 * `Grep`'s own `pattern` is the regex it searches file CONTENT for and is never read as a
 * path. A folder with no glob is evaluated as the folder.
 *
 * Residual, stated rather than discovered: with both a folder and a glob, only the joined
 * form is evaluated, so a rule written against the bare folder does not fire on a search
 * that narrowed to a glob inside it. Cursor's mapper evaluates both forms because its
 * path carries candidates (`cursor-mapper.ts`); the Claude Code hook path does not.
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

/**
 * Search tools, and which of their fields holds the GLOB.
 *
 * Two different fields, which is why this is a map and not a set. `Glob`'s `pattern` is
 * the glob itself; `Grep`'s `pattern` is a regular expression matched against file
 * contents, and reading it as a path would evaluate a user's search string against file
 * rules — noise at best, and a rule matching on it would block a read of nothing.
 */
const SEARCH_GLOB_FIELD = new Map([
  ["Grep", "glob"],
  ["Glob", "pattern"],
]);

/** The value when it is a non-empty string. An empty string counts as absent. */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * A glob rooted at `/`, `\`, or a drive letter, which a folder cannot prefix.
 *
 * Shared with `cursor-mapper.ts` so the two mappers cannot disagree about what "already
 * absolute" means.
 */
export function isAbsoluteGlob(glob: string): boolean {
  return /^(?:[\\/]|[A-Za-z]:[\\/])/.test(glob);
}

/** A folder and a relative glob, with exactly one `/` between them. Shared, as above. */
export function joinSearchPath(dir: string, glob: string): string {
  return `${dir.replace(/[\\/]+$/, "")}/${glob}`;
}

/**
 * The path a search actually reaches: the folder narrowed by the glob, when there is one.
 *
 * Total, and never throws. `undefined` when the payload names neither — which yields no
 * channel and therefore no opinion, as an unmapped tool does.
 */
function searchPath(tool: string, input: Record<string, unknown>): string | undefined {
  const field = SEARCH_GLOB_FIELD.get(tool);
  const dir = nonEmpty(input.path);
  const glob = field === undefined ? undefined : nonEmpty(input[field]);
  if (glob === undefined) return dir;
  if (dir === undefined || isAbsoluteGlob(glob)) return glob;
  return joinSearchPath(dir, glob);
}

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
  } else if (SEARCH_GLOB_FIELD.has(tool)) {
    const fp = searchPath(tool, input);
    if (fp !== undefined) args.file_path = fp;
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
