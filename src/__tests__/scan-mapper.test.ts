/**
 * `core/transcripts.ts` — a transcript tool call and a live hook payload must map to
 * the SAME `MappedCall`.
 *
 * This is the claim `scan` rests on: "a rule behaves identically in `scan` and in
 * `hook`". If it drifts, the report advertises enforcement behavior the product does
 * not have — a finding that says a rule would have fired on a command the hook would
 * have allowed, or the reverse, and neither is visible from either side alone.
 *
 * The tests below construct the payload TWICE — once out of a transcript `ToolUse`,
 * once as the raw stdin object Claude Code sends — and assert `mapToolCall` produces
 * identical output. The interesting cases are the ones where `mapToolCall` does
 * something non-obvious: the 8192-char end cap on a shell command, MIDDLE truncation
 * for `mcp__*`, and the unknown-tool fallback that makes `WebFetch` produce no channel.
 */

import { describe, expect, it } from "vitest";
import { MAX_DETAIL_LEN, mapToolCall, TRUNCATION_MARKER } from "../core/mapper.js";
import { toolCallPayload, toolCallsOf } from "../core/transcripts.js";
import type { PreToolUsePayload } from "../core/types.js";
import { bash, session, toolUse, turn } from "./scan-fixtures.js";

/** The payload Claude Code puts on the hook's stdin for this tool call. */
function livePayload(name: string, input: Record<string, unknown>): PreToolUsePayload {
  return JSON.parse(JSON.stringify({ tool_name: name, tool_input: input }));
}

describe("a transcript tool call maps exactly like a live hook payload", () => {
  it.each([
    ["Bash", { command: "rm -rf /tmp/x" }],
    ["PowerShell", { command: "Remove-Item -Recurse C:\\tmp" }],
    ["Edit", { file_path: "/srv/app/.env" }],
    ["Write", { file_path: "/srv/app/config.json" }],
    ["Read", { file_path: "/srv/app/.env.production" }],
    ["NotebookEdit", { notebook_path: "/srv/app/x.ipynb" }],
    ["WebSearch", { query: "how to drop a table" }],
    ["mcp__linear__createIssue", { title: "x", token: "abc" }],
    ["WebFetch", { url: "https://example.com" }],
    ["SomeFutureTool", { command: "echo hi", file_path: "/srv/a" }],
    ["Bash", {}],
  ])("%s", (name, input) => {
    const fromTranscript = mapToolCall(toolCallPayload(toolUse(name, input)));
    const fromHook = mapToolCall(livePayload(name, input));
    expect(fromTranscript).toEqual(fromHook);
  });

  it("WebFetch yields NO channel on both sides — the documented non-interception", () => {
    // Asserted rather than assumed: `mapToolCall`'s unknown-tool branch looks for a
    // `command` and a `file_path`, and a WebFetch payload has neither. Both sides
    // producing `{}` is what makes "the guard does not intercept WebFetch" true in a
    // scan as well as in the hook.
    const mapped = mapToolCall(toolCallPayload(toolUse("WebFetch", { url: "https://x.test/a" })));
    expect(mapped.args).toEqual({});
  });

  it("an oversized shell command is END-capped identically on both sides", () => {
    const input = { command: `rm -rf ${"a".repeat(MAX_DETAIL_LEN * 2)}` };
    const fromTranscript = mapToolCall(toolCallPayload(toolUse("Bash", input)));
    expect(fromTranscript).toEqual(mapToolCall(livePayload("Bash", input)));
    expect(fromTranscript.args.full_command).toHaveLength(MAX_DETAIL_LEN);
    expect(fromTranscript.args.full_command).not.toContain(TRUNCATION_MARKER);
  });

  it("an oversized MCP payload is MIDDLE-truncated identically on both sides", () => {
    const input = { blob: "b".repeat(MAX_DETAIL_LEN * 2), tail: "THE-END" };
    const fromTranscript = mapToolCall(toolCallPayload(toolUse("mcp__x__y", input)));
    expect(fromTranscript).toEqual(mapToolCall(livePayload("mcp__x__y", input)));
    expect(fromTranscript.args.full_command).toContain(TRUNCATION_MARKER);
    expect(fromTranscript.args.full_command).toContain("THE-END");
  });
});

describe("walking a session", () => {
  it("yields every tool call in every turn, in transcript order", () => {
    const parsed = session([
      turn([bash("one", "1"), bash("two", "2")]),
      turn([bash("three", "3")]),
    ]);
    expect(toolCallsOf(parsed).map((p) => (p.tool_input as { command: string }).command)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("a session with no tool calls yields none, and does not throw", () => {
    expect(toolCallsOf(session([turn([])]))).toEqual([]);
    expect(toolCallsOf(session([]))).toEqual([]);
  });
});
