/**
 * `hasGuardCursorEntry` — whether `~/.cursor/hooks.json` holds guard's Cursor install.
 *
 * Guard's Claude Code plugin reads the answer when Cursor hands it a call: installed, it
 * leaves approvals to guard's Cursor entry; not installed, it is the only checkpoint. A
 * false "installed" would leave a terminal command's approval to nobody, so every shape
 * short of both entries must answer `false`.
 */

import { describe, expect, it } from "vitest";
import {
  GUARD_CURSOR_EVENTS,
  hasGuardCursorEntry,
  isGuardCursorCommand,
} from "../core/cursor-entry.js";
import { cursorHooksPath } from "../core/paths.js";

/** A guard entry's command, as the Cursor install writes it. */
const GUARD_COMMAND =
  '"/usr/local/bin/node" "/home/user/.agenttrail/guard/cursor/guard-hook.mjs" --agent cursor';

/** One hook entry with `command`. */
function entry(command: unknown = GUARD_COMMAND): Record<string, unknown> {
  return { command, timeout: 10 };
}

/** The text of a hooks file with these hook lists. */
function hooksFile(hooks: unknown, top: Record<string, unknown> = { version: 1 }): string {
  return JSON.stringify({ ...top, hooks });
}

/** Both of guard's entries, and nothing else. */
const BOTH = hooksFile({ preToolUse: [entry()], beforeShellExecution: [entry()] });

describe("guard's Cursor install is present only with both entries", () => {
  it("both guard entries → true", () => {
    expect(hasGuardCursorEntry(BOTH)).toBe(true);
  });

  it("only the preToolUse entry → false: nothing would ask about a terminal command", () => {
    expect(hasGuardCursorEntry(hooksFile({ preToolUse: [entry()] }))).toBe(false);
    expect(
      hasGuardCursorEntry(hooksFile({ preToolUse: [entry()], beforeShellExecution: [] })),
    ).toBe(false);
  });

  it("only the beforeShellExecution entry → false", () => {
    expect(hasGuardCursorEntry(hooksFile({ beforeShellExecution: [entry()] }))).toBe(false);
    expect(
      hasGuardCursorEntry(hooksFile({ preToolUse: [], beforeShellExecution: [entry()] })),
    ).toBe(false);
  });

  it("guard entries under other hooks only → false", () => {
    expect(
      hasGuardCursorEntry(hooksFile({ beforeReadFile: [entry()], afterFileEdit: [entry()] })),
    ).toBe(false);
  });

  it("the hooks are the two guard installs under", () => {
    expect(GUARD_CURSOR_EVENTS).toEqual(["preToolUse", "beforeShellExecution"]);
  });
});

describe("other hooks alongside guard's entries", () => {
  it("other entries in the same lists, before and after guard's → true", () => {
    const text = hooksFile({
      preToolUse: [entry("node /opt/audit.mjs"), entry(), entry("./lint-hook.sh")],
      beforeShellExecution: [entry("python3 /opt/shell-policy.py"), entry()],
    });
    expect(hasGuardCursorEntry(text)).toBe(true);
  });

  it("other hooks and other keys in the file → true", () => {
    const text = hooksFile(
      {
        preToolUse: [entry()],
        beforeShellExecution: [entry()],
        afterFileEdit: [entry("./format.sh")],
        stop: [],
      },
      { version: 1, $schema: "https://example.test/hooks.json" },
    );
    expect(hasGuardCursorEntry(text)).toBe(true);
  });

  it("other entries only → false", () => {
    const text = hooksFile({
      preToolUse: [entry("node /opt/audit.mjs")],
      beforeShellExecution: [entry("python3 /opt/shell-policy.py")],
    });
    expect(hasGuardCursorEntry(text)).toBe(false);
  });

  it("extra keys on guard's entries are not read", () => {
    const withKeys = { command: GUARD_COMMAND, timeout: 30, failClosed: true, matcher: "Shell" };
    expect(
      hasGuardCursorEntry(hooksFile({ preToolUse: [withKeys], beforeShellExecution: [withKeys] })),
    ).toBe(true);
  });

  it.each([
    ["version 1", { version: 1 }],
    ["another version", { version: 2 }],
    ["a version that is not a number", { version: "1" }],
    ["no version", {}],
  ])("%s is tolerated", (_label, top) => {
    const text = hooksFile({ preToolUse: [entry()], beforeShellExecution: [entry()] }, top);
    expect(hasGuardCursorEntry(text)).toBe(true);
  });
});

describe("an entry counts only when its command runs guard's hook for Cursor", () => {
  it.each([
    [
      "the Claude Code plugin's --agent claude",
      '"node" "/p/scripts/guard-hook.mjs" --agent claude',
    ],
    ["no --agent flag", '"node" "/home/user/.agenttrail/guard/cursor/guard-hook.mjs"'],
    [
      "--agent with no value",
      '"node" "/home/user/.agenttrail/guard/cursor/guard-hook.mjs" --agent',
    ],
    ["another script", '"node" "/opt/other-hook.mjs" --agent cursor'],
    ["--agent cursor with no script", "--agent cursor"],
    ["a longer agent name", '"node" "/p/guard-hook.mjs" --agent cursors'],
    ["the flag glued to a word", '"node" "/p/guard-hook.mjs" x--agent cursor'],
    ["the flag in another case", '"node" "/p/guard-hook.mjs" --agent Cursor'],
  ])("%s → false in both lists", (_label, command) => {
    expect(isGuardCursorCommand(command)).toBe(false);
    expect(
      hasGuardCursorEntry(
        hooksFile({ preToolUse: [entry(command)], beforeShellExecution: [entry(command)] }),
      ),
    ).toBe(false);
  });

  it("one list's entry lacking --agent cursor → false", () => {
    const claude = '"node" "/p/guard-hook.mjs" --agent claude';
    expect(
      hasGuardCursorEntry(
        hooksFile({ preToolUse: [entry()], beforeShellExecution: [entry(claude)] }),
      ),
    ).toBe(false);
  });

  it("one list's entry lacking guard-hook.mjs → false", () => {
    const other = '"node" "/opt/other-hook.mjs" --agent cursor';
    expect(
      hasGuardCursorEntry(
        hooksFile({ preToolUse: [entry(other)], beforeShellExecution: [entry()] }),
      ),
    ).toBe(false);
  });

  it.each([
    ["the install's quoted Node path and copy", GUARD_COMMAND],
    ["a bare node", "node /home/user/.agenttrail/guard/cursor/guard-hook.mjs --agent cursor"],
    ["arguments after the flag", "node /p/guard-hook.mjs --agent cursor --verbose"],
    ["a Windows path", '"C:\\\\node\\\\node.exe" "C:\\\\guard\\\\guard-hook.mjs" --agent cursor'],
  ])("%s → true", (_label, command) => {
    expect(isGuardCursorCommand(command)).toBe(true);
  });

  it.each([
    ["a number", 42],
    ["an array of strings", ["node", "guard-hook.mjs", "--agent", "cursor"]],
    ["null", null],
    ["an object", { command: GUARD_COMMAND }],
  ])("a command that is %s → false", (_label, command) => {
    expect(isGuardCursorCommand(command)).toBe(false);
    expect(
      hasGuardCursorEntry(
        hooksFile({ preToolUse: [entry(command)], beforeShellExecution: [entry(command)] }),
      ),
    ).toBe(false);
  });
});

describe("unreadable or wrongly shaped text counts as not installed", () => {
  it.each([
    ["undefined", undefined],
    ["empty text", ""],
    ["whitespace", "  \n"],
    ["invalid JSON", "{ not json"],
    ["truncated JSON", BOTH.slice(0, -2)],
    ["an array root", JSON.stringify([{ hooks: {} }])],
    ["null", "null"],
    ["a number", "42"],
    ["a string", JSON.stringify(BOTH)],
    ["no hooks key", JSON.stringify({ version: 1 })],
    ["hooks null", hooksFile(null)],
    ["hooks an array", hooksFile([{ preToolUse: [entry()], beforeShellExecution: [entry()] }])],
    ["hooks a string", hooksFile("preToolUse")],
    [
      "hook lists that are objects",
      hooksFile({ preToolUse: entry(), beforeShellExecution: entry() }),
    ],
    [
      "hook lists that are command strings",
      hooksFile({ preToolUse: GUARD_COMMAND, beforeShellExecution: GUARD_COMMAND }),
    ],
    ["hook lists that are null", hooksFile({ preToolUse: null, beforeShellExecution: null })],
    [
      "entries that are command strings",
      hooksFile({ preToolUse: [GUARD_COMMAND], beforeShellExecution: [GUARD_COMMAND] }),
    ],
    ["entries that are null", hooksFile({ preToolUse: [null], beforeShellExecution: [null] })],
    [
      "entries that are arrays",
      hooksFile({ preToolUse: [[GUARD_COMMAND]], beforeShellExecution: [[GUARD_COMMAND]] }),
    ],
  ])("%s → false", (_label, text) => {
    expect(hasGuardCursorEntry(text)).toBe(false);
  });

  it("never throws, even on input built to break the parser", () => {
    for (const text of [
      "[".repeat(100_000),
      `{"hooks":${"[".repeat(50_000)}`,
      "\u0000",
      "\ud800",
    ]) {
      expect(() => hasGuardCursorEntry(text)).not.toThrow();
      expect(hasGuardCursorEntry(text)).toBe(false);
    }
  });

  it("NEGATIVE CONTROL: the same file with both entries restored → true", () => {
    // Without this, every case above would also pass for a function that always said false.
    const broken = hooksFile({ preToolUse: [entry()] });
    const restored = JSON.parse(broken);
    restored.hooks.beforeShellExecution = [entry()];
    expect(hasGuardCursorEntry(broken)).toBe(false);
    expect(hasGuardCursorEntry(JSON.stringify(restored))).toBe(true);
  });
});

describe("where Cursor's hooks file is", () => {
  it("is ~/.cursor/hooks.json", () => {
    expect(cursorHooksPath("/home/user")).toBe("/home/user/.cursor/hooks.json");
  });
});
