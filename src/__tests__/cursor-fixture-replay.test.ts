/**
 * The guardrail library's own fixtures, replayed as Cursor calls.
 *
 * Every rule ships commands and paths it must and must not match. Each is sent through
 * `runHook` as the Claude Code call, then as each Cursor call carrying the same action. The
 * Cursor answer, and its log line, must be the ones Cursor's table gives for the Claude Code
 * verdict:
 *
 *   Claude Code verdict | `preToolUse` Shell | `beforeShellExecution` | `preToolUse` Read, Write
 *   deny                | deny, logged       | deny, logged           | deny, logged
 *   ask                 | {}                 | ask, logged            | approval deny, logged
 *   warning             | {}, logged         | {}                     | {}, logged
 *   no decision         | {}                 | {}                     | {}
 *
 * The emitted answers are compared, not `evaluateCall`'s verdict. The verdict for the same
 * action is the same by construction; the step that can go wrong is the one that turns it
 * into Cursor's answer.
 *
 * The expected answers are written out here rather than taken from `buildCursorAnswer`, so
 * the two are checked against each other.
 */

import { RULES, type Rule } from "@agenttrail/guardrails/guardrails";
import { describe, expect, it } from "vitest";
import { runHook } from "../commands/hook.js";
import { agentMessage, CURSOR_APPROVAL_LEAD } from "../core/cursor-emit.js";
import { APPROVAL_LEAD } from "../core/evaluate.js";
import type { DecisionEvent } from "../core/events.js";
import type { AgentSource } from "../core/types.js";
import type { GuardIO } from "../io.js";

/** A recent Cursor build, as Cursor stamps it on every payload. */
const CURSOR_VERSION = "3.20.21";

interface Run {
  readonly written: readonly string[];
  readonly events: readonly DecisionEvent[];
}

/** Run the hook in-process with the shipped rules, no config and a recording spy. */
async function run(stdin: string, agent: AgentSource): Promise<Run> {
  const written: string[] = [];
  const events: DecisionEvent[] = [];
  const io: GuardIO = {
    readStdin: async () => stdin,
    writeStdout: (text) => {
      written.push(text);
    },
    readFile: () => undefined,
    homedir: () => "/home/test",
    mkdirp: () => true,
    writeFileAtomic: () => true,
    listDir: () => [],
    deleteFile: () => true,
    appendFile: () => true,
    fileSize: () => 0,
  };
  await runHook(io, {
    agent,
    recorder: {
      record: (event) => {
        events.push(event);
      },
    },
  });
  return { written, events };
}

type Verdict = "deny" | "ask" | "warn" | "none";

/** The Claude Code path's verdict and reason, read off what it wrote. */
function claudeVerdict(written: readonly string[]): { verdict: Verdict; reason: string } {
  if (written.length === 0) return { verdict: "none", reason: "" };
  expect(written).toHaveLength(1);
  const out = JSON.parse(written[0] as string);
  const decision = out.hookSpecificOutput?.permissionDecision;
  if (decision === "deny" || decision === "ask") {
    return { verdict: decision, reason: out.hookSpecificOutput.permissionDecisionReason };
  }
  expect(typeof out.systemMessage).toBe("string");
  return { verdict: "warn", reason: out.systemMessage };
}

type CursorCase = "preToolUse Shell" | "beforeShellExecution" | "preToolUse file tool";

/** The answer and the number of log lines the table gives for a Claude Code verdict. */
function expected(
  verdict: Verdict,
  reason: string,
  cursorCase: CursorCase,
): { output: string; lines: number } {
  const permission = (kind: string, message: string) =>
    JSON.stringify({
      permission: kind,
      user_message: message,
      agent_message: agentMessage(message),
    });
  switch (verdict) {
    case "deny":
      return { output: permission("deny", reason), lines: 1 };
    case "ask":
      if (cursorCase === "beforeShellExecution") {
        return { output: permission("ask", reason), lines: 1 };
      }
      if (cursorCase === "preToolUse Shell") return { output: "{}", lines: 0 };
      // The Cursor lead REPLACES the verdict's own approval lead, so one line does not
      // say twice that a person has to approve.
      return {
        output: permission("deny", reason.replace(APPROVAL_LEAD, CURSOR_APPROVAL_LEAD)),
        lines: 1,
      };
    case "warn":
      return { output: "{}", lines: cursorCase === "beforeShellExecution" ? 0 : 1 };
    case "none":
      return { output: "{}", lines: 0 };
  }
}

interface Replay {
  readonly label: string;
  /** The Claude Code payload whose verdict sets the expectation. */
  readonly claude: string;
  readonly cursor: readonly { readonly cursorCase: CursorCase; readonly payload: string }[];
}

/**
 * One replay per fixture action. A command becomes a `preToolUse` `Shell` call and a
 * `beforeShellExecution` call, both evaluated as `Bash`. A path becomes a `preToolUse` `Read`
 * and a `preToolUse` `Write`, each compared with the Claude Code call for the same tool.
 */
function replaysFor(rule: Rule): Replay[] {
  const replays: Replay[] = [];
  for (const fixture of [...rule.fixtures.block, ...rule.fixtures.allow]) {
    if ("command" in fixture) {
      const { command } = fixture;
      replays.push({
        label: `${fixture.tool}: ${command}`,
        claude: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
        cursor: [
          {
            cursorCase: "preToolUse Shell",
            payload: JSON.stringify({
              hook_event_name: "preToolUse",
              tool_name: "Shell",
              tool_input: { command, cwd: "", timeout: 30000 },
              cwd: "",
              cursor_version: CURSOR_VERSION,
            }),
          },
          {
            cursorCase: "beforeShellExecution",
            payload: JSON.stringify({
              hook_event_name: "beforeShellExecution",
              command,
              cwd: "",
              sandbox: true,
              cursor_version: CURSOR_VERSION,
            }),
          },
        ],
      });
      continue;
    }
    for (const tool of ["Read", "Write"] as const) {
      const toolInput =
        tool === "Write"
          ? { file_path: fixture.file_path, content: "x" }
          : { file_path: fixture.file_path };
      replays.push({
        label: `${tool}: ${fixture.file_path}`,
        claude: JSON.stringify({ tool_name: tool, tool_input: { file_path: fixture.file_path } }),
        cursor: [
          {
            cursorCase: "preToolUse file tool",
            payload: JSON.stringify({
              hook_event_name: "preToolUse",
              tool_name: tool,
              tool_input: toolInput,
              cursor_version: CURSOR_VERSION,
            }),
          },
        ],
      });
    }
  }
  return replays;
}

describe("every library fixture gets the table's answer through Cursor", () => {
  it.each(RULES.map((rule) => [rule.id, rule] as const))("%s", async (_id, rule) => {
    for (const replay of replaysFor(rule)) {
      const { verdict, reason } = claudeVerdict((await run(replay.claude, "claude")).written);
      for (const { cursorCase, payload } of replay.cursor) {
        const want = expected(verdict, reason, cursorCase);
        const got = await run(payload, "cursor");
        const where = `${replay.label} (${cursorCase}, Claude Code verdict: ${verdict})`;
        expect(got.written, where).toEqual([want.output]);
        expect(
          got.events.map((event) => event.agent),
          where,
        ).toEqual(Array.from({ length: want.lines }, () => "cursor"));
      }
    }
  });

  it("the sweep covers a real number of fixture actions, not zero", () => {
    const count = RULES.reduce((total, rule) => total + replaysFor(rule).length, 0);
    expect(count).toBeGreaterThanOrEqual(500);
  });

  it("the comparison is not vacuous: every Claude Code verdict occurs", async () => {
    // Without this, a sweep in which every fixture produced no decision would compare `{}`
    // with `{}` throughout and pass.
    const seen = new Set<Verdict>();
    for (const rule of RULES) {
      const replays = replaysFor(rule);
      for (const replay of [replays[0], replays[replays.length - 1]]) {
        if (replay !== undefined)
          seen.add(claudeVerdict((await run(replay.claude, "claude")).written).verdict);
      }
    }
    expect([...seen].sort()).toEqual(["ask", "deny", "none", "warn"]);
  });
});
