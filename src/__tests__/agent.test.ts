/**
 * `agentFromArgv` — reading the hook's `--agent` flag.
 * `isCursorPayload` — telling a Cursor payload from a Claude Code one.
 *
 * The hook must never fail on its own command line, so every malformed spelling has a
 * defined answer: `claude`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agentFromArgv, isCursorPayload } from "../core/agent.js";

describe("agentFromArgv", () => {
  it.each([
    { argv: ["--agent", "cursor"], agent: "cursor" },
    { argv: ["--agent=cursor"], agent: "cursor" },
    { argv: ["--agent", "claude"], agent: "claude" },
    { argv: ["--agent=claude"], agent: "claude" },
    { argv: ["--verbose", "--agent", "cursor"], agent: "cursor" },
    { argv: ["hook", "--agent=cursor"], agent: "cursor" },
  ])("reads $argv as $agent", ({ argv, agent }) => {
    expect(agentFromArgv(argv)).toBe(agent);
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
    { label: "a different case", argv: ["--agent", "Cursor"] },
    { label: "a padded value", argv: ["--agent", " cursor"] },
    { label: "a longer flag name", argv: ["--agents", "cursor"] },
    { label: "a single dash", argv: ["-agent", "cursor"] },
  ])("$label gives claude", ({ argv }) => {
    expect(agentFromArgv(argv)).toBe("claude");
  });

  it("the first --agent decides", () => {
    expect(agentFromArgv(["--agent", "cursor", "--agent", "claude"])).toBe("cursor");
    expect(agentFromArgv(["--agent=claude", "--agent", "cursor"])).toBe("claude");
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

  it("every recorded Cursor payload is Cursor's", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "cursor");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(isCursorPayload(JSON.parse(readFileSync(join(dir, file), "utf8"))), file).toBe(true);
    }
  });
});
