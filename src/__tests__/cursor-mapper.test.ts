/**
 * `mapCursorCall` — a Cursor hook payload reduced to the calls the engine evaluates.
 *
 * The recorded payloads in `fixtures/cursor/` drive the shape cases, so the mapper is
 * checked against the keys Cursor actually sends. Where a mapping exists so that a rule
 * can match, the real rule is evaluated on it.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RULES } from "@agenttrail/guardrails/guardrails";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../core/config.js";
import { grepCandidates, mapCursorCall } from "../core/cursor-mapper.js";
import { compileAllowlist, evaluateCall } from "../core/evaluate.js";
import { MAX_DETAIL_LEN, TRUNCATION_MARKER } from "../core/mapper.js";
import { buildGuardSpanContext } from "../core/normalize.js";
import { compileCatalog } from "../core/rules.js";
import type { CursorHookPayload, MappedCall } from "../core/types.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "cursor");

/** A recorded Cursor payload, by file name without `.json`. */
function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
}

/** The single candidate a payload maps to. */
function only(payload: CursorHookPayload): MappedCall {
  const call = mapCursorCall(payload);
  expect(call?.candidates).toHaveLength(1);
  return call?.candidates[0] as MappedCall;
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
  it("preToolUse Shell is evaluated as Bash, on the command channel", () => {
    expect(mapCursorCall(fixture("pre-tool-use-shell"))).toEqual({
      event: "preToolUse",
      cursorTool: "Shell",
      candidates: [{ tool: "Bash", args: { full_command: "echo ask-probe" } }],
    });
  });

  it("beforeShellExecution is evaluated as Bash, on the command channel", () => {
    expect(mapCursorCall(fixture("before-shell-execution"))).toEqual({
      event: "beforeShellExecution",
      cursorTool: "",
      candidates: [{ tool: "Bash", args: { full_command: "echo ask-probe" } }],
    });
  });

  it("a Shell call reaches a rule labelled for Bash", () => {
    const shell = fixture("pre-tool-use-shell");
    const mapped = only({ ...shell, tool_input: { command: "git reset --hard", cwd: "" } });
    expect(matchedRules(mapped)).toContain("wt.reset-hard");
    const exec = only({ ...fixture("before-shell-execution"), command: "git reset --hard" });
    expect(matchedRules(exec)).toContain("wt.reset-hard");
  });

  it("NEGATIVE CONTROL: the recorded shell command matches no rule", () => {
    expect(matchedRules(only(fixture("pre-tool-use-shell")))).toEqual([]);
    expect(matchedRules(only(fixture("before-shell-execution")))).toEqual([]);
  });

  it("an oversized command keeps its first MAX_DETAIL_LEN characters", () => {
    const command = `rm -rf /${"x".repeat(MAX_DETAIL_LEN)}`;
    const mapped = only({ hook_event_name: "beforeShellExecution", command });
    expect(mapped.args.full_command).toBe(command.slice(0, MAX_DETAIL_LEN));
  });

  it.each([
    ["no command", {}],
    ["a non-string command", { command: ["ls"] }],
  ])("beforeShellExecution with %s has no channel", (_label, extra) => {
    expect(only({ hook_event_name: "beforeShellExecution", ...extra })).toEqual({
      tool: "Bash",
      args: {},
    });
  });

  it.each([
    null,
    [],
    "echo hi",
    42,
  ])("a preToolUse Shell with tool_input %j has no channel", (toolInput) => {
    expect(
      only({ hook_event_name: "preToolUse", tool_name: "Shell", tool_input: toolInput }),
    ).toEqual({ tool: "Bash", args: {} });
  });
});

describe("file tools", () => {
  it("Read reads tool_input.file_path", () => {
    expect(only(fixture("pre-tool-use-read"))).toEqual({
      tool: "Read",
      args: { file_path: "/home/user/project/notes.txt" },
    });
  });

  it("Write reads the path and never the content", () => {
    const call = mapCursorCall(fixture("pre-tool-use-write"));
    expect(call?.candidates).toEqual([
      { tool: "Write", args: { file_path: "/home/user/project/notes.txt" } },
    ]);
    expect(JSON.stringify(call)).not.toContain("probe-edit");
  });

  it("Delete, as recorded, carries its path on tool_input.file_path", () => {
    expect(only(fixture("pre-tool-use-delete"))).toEqual({
      tool: "Delete",
      args: { file_path: "/home/user/project/delete-probe.txt" },
    });
  });

  it("a file rule matches a Delete", () => {
    const mapped = only({
      ...fixture("pre-tool-use-delete"),
      tool_input: { file_path: "/etc/hosts" },
    });
    expect(mapped).toEqual({ tool: "Delete", args: { file_path: "/etc/hosts" } });
    expect(matchedRules(mapped)).toContain("fs.system-paths");
  });

  it("NEGATIVE CONTROL: the recorded Delete matches no rule", () => {
    expect(matchedRules(only(fixture("pre-tool-use-delete")))).toEqual([]);
  });

  it("a .env Read reaches the dotenv rule", () => {
    const mapped = only({
      ...fixture("pre-tool-use-read"),
      tool_input: { file_path: "/home/user/project/.env" },
    });
    expect(matchedRules(mapped)).toContain("block-env-file-read");
  });

  it("a file tool with no string file_path has no channel", () => {
    expect(only({ hook_event_name: "preToolUse", tool_name: "Delete", tool_input: {} })).toEqual({
      tool: "Delete",
      args: {},
    });
  });
});

describe("Grep", () => {
  it("a folder and a glob give the joined path first, then the folder", () => {
    expect(mapCursorCall(fixture("pre-tool-use-grep-folder"))).toEqual({
      event: "preToolUse",
      cursorTool: "Grep",
      candidates: [
        { tool: "Grep", args: { file_path: "/home/user/project/**/notes.txt" } },
        { tool: "Grep", args: { file_path: "/home/user/project" } },
      ],
    });
  });

  it("a glob with no folder is evaluated alone, and the empty pattern is not read", () => {
    expect(mapCursorCall(fixture("pre-tool-use-grep-no-folder"))?.candidates).toEqual([
      { tool: "Grep", args: { file_path: "**/delete-probe.txt" } },
    ]);
  });

  it("the earlier recording with no folder maps the same way", () => {
    expect(mapCursorCall(fixture("pre-tool-use-grep-no-folder-notes"))?.candidates).toEqual([
      { tool: "Grep", args: { file_path: "**/notes.txt" } },
    ]);
  });

  it("the search pattern never becomes a candidate", () => {
    const call = mapCursorCall({
      hook_event_name: "preToolUse",
      tool_name: "Grep",
      tool_input: { pattern: "/etc/passwd", file_path: "/home/user/project", glob: "*.ts" },
    });
    expect(JSON.stringify(call?.candidates)).not.toContain("/etc/passwd");
  });

  const NO_CHANNEL = null;
  it.each([
    ["/home/user/project", "**/.env", ["/home/user/project/**/.env", "/home/user/project"]],
    ["/home/user/project/", "**/.env", ["/home/user/project/**/.env", "/home/user/project/"]],
    ["C:\\proj\\", "**/.env", ["C:\\proj/**/.env", "C:\\proj\\"]],
    ["/home/user/project", "/etc/**", ["/etc/**"]],
    ["/home/user/project", "C:/secrets/**", ["C:/secrets/**"]],
    ["/home/user/project", "\\\\server\\share\\**", ["\\\\server\\share\\**"]],
    [undefined, "**/.env", ["**/.env"]],
    ["", "**/.env", ["**/.env"]],
    ["/home/user/project", "", ["/home/user/project"]],
    ["/home/user/project", undefined, ["/home/user/project"]],
    ["", "", NO_CHANNEL],
    [undefined, undefined, NO_CHANNEL],
    [42, ["**/.env"], NO_CHANNEL],
  ])("grepCandidates(%j, %j) → %j", (folder, glob, paths) => {
    const expected =
      paths === NO_CHANNEL
        ? [{ tool: "Grep", args: {} }]
        : paths.map((file_path) => ({ tool: "Grep", args: { file_path } }));
    expect(grepCandidates(folder, glob)).toEqual(expected);
  });

  it("the folder alone matches no dotenv rule, and the joined path does", () => {
    const [joined, folder] = grepCandidates("/home/user/project", "**/.env");
    expect(matchedRules(folder as MappedCall)).not.toContain("block-env-file-read");
    expect(matchedRules(joined)).toContain("block-env-file-read");
  });

  it("a brace glob is not expanded, so it is not covered", () => {
    const [joined] = grepCandidates("/home/user/project", "{.env,.env.local}");
    expect(matchedRules(joined)).not.toContain("block-env-file-read");
  });
});

describe("MCP", () => {
  it("MCP:<tool> is labelled mcp__cursor__<tool>, with the serialized input", () => {
    expect(only(fixture("pre-tool-use-mcp"))).toEqual({
      tool: "mcp__cursor__echo",
      args: { full_command: '{"text":"hello"}' },
    });
  });

  it("a string input is used as it is, not serialized a second time", () => {
    const mapped = only({
      hook_event_name: "preToolUse",
      tool_name: "MCP:echo",
      tool_input: '{"text":"hello"}',
    });
    expect(mapped.args.full_command).toBe('{"text":"hello"}');
  });

  it("an oversized input keeps its head and its tail", () => {
    const mapped = only({
      hook_event_name: "preToolUse",
      tool_name: "MCP:batch",
      tool_input: { text: `HEAD${"x".repeat(MAX_DETAIL_LEN * 2)}TAIL` },
    });
    const command = mapped.args.full_command as string;
    expect(command).toHaveLength(MAX_DETAIL_LEN);
    expect(command.startsWith('{"text":"HEAD')).toBe(true);
    expect(command).toContain(TRUNCATION_MARKER);
    expect(command.endsWith('TAIL"}')).toBe(true);
  });

  it("an input that cannot be serialized gives an empty channel, not a throw", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const mapped = only({ hook_event_name: "preToolUse", tool_name: "MCP:x", tool_input: cyclic });
    expect(mapped).toEqual({ tool: "mcp__cursor__x", args: { full_command: "" } });
  });
});

describe("any other preToolUse tool", () => {
  it("carries a command and a file path when the input has them", () => {
    expect(
      only({
        hook_event_name: "preToolUse",
        tool_name: "Task",
        tool_input: { command: "make", file_path: "/home/user/project/a.ts", prompt: "x" },
      }),
    ).toEqual({
      tool: "Task",
      args: { full_command: "make", file_path: "/home/user/project/a.ts" },
    });
  });

  it("a tool with neither has no channel", () => {
    expect(
      only({
        hook_event_name: "preToolUse",
        tool_name: "WebSearch",
        tool_input: { search_term: "x" },
      }),
    ).toEqual({ tool: "WebSearch", args: {} });
  });

  it("a missing or non-string tool name maps to an empty name", () => {
    expect(mapCursorCall({ hook_event_name: "preToolUse", tool_name: 7 })).toEqual({
      event: "preToolUse",
      cursorTool: "",
      candidates: [{ tool: "", args: {} }],
    });
  });
});

describe("events the guard does not check", () => {
  it.each([
    "before-read-file",
    "before-mcp-execution",
    "after-file-edit",
  ])("the recorded %s payload is not mapped", (name) => {
    expect(mapCursorCall(fixture(name))).toBeUndefined();
  });

  it.each([
    ["no event name", { tool_name: "Shell", tool_input: { command: "rm -rf /" } }],
    ["Claude Code's event name", { hook_event_name: "PreToolUse", tool_name: "Shell" }],
    ["a non-string event name", { hook_event_name: 1 }],
    ["postToolUse", { hook_event_name: "postToolUse", tool_name: "Shell" }],
    ["stop", { hook_event_name: "stop" }],
  ])("%s is not mapped", (_label, payload) => {
    expect(mapCursorCall(payload)).toBeUndefined();
  });
});

describe("what the mapper never reads", () => {
  it("cwd: the recorded empty cwd changes nothing", () => {
    const recorded = fixture("pre-tool-use-shell");
    const { cwd: _top, ...withoutTop } = recorded;
    const withoutCwd = { ...withoutTop, tool_input: { command: "echo ask-probe", timeout: 30000 } };
    expect(mapCursorCall(recorded)).toEqual(mapCursorCall(withoutCwd));

    const exec = fixture("before-shell-execution");
    const { cwd: _execCwd, ...execWithoutCwd } = exec;
    expect(mapCursorCall(exec)).toEqual(mapCursorCall(execWithoutCwd));
  });

  it.each(["", "/home/user/project"])("a relative path stays relative when cwd is %j", (cwd) => {
    // Typed as a plain record: `cwd` is a key Cursor sends and the payload type leaves out.
    const payload: Record<string, unknown> = {
      hook_event_name: "preToolUse",
      tool_name: "Read",
      tool_input: { file_path: "notes.txt", cwd },
      cwd,
    };
    expect(only(payload).args.file_path).toBe("notes.txt");
  });

  it("an empty Grep folder is not read as the filesystem root", () => {
    const payload: Record<string, unknown> = {
      hook_event_name: "preToolUse",
      tool_name: "Grep",
      tool_input: { pattern: "", file_path: "", glob: "**/.env" },
      cwd: "",
    };
    expect(mapCursorCall(payload)?.candidates).toEqual([
      { tool: "Grep", args: { file_path: "**/.env" } },
    ]);
  });

  it("tool_use_id is never read, even when it holds a newline", () => {
    const recorded = fixture("pre-tool-use-delete");
    expect(recorded.tool_use_id).toContain("\n");
    const { tool_use_id: _id, ...withoutId } = recorded;
    expect(mapCursorCall(recorded)).toEqual(mapCursorCall(withoutId));
    expect(JSON.stringify(mapCursorCall(recorded))).not.toContain("fc_");
  });

  it("tool_use_id does not reach an MCP call's serialized input", () => {
    const payload: Record<string, unknown> = {
      ...fixture("pre-tool-use-mcp"),
      tool_use_id: "rm -rf /",
    };
    expect(only(payload).args.full_command).toBe('{"text":"hello"}');
  });

  it("sandbox, model, ids, workspace folders, email and transcript path change nothing", () => {
    const recorded = fixture("before-shell-execution");
    expect(mapCursorCall(recorded)).toEqual(
      mapCursorCall({ hook_event_name: recorded.hook_event_name, command: recorded.command }),
    );
  });
});
