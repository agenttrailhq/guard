// cspell:words uncompilable
/**
 * FAIL-OPEN — the property this whole package exists to guarantee.
 *
 * A bug in the guard must never stop the agent.
 *
 * So this suite forces a failure at EVERY seam independently and asserts the same
 * three things each time: Claude Code gets no permission decision, at most one JSON
 * object reaches stdout, and nothing touches the exit code.
 *
 * "No decision" is the fail-open answer, never `allow`: an `allow` would also skip
 * Claude Code's own permission prompt.
 *
 * Under `--agent cursor`, and for a Cursor payload under any flag, the same properties hold
 * with Cursor's answers: `{}` is no opinion, and the suites at the end of this file cover
 * that path.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type HookDeps, NOT_CHECKED_MESSAGE, runHook } from "../commands/hook.js";
import { agentMessage, CURSOR_APPROVAL_LEAD } from "../core/cursor-emit.js";
import { APPROVAL_LEAD } from "../core/evaluate.js";
import type { DecisionEvent, EventRecorder } from "../core/events.js";
import type { GuardRule } from "../core/types.js";
import type { GuardIO } from "../io.js";

interface Harness {
  io: GuardIO;
  written: string[];
}

function harness(overrides: Partial<GuardIO> = {}, stdin = "{}"): Harness {
  const written: string[] = [];
  const io: GuardIO = {
    readStdin: async () => stdin,
    writeStdout: (t) => {
      written.push(t);
    },
    readFile: () => undefined,
    homedir: () => "/home/test",
    // The crash spool's write primitives, plus the decision log's two. Stubbed rather
    // than omitted so a caller cannot silently no-op against an incomplete double.
    //
    // `appendFile`/`fileSize` are NOT inert: `runHook` now wires the real decision
    // recorder by default, so every hook call that matches a rule goes through
    // them. They are stubbed here precisely so no suite writes to a real home
    // directory; `events.test.ts` drives the recorder against a fake filesystem.
    mkdirp: () => true,
    writeFileAtomic: () => true,
    listDir: () => [],
    deleteFile: () => true,
    appendFile: () => true,
    fileSize: () => 0,
    ...overrides,
  };
  return { io, written };
}

interface Outcome {
  decision: string;
  reason: string;
  message?: string;
}

/** What reached stdout: the permission decision (`none` when there is none) and any message. */
function soleDecision(written: string[]): Outcome {
  expect(written.length).toBeLessThanOrEqual(1);
  if (written.length === 0) return { decision: "none", reason: "" };
  const text = written[0] as string;
  expect(text.startsWith("{")).toBe(true);
  expect(text.endsWith("}")).toBe(true);
  const parsed = JSON.parse(text);
  expect(parsed.hookSpecificOutput?.permissionDecision).not.toBe("allow");
  return {
    decision: parsed.hookSpecificOutput?.permissionDecision ?? "none",
    reason: parsed.hookSpecificOutput?.permissionDecisionReason ?? "",
    message: parsed.systemMessage,
  };
}

/** The fail-open answer: no decision, and a message that the call was not checked. */
function expectNotChecked(written: string[]): void {
  const out = soleDecision(written);
  expect(out.decision).toBe("none");
  expect(out.message).toBe(NOT_CHECKED_MESSAGE);
}

const BLOCKING_RULE: GuardRule = {
  id: "t.block",
  category: "test",
  severity: "high",
  defaultAction: "block",
  title: "blocks danger",
  description: "fixture; does not match anything else",
  match: { any_of: [{ kind: "execute_tool", detail_contains: ["danger"] }] },
};

const WARNING_RULE: GuardRule = {
  ...BLOCKING_RULE,
  id: "t.warn",
  defaultAction: "warn",
  match: { any_of: [{ kind: "execute_tool", detail_contains: ["caution"] }] },
};

describe("the happy paths still work", () => {
  it("denies a matching call", async () => {
    const h = harness({}, JSON.stringify({ tool_name: "Bash", tool_input: { command: "danger" } }));
    await runHook(h.io, { catalog: [BLOCKING_RULE] });
    expect(soleDecision(h.written).decision).toBe("deny");
  });

  it("writes nothing for a non-matching call, so Claude Code's own prompt applies", async () => {
    const h = harness({}, JSON.stringify({ tool_name: "Bash", tool_input: { command: "safe" } }));
    await runHook(h.io, { catalog: [BLOCKING_RULE] });
    expect(h.written).toEqual([]);
  });

  it("a warn match is a message with no decision", async () => {
    const h = harness(
      {},
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "caution" } }),
    );
    await runHook(h.io, { catalog: [BLOCKING_RULE, WARNING_RULE] });
    const out = soleDecision(h.written);
    expect(out.decision).toBe("none");
    expect(out.message).toBe(
      "agenttrail-guard is warning about this: blocks danger (guardrail t.warn)",
    );
  });
});

describe("fail-open: malformed stdin", () => {
  it.each([
    ["empty", ""],
    ["not JSON", "not json at all"],
    ["a JSON array", "[]"],
    ["a JSON string", '"hello"'],
    ["JSON null", "null"],
    ["a number", "42"],
    ["truncated object", '{"tool_name":'],
  ])("%s → no decision, and a message that it was not checked", async (_label, stdin) => {
    const h = harness({}, stdin);
    await runHook(h.io, { catalog: [BLOCKING_RULE] });
    expectNotChecked(h.written);
  });
});

describe("fail-open: a throw at every seam", () => {
  const payload = JSON.stringify({ tool_name: "Bash", tool_input: { command: "danger" } });

  it("readStdin throws → not checked", async () => {
    const h = harness({
      readStdin: async () => {
        throw new Error("stdin exploded");
      },
    });
    await runHook(h.io, { catalog: [BLOCKING_RULE] });
    expectNotChecked(h.written);
  });

  it("readFile throws → not checked (config is never load-bearing for availability)", async () => {
    const h = harness(
      {
        readFile: () => {
          throw new Error("disk exploded");
        },
      },
      payload,
    );
    await runHook(h.io, { catalog: [BLOCKING_RULE] });
    expectNotChecked(h.written);
  });

  it("homedir throws → not checked", async () => {
    const h = harness(
      {
        homedir: () => {
          throw new Error("no home");
        },
      },
      payload,
    );
    await runHook(h.io, { catalog: [BLOCKING_RULE] });
    expectNotChecked(h.written);
  });

  it("a catalog of uncompilable guardrails → no output, not a crash", async () => {
    const broken = { ...BLOCKING_RULE, match: { any_of: [] } } as unknown as GuardRule;
    const h = harness({}, payload);
    await runHook(h.io, { catalog: [broken] });
    expect(h.written).toEqual([]);
  });

  it("a recorder that throws does NOT change the already-emitted decision", async () => {
    const h = harness({}, payload);
    await runHook(h.io, {
      catalog: [BLOCKING_RULE],
      recorder: {
        record() {
          throw new Error("log exploded");
        },
      },
    });
    // Still a deny — the emit happened first, and a failed write is not a reason to
    // change what Claude Code was told.
    expect(soleDecision(h.written).decision).toBe("deny");
  });

  it("a corrupt config file falls back to defaults and still enforces", async () => {
    const h = harness({ readFile: () => "{{{ not json" }, payload);
    await runHook(h.io, { catalog: [BLOCKING_RULE] });
    expect(soleDecision(h.written).decision).toBe("deny");
  });
});

describe("the hook never touches the exit code", () => {
  beforeEach(() => {
    process.exitCode = undefined;
  });

  it.each([
    ["a deny", JSON.stringify({ tool_name: "Bash", tool_input: { command: "danger" } })],
    ["no decision", JSON.stringify({ tool_name: "Bash", tool_input: { command: "safe" } })],
    ["a crash", "not json"],
  ])("%s leaves process.exitCode untouched", async (_l, stdin) => {
    const h = harness({}, stdin);
    await runHook(h.io, { catalog: [BLOCKING_RULE] });
    expect(process.exitCode).toBeUndefined();
  });

  it("never rejects, whatever happens", async () => {
    const h = harness({
      readStdin: async () => {
        throw new Error("boom");
      },
    });
    await expect(runHook(h.io, { catalog: [BLOCKING_RULE] })).resolves.toBeUndefined();
  });
});

describe("the config is read from ~/.agenttrail/guard/config.json", () => {
  it("looks in the right place", async () => {
    const readFile = vi.fn(() => undefined);
    const h = harness({ readFile }, "{}");
    await runHook(h.io, { catalog: [BLOCKING_RULE] });
    expect(readFile).toHaveBeenCalledWith("/home/test/.agenttrail/guard/config.json");
  });

  it("honours a per-rule allowlist from that file", async () => {
    const h = harness(
      {
        readFile: () =>
          JSON.stringify({ allowlist: [{ guardrail: "t.block", pattern: "**danger**" }] }),
      },
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "danger" } }),
    );
    await runHook(h.io, { catalog: [BLOCKING_RULE] });
    expect(h.written).toEqual([]);
  });
});

/**
 * Packs at the hook's own entry point. `config.json` names only the packs that are OFF, so
 * every other pack loads — including one the library gained after the file was written.
 * The config is read on every call, so a change applies to the very next tool call.
 */
describe("packs are switched off by disabledPacks, and by nothing else", () => {
  /** A rule in a pack the library gained after the config below was written. */
  const LATER_RULE: GuardRule = {
    ...BLOCKING_RULE,
    id: "n.block",
    category: "shipped-later",
    match: { any_of: [{ kind: "execute_tool", detail_contains: ["shipped later"] }] },
  };
  const bash = (command: string) => JSON.stringify({ tool_name: "Bash", tool_input: { command } });
  const withConfig = (config: unknown): Partial<GuardIO> => ({
    readFile: (path) => (path.endsWith("config.json") ? JSON.stringify(config) : undefined),
  });

  it("a disabled pack is not enforced on the next call, and an enabled one is", async () => {
    const off = harness(withConfig({ disabledPacks: ["test"] }), bash("danger"));
    await runHook(off.io, { catalog: [BLOCKING_RULE] });
    expect(off.written).toEqual([]);

    const on = harness(withConfig({ disabledPacks: [] }), bash("danger"));
    await runHook(on.io, { catalog: [BLOCKING_RULE] });
    expect(soleDecision(on.written).decision).toBe("deny");
  });

  it("a pack the library gained after the config was written is enforced, and the user's choice stands", async () => {
    const later = harness(
      withConfig({ version: 1, disabledPacks: ["test"] }),
      bash("shipped later"),
    );
    await runHook(later.io, { catalog: [BLOCKING_RULE, LATER_RULE] });
    expect(soleDecision(later.written).decision).toBe("deny");

    const kept = harness(withConfig({ version: 1, disabledPacks: ["test"] }), bash("danger"));
    await runHook(kept.io, { catalog: [BLOCKING_RULE, LATER_RULE] });
    expect(kept.written).toEqual([]);
  });

  it("an older config's enabledPacks does not keep a pack it never listed off", async () => {
    const h = harness(withConfig({ version: 1, enabledPacks: ["test"] }), bash("shipped later"));
    await runHook(h.io, { catalog: [BLOCKING_RULE, LATER_RULE] });
    expect(soleDecision(h.written).decision).toBe("deny");
  });

  it("a malformed disabledPacks disables nothing", async () => {
    const h = harness(withConfig({ disabledPacks: "test" }), bash("danger"));
    await runHook(h.io, { catalog: [BLOCKING_RULE] });
    expect(soleDecision(h.written).decision).toBe("deny");
  });

  it("an unreadable config.json disables nothing", async () => {
    const h = harness(
      { readFile: (path) => (path.endsWith("config.json") ? "{ not json" : undefined) },
      bash("danger"),
    );
    await runHook(h.io, { catalog: [BLOCKING_RULE] });
    expect(soleDecision(h.written).decision).toBe("deny");
  });
});

describe("the decision recorder is wired, and can never block a tool call", () => {
  // `BLOCKING_RULE` matches on the token `danger`; keep this in that vocabulary.
  const PAYLOAD = JSON.stringify({ tool_name: "Bash", tool_input: { command: "danger --now" } });

  it("records a matched decision through the real recorder by default", () => {
    // No `recorder` in deps — production's path. The default is the real writer, so
    // this also proves `hook.ts` is actually wired to it rather than to a no-op.
    const appended: Array<{ path: string; text: string }> = [];
    const h = harness(
      {
        appendFile: (path, text) => {
          appended.push({ path, text });
          return true;
        },
      },
      PAYLOAD,
    );
    return runHook(h.io, { catalog: [BLOCKING_RULE] }).then(() => {
      expect(soleDecision(h.written).decision).toBe("deny");
      expect(appended).toHaveLength(1);
      expect(appended[0]?.path).toBe("/home/test/.agenttrail/guard/events.jsonl");
      const line = JSON.parse(appended[0]?.text as string);
      expect(line.ruleId).toBe(BLOCKING_RULE.id);
      expect(line.agent).toBe("claude");
    });
  });

  it.each([
    "appendFile",
    "fileSize",
    "mkdirp",
    "writeFileAtomic",
  ] as const)("a throw from %s leaves the decision and the output untouched", async (member) => {
    const h = harness(
      {
        [member]: () => {
          throw new Error("disk full");
        },
      },
      PAYLOAD,
    );
    await expect(runHook(h.io, { catalog: [BLOCKING_RULE] })).resolves.toBeUndefined();
    // Still exactly one JSON object, still the same verdict.
    expect(soleDecision(h.written).decision).toBe("deny");
    expect(process.exitCode).toBeUndefined();
  });

  it("a read-only home does not turn a deny into anything else", async () => {
    const h = harness({ mkdirp: () => false, appendFile: () => false }, PAYLOAD);
    await runHook(h.io, { catalog: [BLOCKING_RULE] });
    expect(soleDecision(h.written).decision).toBe("deny");
  });

  it("an unmatched call writes nothing at all", async () => {
    const appended: string[] = [];
    const h = harness(
      {
        appendFile: (_p, text) => {
          appended.push(text);
          return true;
        },
      },
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "safe" } }),
    );
    await runHook(h.io, { catalog: [BLOCKING_RULE] });
    expect(h.written).toEqual([]);
    expect(appended).toEqual([]);
  });
});

describe("the app a decision-log line names", () => {
  // `BLOCKING_RULE` matches `danger`; `WARNING_RULE` matches `caution`.
  const BLOCK = JSON.stringify({ tool_name: "Bash", tool_input: { command: "danger --now" } });
  const PAYLOADS: [string, string][] = [
    ["a block", BLOCK],
    ["a warn", JSON.stringify({ tool_name: "Bash", tool_input: { command: "caution" } })],
    ["no match", JSON.stringify({ tool_name: "Bash", tool_input: { command: "safe" } })],
  ];

  /** A recorder that keeps every event it is handed. */
  function spyRecorder(): { recorder: EventRecorder; events: DecisionEvent[] } {
    const events: DecisionEvent[] = [];
    const recorder: EventRecorder = {
      record: (event) => {
        events.push(event);
      },
    };
    return { recorder, events };
  }

  it("hands the recorder a Claude Code call as agent claude", async () => {
    const { recorder, events } = spyRecorder();
    const h = harness({}, BLOCK);
    await runHook(h.io, { catalog: [BLOCKING_RULE], recorder });
    expect(soleDecision(h.written).decision).toBe("deny");
    expect(events).toHaveLength(1);
    expect(events[0]?.agent).toBe("claude");
    expect(events[0]?.decision.matches).toEqual([{ ruleId: "t.block", action: "block" }]);
  });

  it.each(PAYLOADS)("agent: claude leaves %s unchanged", async (_label, stdin) => {
    const bare = spyRecorder();
    const bareRun = harness({}, stdin);
    await runHook(bareRun.io, { catalog: [BLOCKING_RULE, WARNING_RULE], recorder: bare.recorder });

    const flagged = spyRecorder();
    const flaggedRun = harness({}, stdin);
    await runHook(flaggedRun.io, {
      catalog: [BLOCKING_RULE, WARNING_RULE],
      recorder: flagged.recorder,
      agent: "claude",
    });

    expect(flaggedRun.written).toEqual(bareRun.written);
    expect(flagged.events).toEqual(bare.events);
    expect(flagged.events.map((e) => e.agent)).toEqual(["claude"]);
  });
});

// ── The Cursor path, under --agent cursor ─────────────────────────────────────

const ASKING_RULE: GuardRule = {
  ...BLOCKING_RULE,
  id: "t.ask",
  defaultAction: "require_approval",
  match: { any_of: [{ kind: "execute_tool", detail_contains: ["approve-me"] }] },
};

const FILE_BLOCKING_RULE: GuardRule = {
  ...BLOCKING_RULE,
  id: "t.file-block",
  match: { any_of: [{ kind: "execute_tool", file_glob: "**/blocked.txt" }] },
};

const FILE_ASKING_RULE: GuardRule = {
  ...BLOCKING_RULE,
  id: "t.file-ask",
  defaultAction: "require_approval",
  match: { any_of: [{ kind: "execute_tool", file_glob: "**/secret.key" }] },
};

const FILE_WARNING_RULE: GuardRule = {
  ...BLOCKING_RULE,
  id: "t.file-warn",
  defaultAction: "warn",
  match: { any_of: [{ kind: "execute_tool", file_glob: "**/.env*" }] },
};

/**
 * Commands: `danger` blocks, `approve-me` asks, `caution` warns.
 * Paths: `blocked.txt` blocks, `secret.key` asks, `.env*` warns.
 */
const CURSOR_CATALOG: readonly GuardRule[] = [
  BLOCKING_RULE,
  ASKING_RULE,
  WARNING_RULE,
  FILE_BLOCKING_RULE,
  FILE_ASKING_RULE,
  FILE_WARNING_RULE,
];

const CURSOR_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "cursor");

/** A recorded Cursor payload, by file name without `.json`. */
function cursorFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(CURSOR_FIXTURES, `${name}.json`), "utf8"));
}

/** The recorded `preToolUse` `Shell` payload, with another command. */
function shellCall(command: string): string {
  const recorded = cursorFixture("pre-tool-use-shell");
  return JSON.stringify({
    ...recorded,
    tool_input: { ...(recorded.tool_input as object), command },
  });
}

/** The recorded `beforeShellExecution` payload, with another command. */
function shellExecution(command: string): string {
  return JSON.stringify({ ...cursorFixture("before-shell-execution"), command });
}

/** A `preToolUse` payload for another tool, around the recorded `Read` payload's keys. */
function toolCall(tool_name: string, tool_input: Record<string, unknown>): string {
  return JSON.stringify({ ...cursorFixture("pre-tool-use-read"), tool_name, tool_input });
}

/** Cursor's answer on stdout: exactly one object, never `allow`, never Claude Code's shape. */
function soleCursorAnswer(written: string[]): Record<string, unknown> {
  expect(written).toHaveLength(1);
  const text = written[0] as string;
  expect(text.startsWith("{")).toBe(true);
  expect(text.endsWith("}")).toBe(true);
  expect(text).not.toMatch(/"permission":"allow"|hookSpecificOutput|systemMessage/);
  return JSON.parse(text);
}

/** A deny as Cursor reads it: the user's sentence, and the agent's copy with the relay line. */
function denyAnswer(message: string): Record<string, string> {
  return { permission: "deny", user_message: message, agent_message: agentMessage(message) };
}

interface CursorRun {
  written: string[];
  events: DecisionEvent[];
  readPaths: string[];
  crashes: unknown[];
}

/** Run the hook under `--agent cursor` with the test catalog and a spy on every sink. */
async function runCursor(
  stdin: string,
  overrides: Partial<GuardIO> = {},
  deps: HookDeps = {},
): Promise<CursorRun> {
  const readPaths: string[] = [];
  const events: DecisionEvent[] = [];
  const crashes: unknown[] = [];
  const h = harness(
    {
      readFile: (path) => {
        readPaths.push(path);
        return undefined;
      },
      ...overrides,
    },
    stdin,
  );
  await runHook(h.io, {
    catalog: CURSOR_CATALOG,
    recorder: {
      record: (event) => {
        events.push(event);
      },
    },
    captureCrash: (err) => {
      crashes.push(err);
    },
    agent: "cursor",
    ...deps,
  });
  return { written: h.written, events, readPaths, crashes };
}

describe("Cursor answers under --agent cursor", () => {
  it("preToolUse Shell, block → deny, one line", async () => {
    const r = await runCursor(shellCall("danger --now"));
    expect(soleCursorAnswer(r.written)).toEqual(
      denyAnswer("agenttrail-guard blocked this: blocks danger (guardrail t.block)"),
    );
    expect(r.events).toHaveLength(1);
    expect(r.events[0]?.mapped).toEqual({ tool: "Bash", args: { full_command: "danger --now" } });
  });

  it("preToolUse Shell, approval → {}, no line: beforeShellExecution asks", async () => {
    const r = await runCursor(shellCall("approve-me"));
    expect(soleCursorAnswer(r.written)).toEqual({});
    expect(r.events).toEqual([]);
  });

  it("preToolUse Shell, warning → {}, one line", async () => {
    const r = await runCursor(shellCall("caution"));
    expect(soleCursorAnswer(r.written)).toEqual({});
    expect(r.events.map((e) => e.decision.matches)).toEqual([
      [{ ruleId: "t.warn", action: "warn" }],
    ]);
  });

  it("preToolUse Read, block → deny, one line", async () => {
    const r = await runCursor(toolCall("Read", { file_path: "/home/user/project/blocked.txt" }));
    expect(soleCursorAnswer(r.written)).toEqual(
      denyAnswer("agenttrail-guard blocked this: blocks danger (guardrail t.file-block)"),
    );
    expect(r.events).toHaveLength(1);
  });

  it("preToolUse Write, approval → deny with the approval message, one line", async () => {
    const r = await runCursor(
      toolCall("Write", { file_path: "/home/user/project/secret.key", content: "x" }),
    );
    expect(soleCursorAnswer(r.written)).toEqual(
      denyAnswer(`${CURSOR_APPROVAL_LEAD}blocks danger (guardrail t.file-ask)`),
    );
    expect(r.events).toHaveLength(1);
  });

  it("preToolUse Grep, warning → {}, one line naming the joined path", async () => {
    const r = await runCursor(
      toolCall("Grep", { pattern: "", file_path: "/home/user/project", glob: "**/.env" }),
    );
    expect(soleCursorAnswer(r.written)).toEqual({});
    expect(r.events).toHaveLength(1);
    expect(r.events[0]?.mapped).toEqual({
      tool: "Grep",
      args: { file_path: "/home/user/project/**/.env" },
    });
  });

  it("beforeShellExecution, block → deny, one line", async () => {
    const r = await runCursor(shellExecution("danger"));
    expect(soleCursorAnswer(r.written)).toEqual(
      denyAnswer("agenttrail-guard blocked this: blocks danger (guardrail t.block)"),
    );
    expect(r.events).toHaveLength(1);
  });

  it("beforeShellExecution, approval → ask, one line", async () => {
    const r = await runCursor(shellExecution("approve-me"));
    expect(soleCursorAnswer(r.written)).toEqual({
      permission: "ask",
      user_message:
        "agenttrail-guard needs a person to approve this: blocks danger (guardrail t.ask)",
      agent_message: agentMessage(
        "agenttrail-guard needs a person to approve this: blocks danger (guardrail t.ask)",
      ),
    });
    expect(r.events).toHaveLength(1);
  });

  it("beforeShellExecution, warning → {}, no line: preToolUse logged it", async () => {
    const r = await runCursor(shellExecution("caution"));
    expect(soleCursorAnswer(r.written)).toEqual({});
    expect(r.events).toEqual([]);
  });

  it.each([
    ["a blocked command", () => shellCall("danger --now"), ["danger --now", "--now"]],
    [
      "a blocked file read",
      () => toolCall("Read", { file_path: "/home/user/project/blocked.txt" }),
      ["/home/user/project/blocked.txt", "blocked.txt"],
    ],
    [
      "an approval on a file",
      () => toolCall("Write", { file_path: "/home/user/project/secret.key", content: "x" }),
      ["/home/user/project/secret.key", "secret.key"],
    ],
  ])("%s: the agent is told to relay, and neither message echoes what was judged", async (_label, stdin, echoes) => {
    const answer = soleCursorAnswer((await runCursor(stdin())).written);
    expect(answer.permission).toBe("deny");
    // The agent's copy differs from the user's ONLY by the relay instruction.
    expect(answer.agent_message).not.toBe(answer.user_message);
    expect(answer.agent_message).toBe(agentMessage(String(answer.user_message)));
    expect(String(answer.agent_message)).toContain("Relay this to the user verbatim");
    for (const text of [answer.user_message, answer.agent_message]) {
      expect(String(text)).toContain("agenttrail-guard");
      expect(String(text)).toMatch(/\(guardrail [\w.-]+\)/);
      // The command and the path it judged appear in NEITHER message.
      for (const echo of echoes) expect(String(text)).not.toContain(echo);
    }
  });

  it.each([
    ["preToolUse Shell", () => shellCall("ls -la")],
    ["beforeShellExecution", () => shellExecution("ls -la")],
    ["preToolUse Read", () => toolCall("Read", { file_path: "/home/user/project/src/a.ts" })],
    ["preToolUse Delete", () => JSON.stringify(cursorFixture("pre-tool-use-delete"))],
  ])("no match at %s → {}, no line", async (_label, stdin) => {
    const r = await runCursor(stdin());
    expect(soleCursorAnswer(r.written)).toEqual({});
    expect(r.events).toEqual([]);
  });
});

describe("a terminal command passes both checkpoints and is logged once", () => {
  it.each([
    ["an approval", "approve-me", 1],
    ["a warning", "caution", 1],
    ["no match", "ls", 0],
  ] as const)("%s: %i line in total", async (_label, command, lines) => {
    const pre = await runCursor(shellCall(command));
    const exec = await runCursor(shellExecution(command));
    expect(pre.events.length + exec.events.length).toBe(lines);
  });

  it("a block is answered and logged at preToolUse, whose deny ends the call", async () => {
    const pre = await runCursor(shellCall("danger"));
    expect(soleCursorAnswer(pre.written).permission).toBe("deny");
    expect(pre.events).toHaveLength(1);
  });
});

describe("every decision-log line on the Cursor path says agent cursor", () => {
  const LOGGED: [string, () => string][] = [
    ["preToolUse Shell, block", () => shellCall("danger")],
    ["preToolUse Shell, warning", () => shellCall("caution")],
    [
      "preToolUse Read, block",
      () => toolCall("Read", { file_path: "/home/user/project/blocked.txt" }),
    ],
    ["preToolUse Write, approval", () => toolCall("Write", { file_path: "/p/secret.key" })],
    ["preToolUse Grep, warning", () => toolCall("Grep", { file_path: "/p", glob: "**/.env" })],
    ["beforeShellExecution, block", () => shellExecution("danger")],
    ["beforeShellExecution, approval", () => shellExecution("approve-me")],
  ];

  it.each(LOGGED)("%s: the recorder is handed agent cursor", async (_label, stdin) => {
    const r = await runCursor(stdin());
    expect(r.events.map((e) => e.agent)).toEqual(["cursor"]);
  });

  it.each(LOGGED)("%s: the line the real recorder writes says cursor", async (_label, stdin) => {
    const appended: { path: string; text: string }[] = [];
    const h = harness(
      {
        appendFile: (path, text) => {
          appended.push({ path, text });
          return true;
        },
      },
      stdin(),
    );
    await runHook(h.io, { catalog: CURSOR_CATALOG, agent: "cursor" });
    expect(appended).toHaveLength(1);
    expect(appended[0]?.path).toBe("/home/test/.agenttrail/guard/events.jsonl");
    expect(JSON.parse(appended[0]?.text as string).agent).toBe("cursor");
  });

  it("NEGATIVE CONTROL: the same command through the Claude Code path still says claude", async () => {
    const appended: string[] = [];
    const h = harness(
      {
        appendFile: (_path, text) => {
          appended.push(text);
          return true;
        },
      },
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "danger" } }),
    );
    await runHook(h.io, { catalog: CURSOR_CATALOG, agent: "claude" });
    expect(appended.map((line) => JSON.parse(line).agent)).toEqual(["claude"]);
  });
});

describe("events the guard does not check, and unreadable input", () => {
  it.each([
    [
      "the recorded beforeReadFile, on a blocked path",
      () =>
        JSON.stringify({
          ...cursorFixture("before-read-file"),
          file_path: "/home/user/project/blocked.txt",
        }),
    ],
    [
      "the recorded beforeMCPExecution, with a blocked command",
      () => JSON.stringify({ ...cursorFixture("before-mcp-execution"), command: "danger" }),
    ],
    [
      "the recorded afterFileEdit, on a blocked path",
      () =>
        JSON.stringify({
          ...cursorFixture("after-file-edit"),
          file_path: "/home/user/project/blocked.txt",
        }),
    ],
    [
      "Claude Code's PreToolUse event name",
      () =>
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "danger" },
        }),
    ],
    [
      "a payload with no event name",
      () => JSON.stringify({ tool_name: "Bash", tool_input: { command: "danger" } }),
    ],
  ])("%s → {}, not evaluated, not logged, no crash", async (_label, stdin) => {
    const r = await runCursor(stdin());
    expect(soleCursorAnswer(r.written)).toEqual({});
    expect(r.events).toEqual([]);
    // Nothing was evaluated: not even the config or the user's rules were read.
    expect(r.readPaths).toEqual([]);
    expect(r.crashes).toEqual([]);
  });

  const UNREADABLE: [string, string][] = [
    ["empty", ""],
    ["not JSON", "not json at all"],
    ["a JSON array", "[]"],
    ["a JSON string", '"hello"'],
    ["JSON null", "null"],
    ["a number", "42"],
    ["a truncated object", '{"hook_event_name":'],
  ];

  it.each(
    UNREADABLE,
  )("%s under --agent cursor → {}, a crash record, no line", async (_l, stdin) => {
    const r = await runCursor(stdin);
    expect(r.written).toEqual(["{}"]);
    expect(r.crashes).toHaveLength(1);
    expect(r.events).toEqual([]);
  });

  it.each(
    UNREADABLE,
  )("%s under --agent claude → the not-checked message, as before", async (_l, stdin) => {
    const crashes: unknown[] = [];
    const h = harness({}, stdin);
    await runHook(h.io, {
      catalog: CURSOR_CATALOG,
      agent: "claude",
      captureCrash: (err) => {
        crashes.push(err);
      },
    });
    expectNotChecked(h.written);
    expect(crashes).toHaveLength(1);
  });
});

describe("fail-open on the Cursor path: a throw at every seam", () => {
  const DENIED = (): string => shellCall("danger");

  it.each([
    [
      "readStdin",
      {
        readStdin: async () => {
          throw new Error("stdin exploded");
        },
      },
    ],
    [
      "readFile",
      {
        readFile: () => {
          throw new Error("disk exploded");
        },
      },
    ],
    [
      "homedir",
      {
        homedir: () => {
          throw new Error("no home");
        },
      },
    ],
  ] as [
    string,
    Partial<GuardIO>,
  ][])("%s throws → {}, and a crash record", async (_m, overrides) => {
    const r = await runCursor(DENIED(), overrides);
    expect(r.written).toEqual(["{}"]);
    expect(r.crashes).toHaveLength(1);
    expect(r.events).toEqual([]);
  });

  it.each([
    "appendFile",
    "fileSize",
    "mkdirp",
    "writeFileAtomic",
  ] as const)("a throw from %s leaves the deny untouched", async (member) => {
    const h = harness(
      {
        [member]: () => {
          throw new Error("disk full");
        },
      },
      DENIED(),
    );
    await expect(
      runHook(h.io, { catalog: CURSOR_CATALOG, agent: "cursor" }),
    ).resolves.toBeUndefined();
    expect(soleCursorAnswer(h.written).permission).toBe("deny");
  });

  it("a recorder that throws does not change the answer already written", async () => {
    const r = await runCursor(
      DENIED(),
      {},
      {
        recorder: {
          record() {
            throw new Error("log exploded");
          },
        },
      },
    );
    expect(soleCursorAnswer(r.written)).toEqual(
      denyAnswer("agenttrail-guard blocked this: blocks danger (guardrail t.block)"),
    );
    expect(r.crashes).toEqual([]);
  });

  it("a crash handler that throws still leaves {} as the answer", async () => {
    const r = await runCursor(
      "not json",
      {},
      {
        captureCrash: () => {
          throw new Error("spool exploded");
        },
      },
    );
    expect(r.written).toEqual(["{}"]);
  });

  it("a catalog of uncompilable guardrails → {}, not a crash", async () => {
    const broken = { ...BLOCKING_RULE, match: { any_of: [] } } as unknown as GuardRule;
    const r = await runCursor(DENIED(), {}, { catalog: [broken] });
    expect(r.written).toEqual(["{}"]);
    expect(r.crashes).toEqual([]);
  });

  it("a corrupt config file falls back to defaults and still enforces", async () => {
    const r = await runCursor(DENIED(), { readFile: () => "{{{ not json" });
    expect(soleCursorAnswer(r.written).permission).toBe("deny");
  });

  it.each([
    ["a deny", () => shellCall("danger")],
    ["no opinion", () => shellCall("ls")],
    ["a crash", () => "not json"],
    ["an unchecked event", () => JSON.stringify(cursorFixture("after-file-edit"))],
  ])("%s resolves and leaves process.exitCode untouched", async (_label, stdin) => {
    process.exitCode = undefined;
    await expect(runCursor(stdin())).resolves.toBeDefined();
    expect(process.exitCode).toBeUndefined();
  });
});

describe("the Cursor path loads the same rules as the Claude Code path", () => {
  it("honours disabledPacks from the same config.json", async () => {
    // Both apps read one config, so turning a pack off once turns it off in both.
    const config = (path: string) =>
      path.endsWith("config.json") ? JSON.stringify({ disabledPacks: ["test"] }) : undefined;
    const cursor = await runCursor(shellCall("danger"), { readFile: config });
    expect(soleCursorAnswer(cursor.written)).toEqual({});

    const claude = harness(
      { readFile: config },
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "danger" } }),
    );
    await runHook(claude.io, { catalog: CURSOR_CATALOG });
    expect(claude.written).toEqual([]);

    // And the same file with the pack back on blocks it in Cursor.
    const on = await runCursor(shellCall("danger"), {
      readFile: (path) =>
        path.endsWith("config.json") ? JSON.stringify({ disabledPacks: [] }) : undefined,
    });
    expect(soleCursorAnswer(on.written)).toEqual(
      denyAnswer("agenttrail-guard blocked this: blocks danger (guardrail t.block)"),
    );
  });

  it("honours a per-rule allowlist from config.json", async () => {
    const r = await runCursor(shellCall("danger"), {
      readFile: (path) =>
        path.endsWith("config.json")
          ? JSON.stringify({ allowlist: [{ guardrail: "t.block", pattern: "**danger**" }] })
          : undefined,
    });
    expect(soleCursorAnswer(r.written)).toEqual({});
    expect(r.events).toEqual([]);
  });

  it("enforces the user's own guardrails from guardrails.json, labelled for Bash", async () => {
    const userRule = {
      id: "local.no-deploy",
      category: "prod-infra",
      severity: "medium",
      defaultAction: "block",
      title: "Confirm before deploying",
      match: {
        any_of: [{ kind: "execute_tool", label: "Bash", detail_contains: ["./deploy.sh"] }],
      },
    };
    const r = await runCursor(shellExecution("./deploy.sh prod"), {
      readFile: (path) =>
        path.endsWith("guardrails.json") ? JSON.stringify([userRule]) : undefined,
    });
    expect(soleCursorAnswer(r.written)).toEqual(
      denyAnswer(
        "agenttrail-guard blocked this: Confirm before deploying (guardrail local.no-deploy)",
      ),
    );
  });

  it.each([
    ["cursor", () => shellCall("danger")],
    ["claude", () => JSON.stringify({ tool_name: "Bash", tool_input: { command: "danger" } })],
  ] as const)("--agent %s reads only its own config, guardrails and dedup marker", async (agent, stdin) => {
    const readPaths: string[] = [];
    const h = harness(
      {
        readFile: (path) => {
          readPaths.push(path);
          return undefined;
        },
      },
      stdin(),
    );
    await runHook(h.io, { catalog: CURSOR_CATALOG, agent });
    // The `danger` call matches, so the recorder runs and reads its dedup marker too —
    // all three under the guard's own directory, never the user's project or Claude's
    // settings.
    expect([...readPaths].sort()).toEqual([
      "/home/test/.agenttrail/guard/.last-decision",
      "/home/test/.agenttrail/guard/config.json",
      "/home/test/.agenttrail/guard/guardrails.json",
    ]);
  });
});

describe("Cursor payload fields the hook does not trust", () => {
  it("the recorded empty cwd is not a directory: a relative path is evaluated as sent", async () => {
    const r = await runCursor(
      JSON.stringify({
        ...cursorFixture("pre-tool-use-shell"),
        tool_name: "Read",
        tool_input: { file_path: "blocked.txt", cwd: "" },
      }),
    );
    expect(soleCursorAnswer(r.written).permission).toBe("deny");
    expect(r.events[0]?.mapped).toEqual({ tool: "Read", args: { file_path: "blocked.txt" } });
  });

  it("the recorded Shell payload's empty cwd leaves only the command evaluated", async () => {
    const recorded = cursorFixture("pre-tool-use-shell");
    expect(recorded.cwd).toBe("");
    expect((recorded.tool_input as { cwd?: unknown }).cwd).toBe("");
    const r = await runCursor(shellCall("danger"));
    expect(r.events[0]?.mapped).toEqual({ tool: "Bash", args: { full_command: "danger" } });
  });

  it("an empty Grep folder does not turn the glob into a path from the root", async () => {
    const r = await runCursor(toolCall("Grep", { pattern: "", file_path: "", glob: "**/.env" }));
    expect(soleCursorAnswer(r.written)).toEqual({});
    expect(r.events.map((e) => e.mapped.args.file_path)).toEqual(["**/.env"]);
  });

  it("tool_use_id is never evaluated, even holding a newline and a blocked word", async () => {
    const r = await runCursor(
      JSON.stringify({ ...JSON.parse(shellCall("ls")), tool_use_id: "danger\nfc_danger_0" }),
    );
    expect(soleCursorAnswer(r.written)).toEqual({});
    expect(r.events).toEqual([]);
  });
});

describe("Grep through the hook", () => {
  it("the stricter candidate is answered and logged once: a blocked folder beats a warned file", async () => {
    const r = await runCursor(
      toolCall("Grep", {
        pattern: "",
        file_path: "/home/user/project/blocked.txt",
        glob: "**/.env",
      }),
    );
    expect(soleCursorAnswer(r.written)).toEqual(
      denyAnswer("agenttrail-guard blocked this: blocks danger (guardrail t.file-block)"),
    );
    expect(r.events.map((e) => e.mapped.args.file_path)).toEqual([
      "/home/user/project/blocked.txt",
    ]);
  });

  it("on a tie the joined path, which names the file, is the one logged", async () => {
    const r = await runCursor(
      toolCall("Grep", { pattern: "", file_path: "/home/user/.env-files", glob: "**/.env" }),
    );
    expect(soleCursorAnswer(r.written)).toEqual({});
    expect(r.events.map((e) => e.mapped.args.file_path)).toEqual(["/home/user/.env-files/**/.env"]);
  });

  it.each([
    "pre-tool-use-grep-folder",
    "pre-tool-use-grep-no-folder-notes",
    "pre-tool-use-grep-no-folder",
  ])("the recorded %s → {}, no line, with the shipped rules", async (name) => {
    const r = await runCursor(JSON.stringify(cursorFixture(name)), {}, { catalog: undefined });
    expect(soleCursorAnswer(r.written)).toEqual({});
    expect(r.events).toEqual([]);
  });

  it("a Grep for **/.env under the recorded folder → {}, one line naming the joined path", async () => {
    const recorded = cursorFixture("pre-tool-use-grep-folder");
    const r = await runCursor(
      JSON.stringify({
        ...recorded,
        tool_input: { ...(recorded.tool_input as object), glob: "**/.env" },
      }),
      {},
      { catalog: undefined },
    );
    expect(soleCursorAnswer(r.written)).toEqual({});
    expect(r.events).toHaveLength(1);
    expect(r.events[0]?.mapped.args.file_path).toBe("/home/user/project/**/.env");
    expect(r.events[0]?.decision.matches.map((m) => m.ruleId)).toContain("block-env-file-read");
  });
});

describe("the shipped rules through the Cursor path", () => {
  it("a .env Read is logged and answered {}", async () => {
    const r = await runCursor(
      toolCall("Read", { file_path: "/home/user/project/.env" }),
      {},
      { catalog: undefined },
    );
    expect(soleCursorAnswer(r.written)).toEqual({});
    expect(r.events).toHaveLength(1);
    expect(r.events[0]?.decision.matches.map((m) => m.ruleId)).toContain("block-env-file-read");
  });

  it("a Delete of a system path is denied, and a file rule is what matched", async () => {
    const r = await runCursor(
      JSON.stringify({
        ...cursorFixture("pre-tool-use-delete"),
        tool_input: { file_path: "/etc/hosts" },
      }),
      {},
      { catalog: undefined },
    );
    expect(soleCursorAnswer(r.written).permission).toBe("deny");
    expect(r.events[0]?.mapped.tool).toBe("Delete");
    expect(r.events[0]?.decision.matches.map((m) => m.ruleId)).toContain("fs.system-paths");
  });

  it("NEGATIVE CONTROL: the recorded Delete → {}, no line", async () => {
    const r = await runCursor(
      JSON.stringify(cursorFixture("pre-tool-use-delete")),
      {},
      { catalog: undefined },
    );
    expect(soleCursorAnswer(r.written)).toEqual({});
    expect(r.events).toEqual([]);
  });
});

// ── Cursor calls reaching guard's Claude Code plugin, under --agent claude ────

const CONFIG_PATH = "/home/test/.agenttrail/guard/config.json";
const USER_RULES_PATH = "/home/test/.agenttrail/guard/guardrails.json";
const CURSOR_HOOKS_PATH = "/home/test/.cursor/hooks.json";

/** A guard entry's command, as the Cursor install writes it. */
const GUARD_CURSOR_COMMAND =
  '"/usr/local/bin/node" "/home/test/.agenttrail/guard/cursor/guard-hook.mjs" --agent cursor';

/** The text of `~/.cursor/hooks.json`, with a guard entry under each of `events` and another app's hook. */
function cursorHooksFile(events: readonly string[]): string {
  const hooks: Record<string, unknown> = { afterFileEdit: [{ command: "./format.sh" }] };
  for (const event of events) hooks[event] = [{ command: GUARD_CURSOR_COMMAND, timeout: 10 }];
  return JSON.stringify({ version: 1, hooks });
}

const BOTH_GUARD_ENTRIES = cursorHooksFile(["preToolUse", "beforeShellExecution"]);

/** Each state of `~/.cursor/hooks.json`, and whether guard's Cursor entry counts as present. */
const HOOKS_FILES: [label: string, text: string | undefined, present: boolean][] = [
  ["absent", undefined, false],
  ["with both guard entries", BOTH_GUARD_ENTRIES, true],
  ["with only the preToolUse entry", cursorHooksFile(["preToolUse"]), false],
  ["with only the beforeShellExecution entry", cursorHooksFile(["beforeShellExecution"]), false],
  ["unparseable", "{ not json", false],
];

type Verdict = "block" | "approval" | "warning" | "no match";

/** Cursor calls, with the verdict `CURSOR_CATALOG` gives each and that verdict's reason. */
const CURSOR_CALLS: [label: string, stdin: () => string, verdict: Verdict, reason: string][] = [
  [
    "preToolUse Shell",
    () => shellCall("danger --now"),
    "block",
    "agenttrail-guard blocked this: blocks danger (guardrail t.block)",
  ],
  [
    "beforeShellExecution",
    () => shellExecution("danger"),
    "block",
    "agenttrail-guard blocked this: blocks danger (guardrail t.block)",
  ],
  [
    "preToolUse Read",
    () => toolCall("Read", { file_path: "/home/user/project/blocked.txt" }),
    "block",
    "agenttrail-guard blocked this: blocks danger (guardrail t.file-block)",
  ],
  [
    "preToolUse Shell",
    () => shellCall("approve-me"),
    "approval",
    "agenttrail-guard needs a person to approve this: blocks danger (guardrail t.ask)",
  ],
  [
    "beforeShellExecution",
    () => shellExecution("approve-me"),
    "approval",
    "agenttrail-guard needs a person to approve this: blocks danger (guardrail t.ask)",
  ],
  [
    "preToolUse Write",
    () => toolCall("Write", { file_path: "/home/user/project/secret.key", content: "x" }),
    "approval",
    "agenttrail-guard needs a person to approve this: blocks danger (guardrail t.file-ask)",
  ],
  [
    "preToolUse Shell",
    () => shellCall("caution"),
    "warning",
    "agenttrail-guard is warning about this: blocks danger (guardrail t.warn)",
  ],
  [
    "beforeShellExecution",
    () => shellExecution("caution"),
    "warning",
    "agenttrail-guard is warning about this: blocks danger (guardrail t.warn)",
  ],
  [
    "preToolUse Grep",
    () => toolCall("Grep", { pattern: "", file_path: "/home/user/project", glob: "**/.env" }),
    "warning",
    "agenttrail-guard is warning about this: blocks danger (guardrail t.file-warn)",
  ],
  ["preToolUse Shell", () => shellCall("ls -la"), "no match", ""],
  ["beforeShellExecution", () => shellExecution("ls -la"), "no match", ""],
  [
    "the recorded preToolUse Delete",
    () => JSON.stringify(cursorFixture("pre-tool-use-delete")),
    "no match",
    "",
  ],
];

/** Each Cursor call with a title that names its verdict. */
const CURSOR_CALL_TITLES = CURSOR_CALLS.map(
  ([label, stdin, verdict]) => [`${label}, ${verdict}`, stdin] as const,
);

/** Rows 11–13: guard's Claude Code plugin's answer to a Cursor call. */
function claudeCopyAnswer(
  verdict: Verdict,
  reason: string,
  present: boolean,
): Record<string, unknown> {
  if (verdict === "block") return denyAnswer(reason);
  // The Cursor lead REPLACES the verdict's own approval lead rather than sitting in front of
  // it, so one line does not say twice that a person has to approve.
  if (verdict === "approval" && !present) {
    return denyAnswer(reason.replace(APPROVAL_LEAD, CURSOR_APPROVAL_LEAD));
  }
  return {};
}

/**
 * Run the hook with the test catalog and a spy on every sink, with `hooksFile` as the text of
 * `~/.cursor/hooks.json`. `deps` defaults to `--agent claude`; pass `{}` for no flag.
 */
async function runWithCursorHooks(
  stdin: string,
  hooksFile: string | undefined,
  deps: HookDeps = { agent: "claude" },
): Promise<CursorRun> {
  const readPaths: string[] = [];
  const events: DecisionEvent[] = [];
  const crashes: unknown[] = [];
  const h = harness(
    {
      readFile: (path) => {
        readPaths.push(path);
        return path === CURSOR_HOOKS_PATH ? hooksFile : undefined;
      },
    },
    stdin,
  );
  await runHook(h.io, {
    catalog: CURSOR_CATALOG,
    recorder: {
      record: (event) => {
        events.push(event);
      },
    },
    captureCrash: (err) => {
      crashes.push(err);
    },
    ...deps,
  });
  return { written: h.written, events, readPaths, crashes };
}

describe("rows 11–13: a Cursor call reaching guard's Claude Code plugin", () => {
  const CASES = CURSOR_CALLS.flatMap(([label, stdin, verdict, reason]) =>
    HOOKS_FILES.map(
      ([file, text, present]) =>
        [`${label}, ${verdict}`, file, stdin, verdict, reason, text, present] as const,
    ),
  );

  it.each(
    CASES,
  )("%s, hooks.json %s", async (_call, _file, stdin, verdict, reason, text, present) => {
    const r = await runWithCursorHooks(stdin(), text);

    expect(soleCursorAnswer(r.written)).toEqual(claudeCopyAnswer(verdict, reason, present));

    // Logged only when this copy is the only checkpoint, and always as the app that sent it.
    const logged = verdict !== "no match" && !present;
    expect(r.events.map((e) => [e.agent, e.decision.reason])).toEqual(
      logged ? [["cursor", reason]] : [],
    );

    // The rules, and Cursor's hooks file exactly once.
    expect([...r.readPaths].sort()).toEqual(
      [CONFIG_PATH, USER_RULES_PATH, CURSOR_HOOKS_PATH].sort(),
    );
    expect(r.readPaths.filter((path) => path === CURSOR_HOOKS_PATH)).toHaveLength(1);
    expect(r.crashes).toEqual([]);
  });

  it("the table has a case for every verdict and every hooks.json state", () => {
    expect(new Set(CASES.map((c) => c[3]))).toEqual(
      new Set(["block", "approval", "warning", "no match"]),
    );
    expect(CASES).toHaveLength(CURSOR_CALLS.length * HOOKS_FILES.length);
  });

  it.each(
    HOOKS_FILES,
  )("with no --agent flag, hooks.json %s is answered as under --agent claude", async (_file, text) => {
    for (const [, stdin] of CURSOR_CALLS) {
      const flagged = await runWithCursorHooks(stdin(), text);
      const bare = await runWithCursorHooks(stdin(), text, {});
      expect(bare.written).toEqual(flagged.written);
      expect(bare.events).toEqual(flagged.events);
      expect(bare.readPaths).toEqual(flagged.readPaths);
    }
  });

  it("a Grep with two candidates is evaluated twice and still reads hooks.json once", async () => {
    const r = await runWithCursorHooks(
      toolCall("Grep", {
        pattern: "",
        file_path: "/home/user/project/blocked.txt",
        glob: "**/.env",
      }),
      undefined,
    );
    expect(soleCursorAnswer(r.written)).toEqual(
      denyAnswer("agenttrail-guard blocked this: blocks danger (guardrail t.file-block)"),
    );
    expect(r.events.map((e) => e.mapped.args.file_path)).toEqual([
      "/home/user/project/blocked.txt",
    ]);
    expect(r.readPaths.filter((path) => path === CURSOR_HOOKS_PATH)).toHaveLength(1);
  });

  it.each([
    ["a block", () => shellCall("danger")],
    ["an approval", () => toolCall("Write", { file_path: "/p/secret.key" })],
    ["a warning", () => shellExecution("caution")],
  ])("%s, hooks.json absent: the line the real recorder writes says cursor", async (_label, stdin) => {
    const appended: { path: string; text: string }[] = [];
    const h = harness(
      {
        appendFile: (path, text) => {
          appended.push({ path, text });
          return true;
        },
      },
      stdin(),
    );
    await runHook(h.io, { catalog: CURSOR_CATALOG, agent: "claude" });
    expect(appended).toHaveLength(1);
    expect(appended[0]?.path).toBe("/home/test/.agenttrail/guard/events.jsonl");
    expect(JSON.parse(appended[0]?.text as string).agent).toBe("cursor");
  });

  it("the launch flag decides the answer: with both entries installed, --agent cursor asks and --agent claude stands aside", async () => {
    const asked = await runWithCursorHooks(shellExecution("approve-me"), BOTH_GUARD_ENTRIES, {
      agent: "cursor",
    });
    const aside = await runWithCursorHooks(shellExecution("approve-me"), BOTH_GUARD_ENTRIES);
    expect(soleCursorAnswer(asked.written).permission).toBe("ask");
    expect(soleCursorAnswer(aside.written)).toEqual({});
    // The label is the app that sent the call, whichever copy logged it.
    expect(asked.events.map((e) => e.agent)).toEqual(["cursor"]);
    expect(aside.events).toEqual([]);
  });

  it.each([
    [
      "the recorded beforeReadFile, on a blocked path",
      () =>
        JSON.stringify({
          ...cursorFixture("before-read-file"),
          file_path: "/home/user/project/blocked.txt",
        }),
    ],
    [
      "the recorded beforeMCPExecution, with a blocked command",
      () => JSON.stringify({ ...cursorFixture("before-mcp-execution"), command: "danger" }),
    ],
    [
      "the recorded afterFileEdit, on a blocked path",
      () =>
        JSON.stringify({
          ...cursorFixture("after-file-edit"),
          file_path: "/home/user/project/blocked.txt",
        }),
    ],
  ])("%s → {}, no file read, not logged, no crash", async (_label, stdin) => {
    for (const deps of [{ agent: "claude" }, {}] as HookDeps[]) {
      const r = await runWithCursorHooks(stdin(), undefined, deps);
      expect(soleCursorAnswer(r.written)).toEqual({});
      expect(r.readPaths).toEqual([]);
      expect(r.events).toEqual([]);
      expect(r.crashes).toEqual([]);
    }
  });
});

describe("which files the hook reads", () => {
  const CLAUDE_CODE_CALLS: [string, string][] = [
    [
      "a block",
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "danger" },
      }),
    ],
    [
      "an approval",
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "approve-me" },
      }),
    ],
    ["a warning", JSON.stringify({ tool_name: "Bash", tool_input: { command: "caution" } })],
    [
      "no match",
      JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/home/user/project/a.ts" } }),
    ],
  ];

  it.each(
    CLAUDE_CODE_CALLS,
  )("a Claude Code call (%s) reads only config.json and guardrails.json, and answers as Claude Code", async (_label, stdin) => {
    for (const deps of [{ agent: "claude" }, {}] as HookDeps[]) {
      const withFile = await runWithCursorHooks(stdin, BOTH_GUARD_ENTRIES, deps);
      const withoutFile = await runWithCursorHooks(stdin, undefined, deps);
      expect([...withFile.readPaths].sort()).toEqual([CONFIG_PATH, USER_RULES_PATH]);
      expect(withFile.written).toEqual(withoutFile.written);
      expect(withFile.written.join("")).not.toMatch(/"permission"/);
      expect(withFile.events.map((e) => e.agent)).toEqual(
        withFile.events.length === 0 ? [] : ["claude"],
      );
    }
  });

  it.each(
    CURSOR_CALL_TITLES,
  )("--agent cursor, %s: never reads ~/.cursor/hooks.json, and its answer ignores it", async (_title, stdin) => {
    const baseline = await runWithCursorHooks(stdin(), undefined, { agent: "cursor" });
    for (const [, text] of HOOKS_FILES) {
      const r = await runWithCursorHooks(stdin(), text, { agent: "cursor" });
      expect([...r.readPaths].sort()).toEqual([CONFIG_PATH, USER_RULES_PATH]);
      expect(r.written).toEqual(baseline.written);
      expect(r.events).toEqual(baseline.events);
    }
  });

  it("--agent claude with a Cursor payload reads it exactly once", async () => {
    const r = await runWithCursorHooks(shellCall("approve-me"), BOTH_GUARD_ENTRIES);
    expect(r.readPaths).toEqual([CONFIG_PATH, USER_RULES_PATH, CURSOR_HOOKS_PATH]);
  });
});

describe("fail-open when guard's Claude Code plugin receives a Cursor call", () => {
  /** A Cursor call the test catalog blocks: a throw must still answer `{}`, never a deny. */
  const BLOCKED = (): string => shellCall("danger");
  const LAUNCHES: [string, HookDeps][] = [
    ["--agent claude", { agent: "claude" }],
    ["no flag", {}],
  ];

  it.each([
    [
      "homedir",
      {
        homedir: () => {
          throw new Error("no home");
        },
      },
    ],
    [
      "readFile, for every file",
      {
        readFile: () => {
          throw new Error("disk exploded");
        },
      },
    ],
    [
      "readFile, for ~/.cursor/hooks.json only",
      {
        readFile: (path: string) => {
          if (path === CURSOR_HOOKS_PATH) throw new Error("hooks file exploded");
          return undefined;
        },
      },
    ],
  ] as [
    string,
    Partial<GuardIO>,
  ][])("%s throws → {} and a crash record, not Claude Code's message", async (_seam, overrides) => {
    for (const [, launch] of LAUNCHES) {
      const crashes: unknown[] = [];
      const events: DecisionEvent[] = [];
      const h = harness(overrides, BLOCKED());
      await runHook(h.io, {
        catalog: CURSOR_CATALOG,
        recorder: {
          record: (event) => {
            events.push(event);
          },
        },
        captureCrash: (err) => {
          crashes.push(err);
        },
        ...launch,
      });
      expect(h.written).toEqual(["{}"]);
      expect(crashes).toHaveLength(1);
      expect(events).toEqual([]);
    }
  });

  it("a crash handler that throws still leaves {} as the answer", async () => {
    const h = harness(
      {
        homedir: () => {
          throw new Error("no home");
        },
      },
      BLOCKED(),
    );
    await runHook(h.io, {
      catalog: CURSOR_CATALOG,
      agent: "claude",
      captureCrash: () => {
        throw new Error("spool exploded");
      },
    });
    expect(h.written).toEqual(["{}"]);
  });

  it("a recorder that throws does not change the deny already written", async () => {
    const r = await runWithCursorHooks(BLOCKED(), undefined, {
      agent: "claude",
      recorder: {
        record() {
          throw new Error("log exploded");
        },
      },
    });
    expect(soleCursorAnswer(r.written)).toEqual(
      denyAnswer("agenttrail-guard blocked this: blocks danger (guardrail t.block)"),
    );
    expect(r.crashes).toEqual([]);
  });

  it.each([
    "appendFile",
    "fileSize",
    "mkdirp",
    "writeFileAtomic",
  ] as const)("a throw from %s leaves the deny untouched", async (member) => {
    const h = harness(
      {
        [member]: () => {
          throw new Error("disk full");
        },
      },
      BLOCKED(),
    );
    await expect(
      runHook(h.io, { catalog: CURSOR_CATALOG, agent: "claude" }),
    ).resolves.toBeUndefined();
    expect(soleCursorAnswer(h.written).permission).toBe("deny");
  });

  it.each([
    ["empty", ""],
    ["not JSON", "not json at all"],
    ["a JSON array", "[]"],
    ["JSON null", "null"],
    ["a truncated Cursor payload", '{"hook_event_name":"preToolUse","cursor_version":'],
  ])("%s → the not-checked message, a crash record, no file read", async (_label, stdin) => {
    for (const [, launch] of LAUNCHES) {
      const r = await runWithCursorHooks(stdin, BOTH_GUARD_ENTRIES, launch);
      expectNotChecked(r.written);
      expect(r.crashes).toHaveLength(1);
      expect(r.readPaths).toEqual([]);
      expect(r.events).toEqual([]);
    }
  });

  it.each([
    ["a deny", () => shellCall("danger")],
    ["an approval deny", () => toolCall("Write", { file_path: "/p/secret.key" })],
    ["a crash", () => "not json"],
    ["a throw after a Cursor payload", () => shellCall("danger")],
  ])("%s resolves and leaves process.exitCode untouched", async (label, stdin) => {
    process.exitCode = undefined;
    const h = harness(
      label === "a throw after a Cursor payload"
        ? {
            homedir: () => {
              throw new Error("no home");
            },
          }
        : {},
      stdin(),
    );
    await expect(
      runHook(h.io, { catalog: CURSOR_CATALOG, agent: "claude" }),
    ).resolves.toBeUndefined();
    expect(process.exitCode).toBeUndefined();
    expect(h.written.length).toBeLessThanOrEqual(1);
  });
});

describe("the shipped rules, through guard's Claude Code plugin receiving Cursor calls", () => {
  it("a .env Read answers {}, not Claude Code's warning message, and is logged only without the Cursor entry", async () => {
    const read = toolCall("Read", { file_path: "/home/user/project/.env" });

    const absent = await runWithCursorHooks(read, undefined, {
      agent: "claude",
      catalog: undefined,
    });
    expect(soleCursorAnswer(absent.written)).toEqual({});
    expect(absent.events.map((e) => e.agent)).toEqual(["cursor"]);
    expect(absent.events[0]?.decision.matches.map((m) => m.ruleId)).toContain(
      "block-env-file-read",
    );

    const present = await runWithCursorHooks(read, BOTH_GUARD_ENTRIES, {
      agent: "claude",
      catalog: undefined,
    });
    expect(soleCursorAnswer(present.written)).toEqual({});
    expect(present.events).toEqual([]);
  });

  it("a terminal approval rule: the approval deny without the Cursor entry, {} with it", async () => {
    const command = shellCall("rm -rf ./src");

    const absent = await runWithCursorHooks(command, undefined, {
      agent: "claude",
      catalog: undefined,
    });
    const answer = soleCursorAnswer(absent.written);
    expect(answer.permission).toBe("deny");
    expect(String(answer.user_message).startsWith(CURSOR_APPROVAL_LEAD)).toBe(true);
    expect(String(answer.user_message)).toMatch(/ \(guardrail [\w.-]+\)$/);
    expect(absent.events.map((e) => [e.agent, e.decision.decision])).toEqual([["cursor", "ask"]]);

    const present = await runWithCursorHooks(command, BOTH_GUARD_ENTRIES, {
      agent: "claude",
      catalog: undefined,
    });
    expect(soleCursorAnswer(present.written)).toEqual({});
    expect(present.events).toEqual([]);
  });
});
