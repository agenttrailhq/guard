/**
 * `mapCodexCall` — a Codex hook payload reduced to the calls the engine evaluates, and
 * `codexCallKey`, which makes one Codex ACTION one decision-log line.
 *
 * The payload shapes here are the ones measured on codex-cli 0.154.0: Claude Code's
 * `PreToolUse` fields plus `turn_id` and `model`, a raw shell command with no
 * `/bin/zsh -lc` wrapper, and a file edit that carries its paths only inside a patch.
 *
 * The parse is the part with teeth. A patch body's lines begin with `+`, `-` or a space,
 * so file CONTENT can spell a marker, and reading one would judge a path the patch never
 * touches. Every such near miss below is a case.
 */

import { RULES } from "@agenttrail/guardrails/guardrails";
import { describe, expect, it } from "vitest";
import { codexCallKey, mapCodexCall, patchCandidates } from "../core/codex-mapper.js";
import { DEFAULT_CONFIG } from "../core/config.js";
import { compileAllowlist, evaluateCall } from "../core/evaluate.js";
import { MAX_DETAIL_LEN, TRUNCATION_MARKER } from "../core/mapper.js";
import { buildGuardSpanContext } from "../core/normalize.js";
import { compileCatalog } from "../core/rules.js";
import type { CodexHookPayload, MappedCall } from "../core/types.js";

/** The identity fields Codex puts on every payload. */
const IDENTITY = {
  turn_id: "01a0c22e-0000-4000-8000-000000000001",
  model: "gpt-5.6-luna",
  permission_mode: "bypassPermissions",
  session_id: "01a0c22e-0000-4000-8000-000000000001",
  cwd: "/home/dev/project",
};

/**
 * A payload as it arrives on the wire.
 *
 * Codex sends more keys than the guard's type names — `tool_use_id` and `permission_mode`
 * among them — and the cast is how a test can send them without the type claiming they are
 * read.
 */
function wire(fields: Record<string, unknown>): CodexHookPayload {
  return fields as CodexHookPayload;
}

/** One Codex shell call. */
function bash(command: string): CodexHookPayload {
  return wire({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    tool_use_id: "exec-6cfc65d4",
    ...IDENTITY,
  });
}

/** One Codex file edit: the patch text, and no path field anywhere. */
function applyPatch(patch: string, event = "PreToolUse"): CodexHookPayload {
  return {
    hook_event_name: event,
    tool_name: "apply_patch",
    tool_input: { command: patch },
    ...IDENTITY,
  };
}

/** The candidates a payload maps to. */
function candidates(payload: CodexHookPayload): readonly MappedCall[] {
  return mapCodexCall(payload)?.candidates ?? [];
}

/** The single candidate a payload maps to. */
function only(payload: CodexHookPayload): MappedCall {
  const mapped = candidates(payload);
  expect(mapped).toHaveLength(1);
  return mapped[0] as MappedCall;
}

const CATALOG = compileCatalog(RULES, DEFAULT_CONFIG);
const NO_ALLOWLIST = compileAllowlist([]);

/** The ids of the shipped rules that match a mapped call. */
function matchedRules(mapped: MappedCall): string[] {
  return evaluateCall(CATALOG, buildGuardSpanContext(mapped), mapped, NO_ALLOWLIST).matches.map(
    (m) => m.ruleId,
  );
}

describe("shell calls", () => {
  it("is evaluated as Bash, on the command channel", () => {
    expect(mapCodexCall(bash("git reset --hard"))).toEqual({
      event: "PreToolUse",
      candidates: [{ tool: "Bash", args: { full_command: "git reset --hard" } }],
    });
  });

  it("takes the command RAW, not the shell wrapper Codex runs it through", () => {
    // Measured on codex-cli 0.154.0: `tool_input.command` is what the agent wrote. A
    // mapper that stripped a `/bin/zsh -lc '…'` wrapper would corrupt a command that
    // legitimately begins that way.
    const wrapper = `/bin/zsh -lc 'echo hi'`;
    expect(only(bash(wrapper)).args.full_command).toBe(wrapper);
  });

  it("caps an oversized command at the head, as the other mappers do", () => {
    const command = "x".repeat(MAX_DETAIL_LEN + 500);
    const capped = only(bash(command)).args.full_command as string;
    expect(capped).toHaveLength(MAX_DETAIL_LEN);
    expect(capped).not.toContain(TRUNCATION_MARKER);
  });

  it("a Bash call with no command is a Bash call with no channel", () => {
    // It evaluates to no match, rather than to a guess about what ran.
    expect(only({ ...bash("x"), tool_input: {} })).toEqual({ tool: "Bash", args: {} });
    expect(only({ ...bash("x"), tool_input: { command: 42 } })).toEqual({ tool: "Bash", args: {} });
  });

  it("a real shell guardrail fires through the Codex shape", () => {
    expect(matchedRules(only(bash("git push --force origin main")))).not.toEqual([]);
  });
});

describe("apply_patch — the paths live in the patch text", () => {
  it("Add File is a write", () => {
    const patch = "*** Begin Patch\n*** Add File: src/new.ts\n+export const x = 1;\n*** End Patch";
    expect(mapCodexCall(applyPatch(patch))).toEqual({
      event: "PreToolUse",
      candidates: [{ tool: "Write", args: { file_path: "src/new.ts" } }],
    });
  });

  it("Update File is an edit, and Delete File is a delete", () => {
    expect(
      only(applyPatch("*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** End Patch")),
    ).toEqual({ tool: "Edit", args: { file_path: "a.ts" } });
    expect(only(applyPatch("*** Begin Patch\n*** Delete File: a.ts\n*** End Patch"))).toEqual({
      tool: "Delete",
      args: { file_path: "a.ts" },
    });
  });

  it("an Update plus a Move yields both ends of the rename, old path first", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: old/name.ts",
      "*** Move to: new/name.ts",
      "@@",
      "-a",
      "+b",
      "*** End Patch",
    ].join("\n");
    expect(candidates(applyPatch(patch))).toEqual([
      { tool: "Edit", args: { file_path: "old/name.ts" } },
      { tool: "Edit", args: { file_path: "new/name.ts" } },
    ]);
  });

  it("a multi-file patch yields one candidate per file, in the patch's order", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: one.ts",
      "+a",
      "*** Update File: two.ts",
      "@@",
      "-b",
      "+c",
      "*** Delete File: three.ts",
      "*** End Patch",
    ].join("\n");
    expect(candidates(applyPatch(patch))).toEqual([
      { tool: "Write", args: { file_path: "one.ts" } },
      { tool: "Edit", args: { file_path: "two.ts" } },
      { tool: "Delete", args: { file_path: "three.ts" } },
    ]);
  });

  it("a real file guardrail fires through an apply_patch", () => {
    const patch = "*** Begin Patch\n*** Add File: /etc/hosts\n+127.0.0.1 x\n*** End Patch";
    expect(matchedRules(only(applyPatch(patch)))).not.toEqual([]);
  });

  it("every candidate of a multi-file patch is evaluated, not just the first", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: docs/readme.md",
      "+ok",
      "*** Add File: /etc/hosts",
      "+127.0.0.1 x",
      "*** End Patch",
    ].join("\n");
    const mapped = candidates(applyPatch(patch));
    expect(mapped).toHaveLength(2);
    expect(matchedRules(mapped[0] as MappedCall)).toEqual([]);
    expect(matchedRules(mapped[1] as MappedCall)).not.toEqual([]);
  });
});

describe("apply_patch — a marker is read at column zero only", () => {
  it.each([
    ["a + line of file content", "+*** Delete File: /etc/hosts"],
    ["a - line of file content", "-*** Add File: /etc/passwd"],
    ["a context line", " *** Update File: /etc/shadow"],
    ["an indented marker", "  *** Add File: /etc/hosts"],
    ["a tab-indented marker", "\t*** Add File: /etc/hosts"],
    ["a marker quoted inside content", '+const s = "*** Add File: /etc/hosts";'],
  ])("%s names no path", (_label, line) => {
    // Trimming first would let a file's own CONTENT point the guard at a path the patch
    // never touches — and `apply_patch` itself reads markers only at column zero.
    const patch = ["*** Begin Patch", "*** Add File: notes.txt", line, "*** End Patch"].join("\n");
    expect(candidates(applyPatch(patch))).toEqual([
      { tool: "Write", args: { file_path: "notes.txt" } },
    ]);
  });
});

describe("apply_patch — malformed, empty and CRLF patches", () => {
  it("a CRLF patch does not carry the carriage return into the path", () => {
    const patch = "*** Begin Patch\r\n*** Add File: src/new.ts\r\n+x\r\n*** End Patch\r\n";
    expect(only(applyPatch(patch))).toEqual({ tool: "Write", args: { file_path: "src/new.ts" } });
  });

  it.each([
    ["a patch with no markers at all", "*** Begin Patch\n+just content\n*** End Patch"],
    ["prose that is not a patch", "I could not build the patch"],
    ["an empty patch", ""],
    ["a marker with an empty path", "*** Begin Patch\n*** Add File:\n*** End Patch"],
    ["a marker with only spaces after it", "*** Begin Patch\n*** Add File:   \n*** End Patch"],
    ["a marker spelled wrong", "*** Add file: a.ts"],
  ])("%s yields no call at all", (_label, patch) => {
    // No path means nothing a file rule can read. The patch TEXT is never evaluated as a
    // command, so this is silence rather than a guess.
    expect(mapCodexCall(applyPatch(patch))).toBeUndefined();
  });

  it("a non-string patch yields no call", () => {
    expect(mapCodexCall({ ...applyPatch(""), tool_input: { command: 42 } })).toBeUndefined();
    expect(mapCodexCall({ ...applyPatch(""), tool_input: "*** Add File: a.ts" })).toBeUndefined();
  });

  it("the patch text is never evaluated as a command", () => {
    // Writing `rm -rf /` into a script is a write, not an execution. Only the path is read.
    const patch = "*** Begin Patch\n*** Add File: cleanup.sh\n+rm -rf /\n*** End Patch";
    expect(only(applyPatch(patch)).args.full_command).toBeUndefined();
  });

  it("a marker with no space after the colon still names its path", () => {
    expect(patchCandidates("*** Add File:/tmp/x")).toEqual([
      { tool: "Write", args: { file_path: "/tmp/x" } },
    ]);
  });

  it("a path with spaces inside it survives", () => {
    expect(patchCandidates("*** Add File: my notes/to do.md")).toEqual([
      { tool: "Write", args: { file_path: "my notes/to do.md" } },
    ]);
  });

  it("an absolute Windows path keeps its separators for the span to normalize", () => {
    expect(patchCandidates("*** Update File: C:\\repo\\src\\main.rs")).toEqual([
      { tool: "Edit", args: { file_path: "C:\\repo\\src\\main.rs" } },
    ]);
  });
});

describe("MCP calls", () => {
  it("keeps the tool name and serializes the input, middle-capped", () => {
    expect(
      mapCodexCall({
        hook_event_name: "PreToolUse",
        tool_name: "mcp__github__create_issue",
        tool_input: { title: "x", body: "y" },
        ...IDENTITY,
      }),
    ).toEqual({
      event: "PreToolUse",
      candidates: [
        {
          tool: "mcp__github__create_issue",
          args: { full_command: '{"title":"x","body":"y"}' },
        },
      ],
    });
  });

  it("keeps the tail of an oversized MCP payload", () => {
    const mapped = only({
      hook_event_name: "PreToolUse",
      tool_name: "mcp__server__batch",
      tool_input: { head: "h".repeat(MAX_DETAIL_LEN), tail: "rm -rf /" },
      ...IDENTITY,
    });
    const text = mapped.args.full_command as string;
    expect(text).toContain(TRUNCATION_MARKER);
    expect(text).toContain("rm -rf /");
    expect(text.length).toBeLessThanOrEqual(MAX_DETAIL_LEN);
  });
});

describe("tools and events the guard has no opinion on", () => {
  it.each([
    ["the desktop app's shell tool", "shell_command"],
    ["a tool this build does not know", "view_image"],
    ["no tool name at all", ""],
    ["a tool name that is not a string", 7],
  ])("%s yields no call", (_label, tool) => {
    expect(
      mapCodexCall(wire({ hook_event_name: "PreToolUse", tool_name: tool, ...IDENTITY })),
    ).toBeUndefined();
  });

  it("PermissionRequest is answered, and carries the same candidates", () => {
    const patch = "*** Begin Patch\n*** Add File: /etc/hosts\n+x\n*** End Patch";
    expect(mapCodexCall(applyPatch(patch, "PermissionRequest"))).toEqual({
      event: "PermissionRequest",
      candidates: [{ tool: "Write", args: { file_path: "/etc/hosts" } }],
    });
  });

  it.each([
    ["no event name", undefined],
    ["a non-string event name", 7],
  ])("%s is read as PreToolUse, so enforcement is not switched off", (_label, event) => {
    // An edit really can arrive with no identity field at all; silence would be the one
    // answer that leaves the action unchecked.
    const payload = { tool_name: "Bash", tool_input: { command: "ls" }, hook_event_name: event };
    expect(mapCodexCall(payload)?.event).toBe("PreToolUse");
  });

  it.each([
    "PostToolUse",
    "SessionStart",
    "Stop",
    "UserPromptSubmit",
  ])("%s is left alone", (event) => {
    // Guard mounts two events. Another one is not a tool call it was asked to judge.
    expect(mapCodexCall({ ...bash("git reset --hard"), hook_event_name: event })).toBeUndefined();
  });
});

describe("codexCallKey — one action, one decision-log line", () => {
  const patch = "*** Begin Patch\n*** Add File: /etc/hosts\n+x\n*** End Patch";

  it("is the same for both events of one action", () => {
    // Measured: `PreToolUse` and `PermissionRequest` both fire for one action, in the same
    // second, and only the first carries a `tool_use_id`.
    const pre = codexCallKey(applyPatch(patch));
    const permission = codexCallKey(applyPatch(patch, "PermissionRequest"));
    expect(pre).toBeDefined();
    expect(permission).toBe(pre);
  });

  it("is not shared by a different command, tool or turn", () => {
    const base = codexCallKey(bash("ls")) as string;
    expect(codexCallKey(bash("rm -rf /"))).not.toBe(base);
    expect(codexCallKey({ ...bash("ls"), tool_name: "apply_patch" })).not.toBe(base);
    expect(codexCallKey({ ...bash("ls"), turn_id: "other-turn" })).not.toBe(base);
  });

  it("ignores the id Codex sends on only one of the two events", () => {
    // Keying on `tool_use_id` is exactly what writes the action's decision twice.
    expect(codexCallKey(wire({ ...bash("ls"), tool_use_id: "exec-a" }))).toBe(
      codexCallKey(wire({ ...bash("ls"), tool_use_id: undefined })),
    );
  });

  it("survives a payload whose tool name is not a string", () => {
    // Total, like the mapper: a malformed payload yields a key, not a throw.
    expect(codexCallKey(wire({ ...bash("ls"), tool_name: 7 }))).toContain("ls");
  });

  it("is undefined without a turn_id, so the recorder falls back to its own key", () => {
    expect(codexCallKey({ ...bash("ls"), turn_id: undefined })).toBeUndefined();
    expect(codexCallKey({ ...bash("ls"), turn_id: "" })).toBeUndefined();
    expect(codexCallKey({ ...bash("ls"), turn_id: 7 })).toBeUndefined();
  });

  it("is bounded, so a huge patch cannot make an unbounded key", () => {
    const key = codexCallKey(applyPatch("*** Add File: a.ts\n".concat("+x\n".repeat(20_000))));
    expect((key as string).length).toBeLessThanOrEqual(MAX_DETAIL_LEN + 200);
  });

  it("covers an MCP call, which has no command field", () => {
    expect(
      codexCallKey({
        hook_event_name: "PreToolUse",
        tool_name: "mcp__server__run",
        tool_input: { cmd: "ls" },
        ...IDENTITY,
      }),
    ).toContain('{"cmd":"ls"}');
  });
});

describe("payload fields the mapper does not read", () => {
  it.each([
    "permission_mode",
    "cwd",
    "session_id",
    "transcript_path",
    "model",
  ])("%s changes nothing", (field) => {
    // `permission_mode` in particular: it is `bypassPermissions` under `codex exec`
    // whether or not a person is watching, so it says nothing about safety.
    const base = mapCodexCall(bash("git reset --hard"));
    expect(mapCodexCall({ ...bash("git reset --hard"), [field]: "anything-at-all" })).toEqual(base);
  });
});
