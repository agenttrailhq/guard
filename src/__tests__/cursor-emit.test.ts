/**
 * `buildCursorAnswer` — Cursor's answer for a verdict, and whether this checkpoint logs it.
 *
 * One test per combination the answer depends on: the app whose hook entry launched the
 * guard, the Cursor event, whether the tool is `Shell`, and the verdict. Also the emitter,
 * which writes the answer, and `strictestCandidate`, which picks the verdict a `Grep`
 * with two candidates is answered with.
 */

import { describe, expect, it } from "vitest";
import {
  agentMessage,
  buildCursorAnswer,
  CURSOR_APPROVAL_LEAD,
  type CursorAnswerInput,
  createCursorEmitter,
  cursorApprovalMessage,
  type EvaluatedCandidate,
  NO_OPINION,
  RELAY_INSTRUCTION,
  strictestCandidate,
} from "../core/cursor-emit.js";
import type { CursorCheckedEvent } from "../core/cursor-mapper.js";
import type { AgentSource, GuardDecision } from "../core/types.js";

const BLOCK: GuardDecision = {
  decision: "deny",
  reason: "agenttrail-guard blocked this: Block the test command (guardrail t.block)",
  matches: [{ ruleId: "t.block", action: "block" }],
};
const APPROVAL: GuardDecision = {
  decision: "ask",
  reason:
    "agenttrail-guard needs a person to approve this: Ask about the test command (guardrail t.ask)",
  matches: [{ ruleId: "t.ask", action: "require_approval" }],
};
const WARNING: GuardDecision = {
  decision: "allow",
  reason: "agenttrail-guard is warning about this: Warn about the test command (guardrail t.warn)",
  matches: [{ ruleId: "t.warn", action: "warn" }],
};
const NO_MATCH: GuardDecision = { decision: "allow", reason: "", matches: [] };

const EVENTS: readonly CursorCheckedEvent[] = ["preToolUse", "beforeShellExecution"];
const TOOLS = ["Shell", "Read", "Write", "Grep", "Delete", "MCP:echo", "Task", ""] as const;
const NON_SHELL_TOOLS = TOOLS.filter((tool) => tool !== "Shell");

/**
 * The relay instruction, written out here rather than imported, so that changing its
 * wording in `core/cursor-emit.ts` fails this file instead of passing silently.
 */
const RELAY =
  ". Relay this to the user verbatim, naming agenttrail-guard and the guardrail, and do not work around it.";

/**
 * A deny or an ask, as Cursor reads it.
 *
 * The user's sentence, and the agent's copy of it — the same sentence plus the relay
 * instruction. The two fields are never the same string.
 */
function permission(kind: "deny" | "ask", message: string): Record<string, string> {
  return { permission: kind, user_message: message, agent_message: `${message}${RELAY}` };
}

/**
 * The approval deny for `APPROVAL`, written out in full.
 *
 * The lead is REPLACED, not prefixed: the guardrail's title and id are carried over
 * unchanged, and the sentence says once — not twice — that a person has to approve.
 */
const APPROVAL_DENY = permission(
  "deny",
  "agenttrail-guard needs a person to approve this, and Cursor cannot ask: Ask about the test command (guardrail t.ask)",
);

/** Build an answer and parse its output, which must be exactly one JSON object. */
function answer(
  input: Pick<CursorAnswerInput, "event" | "decision"> & Partial<CursorAnswerInput>,
): { output: unknown; record: boolean } {
  const result = buildCursorAnswer({ launchedAs: "cursor", tool: "", ...input });
  expect(result.output.startsWith("{")).toBe(true);
  expect(result.output.endsWith("}")).toBe(true);
  return { output: JSON.parse(result.output), record: result.record };
}

describe("launched by guard's Cursor entry", () => {
  it("preToolUse Shell, block → deny, logged", () => {
    expect(answer({ event: "preToolUse", tool: "Shell", decision: BLOCK })).toEqual({
      output: permission("deny", BLOCK.reason),
      record: true,
    });
  });

  it("preToolUse Shell, approval → {}, not logged: beforeShellExecution asks and logs it", () => {
    expect(answer({ event: "preToolUse", tool: "Shell", decision: APPROVAL })).toEqual({
      output: {},
      record: false,
    });
  });

  it("preToolUse Shell, warning → {}, logged", () => {
    expect(answer({ event: "preToolUse", tool: "Shell", decision: WARNING })).toEqual({
      output: {},
      record: true,
    });
  });

  it("preToolUse Read, block → deny, logged", () => {
    expect(answer({ event: "preToolUse", tool: "Read", decision: BLOCK })).toEqual({
      output: permission("deny", BLOCK.reason),
      record: true,
    });
  });

  it("preToolUse Write, approval → deny with the approval message, logged", () => {
    expect(answer({ event: "preToolUse", tool: "Write", decision: APPROVAL })).toEqual({
      output: APPROVAL_DENY,
      record: true,
    });
  });

  it("preToolUse Grep, warning → {}, logged", () => {
    expect(answer({ event: "preToolUse", tool: "Grep", decision: WARNING })).toEqual({
      output: {},
      record: true,
    });
  });

  it("beforeShellExecution, block → deny, logged", () => {
    expect(answer({ event: "beforeShellExecution", decision: BLOCK })).toEqual({
      output: permission("deny", BLOCK.reason),
      record: true,
    });
  });

  it("beforeShellExecution, approval → ask, logged", () => {
    expect(answer({ event: "beforeShellExecution", decision: APPROVAL })).toEqual({
      output: permission("ask", APPROVAL.reason),
      record: true,
    });
  });

  it("beforeShellExecution, warning → {}, not logged: preToolUse logged it", () => {
    expect(answer({ event: "beforeShellExecution", decision: WARNING })).toEqual({
      output: {},
      record: false,
    });
  });

  it.each(NON_SHELL_TOOLS)("preToolUse %j answers as a non-shell tool", (tool) => {
    expect(answer({ event: "preToolUse", tool, decision: BLOCK })).toEqual({
      output: permission("deny", BLOCK.reason),
      record: true,
    });
    expect(answer({ event: "preToolUse", tool, decision: APPROVAL })).toEqual({
      output: APPROVAL_DENY,
      record: true,
    });
    expect(answer({ event: "preToolUse", tool, decision: WARNING })).toEqual({
      output: {},
      record: true,
    });
  });

  it.each(TOOLS)("beforeShellExecution does not read the tool name (%j)", (tool) => {
    for (const decision of [BLOCK, APPROVAL, WARNING, NO_MATCH]) {
      expect(answer({ event: "beforeShellExecution", tool, decision })).toEqual(
        answer({ event: "beforeShellExecution", tool: "", decision }),
      );
    }
  });

  it("does not read cursorEntryPresent", () => {
    for (const event of EVENTS) {
      for (const tool of TOOLS) {
        for (const decision of [BLOCK, APPROVAL, WARNING, NO_MATCH]) {
          const base = answer({ event, tool, decision });
          expect(answer({ event, tool, decision, cursorEntryPresent: true })).toEqual(base);
          expect(answer({ event, tool, decision, cursorEntryPresent: false })).toEqual(base);
        }
      }
    }
  });

  it("no match → {} and nothing logged, for every event and tool", () => {
    for (const event of EVENTS) {
      for (const tool of TOOLS) {
        expect(answer({ event, tool, decision: NO_MATCH })).toEqual({ output: {}, record: false });
      }
    }
  });
});

describe("launched by guard's Claude Code plugin, with a Cursor call", () => {
  const claude = (decision: GuardDecision, cursorEntryPresent?: boolean) =>
    answer({
      launchedAs: "claude",
      event: "preToolUse",
      tool: "Shell",
      decision,
      cursorEntryPresent,
    });

  it("block → deny either way; logged only when guard's Cursor entry is absent", () => {
    expect(claude(BLOCK, false)).toEqual({
      output: permission("deny", BLOCK.reason),
      record: true,
    });
    expect(claude(BLOCK, true)).toEqual({
      output: permission("deny", BLOCK.reason),
      record: false,
    });
  });

  it("approval → the approval deny when the entry is absent, {} when present", () => {
    expect(claude(APPROVAL, false)).toEqual({ output: APPROVAL_DENY, record: true });
    expect(claude(APPROVAL, true)).toEqual({ output: {}, record: false });
  });

  it("warning → {}; logged only when the entry is absent", () => {
    expect(claude(WARNING, false)).toEqual({ output: {}, record: true });
    expect(claude(WARNING, true)).toEqual({ output: {}, record: false });
  });

  it("an unknown entry state counts as absent", () => {
    for (const decision of [BLOCK, APPROVAL, WARNING, NO_MATCH]) {
      expect(claude(decision, undefined)).toEqual(claude(decision, false));
    }
  });

  it("no match → {} and nothing logged, either way", () => {
    expect(claude(NO_MATCH, false)).toEqual({ output: {}, record: false });
    expect(claude(NO_MATCH, true)).toEqual({ output: {}, record: false });
  });

  it("the answer does not depend on the event or the tool", () => {
    for (const event of EVENTS) {
      for (const tool of TOOLS) {
        for (const decision of [BLOCK, APPROVAL, WARNING, NO_MATCH]) {
          for (const cursorEntryPresent of [true, false]) {
            expect(
              answer({ launchedAs: "claude", event, tool, decision, cursorEntryPresent }),
            ).toEqual(claude(decision, cursorEntryPresent));
          }
        }
      }
    }
  });
});

describe("the shape of every answer", () => {
  const LAUNCHERS: readonly AgentSource[] = ["cursor", "claude"];

  it("is {} or a deny or an ask with matching messages, and never allow", () => {
    let checked = 0;
    for (const launchedAs of LAUNCHERS) {
      for (const event of EVENTS) {
        for (const tool of TOOLS) {
          for (const decision of [BLOCK, APPROVAL, WARNING, NO_MATCH]) {
            for (const cursorEntryPresent of [true, false, undefined]) {
              const { output } = buildCursorAnswer({
                launchedAs,
                event,
                tool,
                decision,
                cursorEntryPresent,
              });
              checked += 1;
              expect(output).not.toMatch(/allow/);
              expect(output).not.toMatch(/hookSpecificOutput|systemMessage/);
              if (output === NO_OPINION) continue;
              const parsed = JSON.parse(output);
              expect(Object.keys(parsed)).toEqual(["permission", "user_message", "agent_message"]);
              expect(["deny", "ask"]).toContain(parsed.permission);
              // The agent's copy is the user's sentence plus the relay instruction, so the
              // two fields always DIFFER, and both still name the product and the guardrail.
              expect(parsed.agent_message).not.toBe(parsed.user_message);
              expect(parsed.agent_message).toBe(`${parsed.user_message}${RELAY}`);
              expect(parsed.user_message).not.toBe("");
              for (const text of [parsed.user_message, parsed.agent_message]) {
                expect(String(text)).toContain("agenttrail-guard");
                expect(String(text)).toMatch(/\(guardrail [\w.-]+\)/);
                expect(String(text).split("\n")).toHaveLength(1);
              }
            }
          }
        }
      }
    }
    expect(checked).toBe(2 * EVENTS.length * TOOLS.length * 4 * 3);
  });

  it("no opinion is exactly {}", () => {
    expect(NO_OPINION).toBe("{}");
  });

  it("the approval message names the product, Cursor's limit, and the guardrail", () => {
    expect(CURSOR_APPROVAL_LEAD).toBe(
      "agenttrail-guard needs a person to approve this, and Cursor cannot ask: ",
    );
    expect(APPROVAL_DENY.user_message).toBe(cursorApprovalMessage(APPROVAL.reason));
    expect(APPROVAL_DENY.user_message).toContain("(guardrail t.ask)");
  });

  it("says a person has to approve ONCE, not twice", () => {
    // The verdict's own reason already says it, so the Cursor lead replaces that sentence
    // instead of sitting in front of it.
    const message = cursorApprovalMessage(APPROVAL.reason);
    expect(message.match(/needs a person to approve/g)).toHaveLength(1);
    expect(message).not.toContain("approve this: agenttrail-guard");
    expect(message.split("\n")).toHaveLength(1);
  });

  it("keeps a reason that does not carry the approval lead whole", () => {
    expect(cursorApprovalMessage("something else")).toBe(`${CURSOR_APPROVAL_LEAD}something else`);
  });

  it("the relay instruction is one line, and asks for the product and the rule by name", () => {
    expect(RELAY_INSTRUCTION).toBe(RELAY);
    expect(RELAY_INSTRUCTION.split("\n")).toHaveLength(1);
    expect(RELAY_INSTRUCTION).toContain("agenttrail-guard");
    expect(RELAY_INSTRUCTION).toContain("guardrail");
    expect(agentMessage(BLOCK.reason)).toBe(`${BLOCK.reason}${RELAY}`);
  });

  it("only the agent is told to relay; the user's sentence is left alone", () => {
    const { output } = buildCursorAnswer({
      launchedAs: "cursor",
      event: "preToolUse",
      tool: "Shell",
      decision: BLOCK,
    });
    const parsed = JSON.parse(output);
    // The user's copy is the verdict's own sentence, with nothing added.
    expect(parsed.user_message).toBe(BLOCK.reason);
    expect(parsed.user_message).not.toContain("Relay this");
    // The agent's copy keeps the product, the title and the id, and adds the instruction.
    expect(parsed.agent_message).toContain("Relay this to the user verbatim");
    expect(parsed.agent_message).toContain("agenttrail-guard");
    expect(parsed.agent_message).toContain("Block the test command");
    expect(parsed.agent_message).toContain("(guardrail t.block)");
  });

  it("an approval Cursor cannot ask about relays too, and still says approve once", () => {
    const parsed = JSON.parse(
      buildCursorAnswer({
        launchedAs: "cursor",
        event: "preToolUse",
        tool: "Write",
        decision: APPROVAL,
      }).output,
    );
    expect(parsed.user_message).toBe(cursorApprovalMessage(APPROVAL.reason));
    expect(parsed.agent_message).toBe(`${parsed.user_message}${RELAY}`);
    expect(parsed.agent_message).toContain("(guardrail t.ask)");
    expect(parsed.agent_message.match(/needs a person to approve/g)).toHaveLength(1);
  });

  it("a reason with quotes and a newline still makes one valid object", () => {
    const odd: GuardDecision = { ...BLOCK, reason: 'agenttrail-guard blocked this: "a"\nb' };
    const { output } = buildCursorAnswer({
      launchedAs: "cursor",
      event: "preToolUse",
      tool: "Shell",
      decision: odd,
    });
    expect(JSON.parse(output)).toEqual(permission("deny", odd.reason));
  });
});

describe("strictestCandidate", () => {
  const candidate = (file_path: string, decision: GuardDecision): EvaluatedCandidate => ({
    mapped: { tool: "Grep", args: { file_path } },
    decision,
  });

  it("orders deny, then approval, then warning, then no match", () => {
    const ranked = [
      candidate("/d", BLOCK),
      candidate("/a", APPROVAL),
      candidate("/w", WARNING),
      candidate("/n", NO_MATCH),
    ];
    for (let i = 0; i < ranked.length; i += 1) {
      for (let j = i + 1; j < ranked.length; j += 1) {
        const stricter = ranked[i] as EvaluatedCandidate;
        const weaker = ranked[j] as EvaluatedCandidate;
        expect(strictestCandidate([weaker, stricter])).toBe(stricter);
        expect(strictestCandidate([stricter, weaker])).toBe(stricter);
      }
    }
  });

  it("keeps the first on a tie, which for a Grep is the path that names the file", () => {
    for (const decision of [BLOCK, APPROVAL, WARNING, NO_MATCH]) {
      const joined = candidate("/home/user/project/**/.env", decision);
      const folder = candidate("/home/user/project", decision);
      expect(strictestCandidate([joined, folder])).toBe(joined);
    }
  });

  it("returns the only candidate", () => {
    const single = candidate("/x", NO_MATCH);
    expect(strictestCandidate([single])).toBe(single);
  });
});

describe("createCursorEmitter", () => {
  it("writes the answer once; a later emit adds nothing", () => {
    const written: string[] = [];
    const emitter = createCursorEmitter({ write: (text) => written.push(text) });
    expect(emitter.hasEmitted()).toBe(false);
    emitter.emit('{"permission":"deny","user_message":"x","agent_message":"x"}');
    emitter.emit(NO_OPINION);
    expect(written).toEqual(['{"permission":"deny","user_message":"x","agent_message":"x"}']);
    expect(emitter.hasEmitted()).toBe(true);
  });

  it("writes {} as an answer, not as nothing", () => {
    const written: string[] = [];
    createCursorEmitter({ write: (text) => written.push(text) }).emit(NO_OPINION);
    expect(written).toEqual(["{}"]);
  });
});
