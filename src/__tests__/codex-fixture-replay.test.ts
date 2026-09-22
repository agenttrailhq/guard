/**
 * The guardrail library's own fixtures, replayed as Codex calls.
 *
 * Every rule ships commands and paths it must and must not match. Each is sent through
 * `runHook` as the Claude Code call, then as each Codex call carrying the same action —
 * and a file action is replayed in the `apply_patch` forms Codex actually sends, since
 * Codex has no file tool with a path field. The Codex answer, and its log line, must be
 * the ones Codex's table gives for the Claude Code verdict:
 *
 *   Claude Code verdict | `PreToolUse`              | `PermissionRequest`
 *   deny                | deny, logged              | deny, logged
 *   ask                 | deny (approval), logged   | deny (approval), logged
 *   warning             | systemMessage, logged     | nothing, logged
 *   no decision         | nothing                   | nothing
 *
 * This is what proves the whole catalogue works on Codex: a rule whose channel the Codex
 * mapping failed to fill would answer nothing here while answering correctly everywhere
 * else.
 *
 * The emitted answers are compared, not `evaluateCall`'s verdict. The verdict for the same
 * action is the same by construction; the steps that can go wrong are the mapping and the
 * answer built from it. The expected answers are written out here rather than taken from
 * `buildCodexAnswer`, so the two are checked against each other.
 */

import { RULES, type Rule } from "@agenttrail/guardrails/guardrails";
import { describe, expect, it } from "vitest";
import { runHook } from "../commands/hook.js";
import { CODEX_APPROVAL_LEAD } from "../core/codex-emit.js";
import { APPROVAL_LEAD } from "../core/evaluate.js";
import type { DecisionEvent } from "../core/events.js";
import type { AgentSource } from "../core/types.js";
import type { GuardIO } from "../io.js";

/** The identity fields Codex puts on every payload. Measured on codex-cli 0.154.0. */
const TURN = "01a0c22e-0000-4000-8000-000000000001";
const MODEL = "gpt-5.6-luna";

/**
 * A path no shipped rule matches, used as the source of a rename.
 *
 * Checked below rather than assumed: if a rule ever matched it, every `Move to` replay
 * would be comparing the decoy's verdict with the fixture's and would silently stop
 * testing the rename.
 */
const DECOY = "src/replay-decoy-source.ts";

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

type CodexEvent = "PreToolUse" | "PermissionRequest";

/** The answer and the number of log lines the table gives for a Claude Code verdict. */
function expected(
  verdict: Verdict,
  reason: string,
  event: CodexEvent,
): { output: string[]; lines: number } {
  const deny = (message: string) =>
    event === "PreToolUse"
      ? JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: message,
          },
        })
      : JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: { behavior: "deny", message },
          },
        });
  switch (verdict) {
    case "deny":
      return { output: [deny(reason)], lines: 1 };
    case "ask":
      // Codex rejects `ask` and runs the action, so an approval denies — and the Codex
      // lead REPLACES the verdict's own, so one line does not say twice that a person has
      // to approve.
      return { output: [deny(reason.replace(APPROVAL_LEAD, CODEX_APPROVAL_LEAD))], lines: 1 };
    case "warn":
      // Said once, at the event Codex shows it at.
      return {
        output: event === "PreToolUse" ? [JSON.stringify({ systemMessage: reason })] : [],
        lines: 1,
      };
    case "none":
      return { output: [], lines: 0 };
  }
}

interface Replay {
  readonly label: string;
  /** The Claude Code payload whose verdict sets the expectation. */
  readonly claude: string;
  readonly codex: readonly { readonly event: CodexEvent; readonly payload: string }[];
}

/** One Codex payload, in the shape measured on a live session. */
function codexPayload(event: CodexEvent, toolName: string, command: string): string {
  return JSON.stringify({
    hook_event_name: event,
    tool_name: toolName,
    tool_input: { command },
    turn_id: TURN,
    model: MODEL,
    permission_mode: event === "PreToolUse" ? "bypassPermissions" : "default",
    cwd: "/home/dev/project",
    // Only `PreToolUse` carries one, which is why the log key cannot be built from it.
    ...(event === "PreToolUse" ? { tool_use_id: "exec-6cfc65d4" } : {}),
  });
}

/** The patch text for one file action, in each form Codex's editing tool sends. */
const PATCH_FORMS = {
  add: (path: string) => `*** Begin Patch\n*** Add File: ${path}\n+x\n*** End Patch`,
  update: (path: string) => `*** Begin Patch\n*** Update File: ${path}\n@@\n-a\n+b\n*** End Patch`,
  delete: (path: string) => `*** Begin Patch\n*** Delete File: ${path}\n*** End Patch`,
  // A rename INTO the path: the guard must judge where the file lands, not only where it
  // started. The source is a path no rule matches, so the verdict is the target's.
  moveTo: (path: string) =>
    `*** Begin Patch\n*** Update File: ${DECOY}\n*** Move to: ${path}\n@@\n-a\n+b\n*** End Patch`,
} as const;

/**
 * One replay per fixture action.
 *
 * A command becomes a Codex `Bash` call at both events. A path becomes an `apply_patch` in
 * all four marker forms — `Add` at both events, and `Update`, `Delete` and `Move to` at
 * `PreToolUse`, since the event does not change the mapping.
 */
function replaysFor(rule: Rule): Replay[] {
  const replays: Replay[] = [];
  for (const fixture of [...rule.fixtures.block, ...rule.fixtures.allow]) {
    if ("command" in fixture) {
      const { command } = fixture;
      replays.push({
        label: `${fixture.tool}: ${command}`,
        claude: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
        codex: [
          { event: "PreToolUse", payload: codexPayload("PreToolUse", "Bash", command) },
          {
            event: "PermissionRequest",
            payload: codexPayload("PermissionRequest", "Bash", command),
          },
        ],
      });
      continue;
    }
    const path = fixture.file_path;
    replays.push({
      label: `apply_patch: ${path}`,
      claude: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: path } }),
      codex: [
        {
          event: "PreToolUse",
          payload: codexPayload("PreToolUse", "apply_patch", PATCH_FORMS.add(path)),
        },
        {
          event: "PermissionRequest",
          payload: codexPayload("PermissionRequest", "apply_patch", PATCH_FORMS.add(path)),
        },
        {
          event: "PreToolUse",
          payload: codexPayload("PreToolUse", "apply_patch", PATCH_FORMS.update(path)),
        },
        {
          event: "PreToolUse",
          payload: codexPayload("PreToolUse", "apply_patch", PATCH_FORMS.delete(path)),
        },
        {
          event: "PreToolUse",
          payload: codexPayload("PreToolUse", "apply_patch", PATCH_FORMS.moveTo(path)),
        },
      ],
    });
  }
  return replays;
}

describe("every library fixture gets the table's answer through Codex", () => {
  it.each(RULES.map((rule) => [rule.id, rule] as const))("%s", async (_id, rule) => {
    for (const replay of replaysFor(rule)) {
      const { verdict, reason } = claudeVerdict((await run(replay.claude, "claude")).written);
      for (const { event, payload } of replay.codex) {
        const want = expected(verdict, reason, event);
        const got = await run(payload, "codex");
        const where = `${replay.label} (${event}, Claude Code verdict: ${verdict})`;
        expect(got.written, where).toEqual(want.output);
        expect(
          got.events.map((e) => e.agent),
          where,
        ).toEqual(Array.from({ length: want.lines }, () => "codex"));
      }
    }
  });

  it("the rename source matches nothing, so a Move replay tests the target", async () => {
    const payload = JSON.stringify({ tool_name: "Edit", tool_input: { file_path: DECOY } });
    expect((await run(payload, "claude")).written).toEqual([]);
  });

  it("the sweep covers a real number of fixture actions, not zero", () => {
    const count = RULES.reduce((total, rule) => total + replaysFor(rule).length, 0);
    expect(count).toBeGreaterThanOrEqual(500);
    expect(RULES.length).toBeGreaterThanOrEqual(70);
  });

  it("every rule with a file fixture is replayed as an apply_patch", () => {
    // The point of the sweep: a file rule is unreachable on Codex unless the patch parse
    // gives it a path, and nothing else in the suite would notice.
    const missing = RULES.filter((rule) => {
      const hasFileFixture = [...rule.fixtures.block, ...rule.fixtures.allow].some(
        (f) => !("command" in f),
      );
      const hasPatchReplay = replaysFor(rule).some((r) =>
        r.codex.some((c) => c.payload.includes("apply_patch")),
      );
      return hasFileFixture && !hasPatchReplay;
    });
    expect(missing.map((r) => r.id)).toEqual([]);
    expect(
      RULES.filter((r) => r.fixtures.block.some((f) => !("command" in f))).length,
    ).toBeGreaterThan(0);
  });

  it("the comparison is not vacuous: every Claude Code verdict occurs", async () => {
    // Without this, a sweep in which every fixture produced no decision would compare
    // nothing with nothing and pass.
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
