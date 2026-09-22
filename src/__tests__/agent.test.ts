// cspell:words codx
/**
 * `agentFromArgv` — reading the hook's `--agent` flag.
 * `isCursorPayload` / `isCodexPayload` / `detectAgent` — telling the apps apart by payload.
 *
 * The hook must never fail on its own command line, so every malformed spelling has a
 * defined answer. That answer is now `undefined` rather than `claude`: a flag naming an
 * app guard does not know is a claim it cannot honour, and turning it into a DIFFERENT
 * app's claim is what used to make `--agent codx` answer as Claude Code without a word.
 * `commands/hook.ts` records a payload that nothing claims.
 *
 * Detection order is the part with teeth. Measured on codex-cli 0.154.0: Codex's payload
 * is Claude Code's payload plus `turn_id` and `model`, so asking "is this Claude Code's?"
 * first would swallow every Codex call.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  agentDisplayName,
  agentFromArgv,
  detectAgent,
  hookProtocolOf,
  isClaudeCodePayload,
  isCodexPayload,
  isCursorPayload,
} from "../core/agent.js";
import { AGENTS } from "../core/types.js";

describe("agentFromArgv", () => {
  it.each([
    { argv: ["--agent", "cursor"], agent: "cursor" },
    { argv: ["--agent=cursor"], agent: "cursor" },
    { argv: ["--agent", "claude"], agent: "claude" },
    { argv: ["--agent=claude"], agent: "claude" },
    { argv: ["--agent", "codex"], agent: "codex" },
    { argv: ["--agent=codex"], agent: "codex" },
    { argv: ["--verbose", "--agent", "cursor"], agent: "cursor" },
    { argv: ["hook", "--agent=cursor"], agent: "cursor" },
  ])("reads $argv as $agent", ({ argv, agent }) => {
    expect(agentFromArgv(argv)).toBe(agent);
  });

  it("reads every name in AGENTS, so the list and the reader cannot drift", () => {
    for (const agent of AGENTS) expect(agentFromArgv(["--agent", agent])).toBe(agent);
  });

  it.each([
    { label: "no arguments", argv: [] },
    { label: "arguments without the flag", argv: ["--print", "cursor"] },
    { label: "--agent with no value", argv: ["--agent"] },
    { label: "--agent= with no value", argv: ["--agent="] },
    { label: "--agent followed by another flag", argv: ["--agent", "--print"] },
    { label: "--agent= followed by a flag", argv: ["--agent=--print"] },
    { label: "an empty value", argv: ["--agent", ""] },
    { label: "an unknown app", argv: ["--agent", "windsurf"] },
    { label: "a near-miss spelling", argv: ["--agent", "codx"] },
    { label: "a different case", argv: ["--agent", "Cursor"] },
    { label: "a padded value", argv: ["--agent", " cursor"] },
    { label: "a longer flag name", argv: ["--agents", "cursor"] },
    { label: "a single dash", argv: ["-agent", "cursor"] },
  ])("$label names no app", ({ argv }) => {
    // Not `claude`. The payload decides from here, and a payload nothing claims is
    // recorded — see `hook.test.ts`.
    expect(agentFromArgv(argv)).toBeUndefined();
  });

  it("the first --agent decides", () => {
    expect(agentFromArgv(["--agent", "cursor", "--agent", "claude"])).toBe("cursor");
    expect(agentFromArgv(["--agent=claude", "--agent", "cursor"])).toBe("claude");
    // Including when the first is the unusable one: a later valid flag does not rescue it.
    expect(agentFromArgv(["--agent", "x", "--agent", "cursor"])).toBeUndefined();
  });
});

describe("isCursorPayload", () => {
  it.each([
    {
      label: "a preToolUse payload",
      payload: { hook_event_name: "preToolUse", tool_name: "Shell", cursor_version: "3.20.21" },
    },
    {
      label: "a beforeShellExecution payload",
      payload: {
        hook_event_name: "beforeShellExecution",
        command: "ls",
        cursor_version: "3.20.21",
      },
    },
    { label: "cursor_version with no event name", payload: { cursor_version: "3.12.17" } },
    { label: "a camelCase event with no version", payload: { hook_event_name: "afterFileEdit" } },
    { label: "Cursor's one-word event", payload: { hook_event_name: "stop" } },
    {
      label: "cursor_version beside a PascalCase event",
      payload: { hook_event_name: "PreToolUse", cursor_version: "3.20.21" },
    },
  ])("$label is Cursor's", ({ payload }) => {
    expect(isCursorPayload(payload)).toBe(true);
  });

  it.each([
    {
      label: "a Claude Code PreToolUse payload",
      payload: {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        session_id: "s",
      },
    },
    { label: "a Claude Code Stop payload", payload: { hook_event_name: "Stop" } },
    { label: "a payload with no event name", payload: { tool_name: "Bash", tool_input: {} } },
    { label: "an empty object", payload: {} },
    { label: "a non-string cursor_version", payload: { cursor_version: 3 } },
    { label: "a non-string event name", payload: { hook_event_name: ["preToolUse"] } },
    { label: "an empty event name", payload: { hook_event_name: "" } },
    { label: "an event name starting with a digit", payload: { hook_event_name: "1preToolUse" } },
    { label: "null", payload: null },
    { label: "an array", payload: [{ cursor_version: "3.20.21" }] },
    { label: "a string", payload: "preToolUse" },
    { label: "a number", payload: 42 },
  ])("$label is not Cursor's", ({ payload }) => {
    expect(isCursorPayload(payload)).toBe(false);
  });

  it.each([
    ["a camelCase event Cursor does not have", { hook_event_name: "beforeLaunchingRockets" }],
    ["another app's lowercase event", { hook_event_name: "toolCallStarted" }],
  ])("%s is NOT claimed for Cursor", (_label, payload) => {
    // The rule used to be "any `hook_event_name` starting lowercase". A third app whose
    // events happen to be camelCase would then have been mapped with Cursor's mapper,
    // answered in Cursor's protocol and logged under Cursor's name — silently, because
    // none of that is an error.
    expect(isCursorPayload(payload)).toBe(false);
    expect(detectAgent(payload)).toBeUndefined();
  });

  it("every recorded Cursor payload is Cursor's", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "cursor");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(isCursorPayload(JSON.parse(readFileSync(join(dir, file), "utf8"))), file).toBe(true);
    }
  });
});

describe("isCodexPayload", () => {
  /** A Bash call as Codex sends it. Measured on codex-cli 0.154.0. */
  const CODEX_BASH = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "git reset --hard" },
    turn_id: "01a0c22e-0000-4000-8000-000000000001",
    model: "gpt-5.6-luna",
    permission_mode: "bypassPermissions",
  };

  it.each([
    ["turn_id and model together", CODEX_BASH],
    [
      "an apply_patch with no identity fields",
      {
        hook_event_name: "PreToolUse",
        tool_name: "apply_patch",
        tool_input: { command: "*** Ad" },
      },
    ],
    [
      "a PermissionRequest",
      { hook_event_name: "PermissionRequest", turn_id: "t", model: "m", tool_name: "Bash" },
    ],
  ])("%s is Codex's", (_label, payload) => {
    expect(isCodexPayload(payload)).toBe(true);
  });

  it.each([
    ["turn_id alone", { turn_id: "t", tool_name: "Bash" }],
    ["model alone", { model: "m", tool_name: "Bash" }],
    ["a non-string turn_id", { turn_id: 1, model: "m" }],
    ["a non-string model", { turn_id: "t", model: 1 }],
    ["a Claude Code payload", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} }],
    ["an empty object", {}],
    ["null", null],
    ["an array", [{ turn_id: "t", model: "m" }]],
  ])("%s is not Codex's", (_label, payload) => {
    expect(isCodexPayload(payload)).toBe(false);
  });

  it("is asked BEFORE Claude Code, or every Codex call would look like Claude Code's", () => {
    // Codex's payload satisfies the Claude Code test too — that is the whole hazard.
    expect(isClaudeCodePayload(CODEX_BASH)).toBe(true);
    expect(detectAgent(CODEX_BASH)).toBe("codex");
  });
});

describe("detectAgent", () => {
  it.each([
    ["Cursor", { hook_event_name: "preToolUse", cursor_version: "3.20.21" }, "cursor"],
    ["Codex", { hook_event_name: "PreToolUse", turn_id: "t", model: "m" }, "codex"],
    ["Claude Code", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} }, "claude"],
    [
      "Claude Code with no event name",
      { tool_name: "Read", tool_input: { file_path: "x" } },
      "claude",
    ],
  ])("reads %s's payload", (_label, payload, expected) => {
    expect(detectAgent(payload)).toBe(expected);
  });

  it.each([
    ["an empty object", {}],
    ["an object with nothing recognizable", { some: "thing" }],
    ["a lowercase event no app here uses", { hook_event_name: "somethingElse" }],
  ])("%s is claimed by nobody", (_label, payload) => {
    expect(detectAgent(payload)).toBeUndefined();
  });
});

describe("the dispatch helpers cover every app", () => {
  it("names every app in AGENTS", () => {
    for (const agent of AGENTS) expect(agentDisplayName(agent)).not.toBe("");
    expect(AGENTS.map(agentDisplayName)).toEqual(["Claude Code", "Cursor", "Codex CLI"]);
  });

  it("gives every app a hook protocol", () => {
    // Each app answers in its own terms. Codex's payload is Claude Code's shape plus two
    // fields, which is exactly why it must not borrow Claude Code's answers: measured on
    // codex-cli 0.154.0, `ask` is rejected there and the action runs.
    expect(AGENTS.map(hookProtocolOf)).toEqual(["claude", "cursor", "codex"]);
  });
});
