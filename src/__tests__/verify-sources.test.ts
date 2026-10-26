/**
 * What the secrets check reads from each transcript line (`core/verify/sources.ts`), one case
 * per record shape, for each app — and what it leaves alone.
 */

import { describe, expect, it } from "vitest";
import { lineText } from "../core/verify/sources.js";
import { UNAVAILABLE_VERIFY_IO } from "../core/verify/verify.js";

/** The pieces of one line as `via: text` strings. */
function pieces(agent: "claude" | "codex" | "cursor", record: unknown): string[] {
  return lineText(agent, JSON.stringify(record)).pieces.map((p) => `${p.via}: ${p.text}`);
}

describe("Claude Code lines", () => {
  it("a prompt as a string or text blocks", () => {
    expect(pieces("claude", { type: "user", message: { content: "p1" } })).toEqual([
      "pasted-into-prompt: p1",
    ]);
    expect(
      pieces("claude", { type: "user", message: { content: [{ type: "text", text: "p2" }, "x"] } }),
    ).toEqual(["pasted-into-prompt: p2"]);
  });

  it("a tool result, as a string or blocks, and its structured copy", () => {
    expect(
      pieces("claude", {
        type: "user",
        toolUseResult: { stdout: "o2", nested: ["o3", { deeper: "o4" }], n: 1 },
        message: {
          content: [
            { type: "tool_result", content: "o1" },
            { type: "tool_result", content: [{ type: "text", text: "o5" }, { type: "image" }] },
          ],
        },
      }),
    ).toEqual([
      "printed-by-command: o1",
      "printed-by-command: o5",
      "printed-by-command: o2",
      "printed-by-command: o3",
      "printed-by-command: o4",
    ]);
  });

  it("a reply, its reasoning, and a tool call's whole input", () => {
    expect(
      pieces("claude", {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "r1" },
            { type: "thinking", thinking: "r2" },
            { type: "tool_use", input: { command: "c1", env: { A: "c2" } } },
            "not a block",
          ],
        },
      }),
    ).toEqual([
      "in-agent-reply: r1",
      "in-agent-reply: r2",
      "typed-into-command: c1",
      "typed-into-command: c2",
    ]);
  });

  it("the working directory a line names", () => {
    expect(lineText("claude", JSON.stringify({ type: "summary", cwd: "/w" })).workingDirs).toEqual([
      "/w",
    ]);
  });

  it("nothing else: ids, models, a summary, an assistant line with no block list", () => {
    expect(
      pieces("claude", { type: "summary", summary: "s", uuid: "u", message: { model: "m" } }),
    ).toEqual([]);
    expect(pieces("claude", { type: "assistant", message: { content: "plain" } })).toEqual([]);
  });
});

describe("Codex lines", () => {
  const item = (payload: Record<string, unknown>) => ({ type: "response_item", payload });
  const event = (payload: Record<string, unknown>) => ({ type: "event_msg", payload });

  it.each([
    [item({ type: "message", role: "user", content: [{ text: "p" }] }), ["pasted-into-prompt: p"]],
    [item({ type: "message", role: "assistant", content: [{ text: "r" }] }), ["in-agent-reply: r"]],
    [item({ type: "message", role: "developer", content: [{ text: "d" }] }), []],
    [
      item({ type: "reasoning", summary: [{ text: "s" }], content: [{ text: "t" }] }),
      ["in-agent-reply: s", "in-agent-reply: t"],
    ],
    [item({ type: "custom_tool_call", input: "i" }), ["typed-into-command: i"]],
    [item({ type: "function_call", arguments: "a" }), ["typed-into-command: a"]],
    [item({ type: "custom_tool_call_output", output: [{ text: "o" }] }), ["printed-by-command: o"]],
    [item({ type: "function_call_output", output: "f" }), ["printed-by-command: f"]],
    [item({ type: "other" }), []],
    [event({ type: "user_message", message: "u" }), ["pasted-into-prompt: u"]],
    [event({ type: "agent_message", message: "m" }), ["in-agent-reply: m"]],
    [
      event({ type: "exec_command_end", aggregated_output: "x", stdout: "y", stderr: "z" }),
      ["printed-by-command: x", "printed-by-command: y", "printed-by-command: z"],
    ],
    [
      event({ type: "item_completed", item: { type: "CommandExecution", aggregated_output: "c" } }),
      ["printed-by-command: c"],
    ],
    [event({ type: "item_completed", item: { type: "FileChange" } }), []],
    [event({ type: "item_completed" }), []],
    [event({ type: "task_started" }), []],
    [{ type: "token_usage_record", payload: { usage: {} } }, []],
    [{ type: "response_item" }, []],
  ])("%j", (record, expected) => {
    expect(pieces("codex", record)).toEqual(expected);
  });

  it("the working directory from session_meta and turn_context", () => {
    for (const type of ["session_meta", "turn_context"]) {
      expect(lineText("codex", JSON.stringify({ type, payload: { cwd: "/w" } }))).toEqual({
        pieces: [],
        workingDirs: ["/w"],
      });
    }
  });
});

describe("Cursor lines", () => {
  it("a prompt, a reply and a tool call's input", () => {
    expect(
      pieces("cursor", { role: "user", message: { content: [{ type: "text", text: "p" }] } }),
    ).toEqual(["pasted-into-prompt: p"]);
    expect(
      pieces("cursor", {
        role: "assistant",
        message: {
          content: [{ type: "text", text: "r" }, { type: "tool_use", input: { command: "c" } }, 7],
        },
      }),
    ).toEqual(["in-agent-reply: r", "typed-into-command: c"]);
  });

  it("nothing from a turn marker or a record with no message", () => {
    expect(pieces("cursor", { type: "turn_ended", status: "success" })).toEqual([]);
    expect(pieces("cursor", { role: "assistant", message: { content: "plain" } })).toEqual([]);
  });
});

describe("any app", () => {
  it.each(["", "   ", "not json", "[1,2]", "null", '"text"'])("gives nothing for %j", (line) => {
    for (const agent of ["claude", "codex", "cursor"] as const) {
      expect(lineText(agent, line)).toEqual({ pieces: [], workingDirs: [] });
    }
  });

  it("bounds the strings it takes from one deep value", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 100; i++) deep = { next: deep };
    expect(
      pieces("claude", {
        type: "assistant",
        message: { content: [{ type: "tool_use", input: deep }] },
      }),
    ).toEqual([]);
    const wide = Array.from({ length: 20_000 }, (_, i) => `s${i}`);
    expect(
      pieces("claude", {
        type: "assistant",
        message: { content: [{ type: "tool_use", input: wide }] },
      }),
    ).toHaveLength(10_000);
  });
});

describe("the seam with no machine behind it", () => {
  it("fails every call as missing, so nothing reads as checked", async () => {
    expect(await UNAVAILABLE_VERIFY_IO.git("/r", ["ls-files", "-z"])).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(UNAVAILABLE_VERIFY_IO.isDirectory("/r")).toBeUndefined();
    expect(await UNAVAILABLE_VERIFY_IO.readFile("/r/a")).toEqual({ ok: false, reason: "missing" });
    expect(await UNAVAILABLE_VERIFY_IO.processNames()).toEqual({ ok: false, reason: "missing" });
  });
});
