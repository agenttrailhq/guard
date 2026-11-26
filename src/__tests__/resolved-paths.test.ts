/**
 * File rules match the path after `.` and `..` are resolved, and a relative or `~` path also
 * resolved against the agent's working folder (from its own payload) and the home folder.
 *
 * Driven through `runHook` with the shipped catalog, for each agent: a write that only reaches
 * `/etc` once resolved is held by `fs.system-paths`, and a `..` that stays inside the project is
 * not. Plus the span the hook builds, and the allowlist, which as an exemption must match every
 * form of the path.
 */

import { describe, expect, it } from "vitest";
import { runHook } from "../commands/hook.js";
import { compileAllowlist, evaluateCall } from "../core/evaluate.js";
import { buildGuardSpanContext } from "../core/normalize.js";
import { compileCatalog } from "../core/rules.js";
import type { GuardRule, MappedCall } from "../core/types.js";
import type { GuardIO } from "../io.js";

const HOME = "/home/test";
const PROJECT = "/home/test/project";

function io(stdin: string, written: string[]): GuardIO {
  return {
    readStdin: async () => stdin,
    writeStdout: (t) => void written.push(t),
    readFile: () => undefined,
    homedir: () => HOME,
    mkdirp: () => true,
    writeFileAtomic: () => true,
    listDir: () => [],
    deleteFile: () => true,
    appendFile: () => true,
    fileSize: () => 0,
  };
}

/** Run the hook with the shipped catalog; the one answer written, or "" for none. */
async function hook(payload: Record<string, unknown>): Promise<string> {
  const written: string[] = [];
  await runHook(io(JSON.stringify(payload), written), {
    recorder: { record: () => undefined },
    captureCrash: () => undefined,
  });
  expect(written.length).toBeLessThanOrEqual(1);
  return written[0] ?? "";
}

const claudeWrite = (file_path: string, cwd?: string) => ({
  tool_name: "Write",
  tool_input: { file_path, content: "x" },
  ...(cwd !== undefined ? { cwd } : {}),
});

describe("Claude Code: a write that reaches /etc once resolved is held", () => {
  it.each([
    ["/tmp/../etc/hosts", undefined],
    ["/home/test/project/../../../etc/hosts", undefined],
    ["/etc/./hosts", undefined],
    ["../../../etc/hosts", PROJECT],
    ["~/../../etc/hosts", PROJECT],
    ["C:\\Users\\dev\\..\\..\\Windows\\System32\\drivers\\etc\\hosts", undefined],
  ])("%s (cwd %s) → ask", async (path, cwd) => {
    const out = JSON.parse(await hook(claudeWrite(path, cwd)));
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("fs.system-paths");
  });

  it.each([
    ["/home/test/project/src/../lib/main.rs", PROJECT],
    ["src/../lib/main.rs", PROJECT],
    ["../other-project/src/x.ts", PROJECT],
    // Unresolvable without a working folder: a stated known miss.
    ["./a/../../../../etc/passwd", undefined],
  ])("%s (cwd %s) → no decision", async (path, cwd) => {
    expect(await hook(claudeWrite(path, cwd))).toBe("");
  });

  it("a read of a traversal path is still not held (the rule excludes reads)", async () => {
    expect(await hook({ tool_name: "Read", tool_input: { file_path: "/tmp/../etc/hosts" } })).toBe(
      "",
    );
  });
});

describe("Cursor: the payload's cwd resolves a relative path, and an empty cwd does not", () => {
  const cursorWrite = (file_path: string, cwd: string) => ({
    conversation_id: "00000000-0000-4000-8000-000000000011",
    generation_id: "00000000-0000-4000-8000-000000000012",
    model: "composer-2.5",
    tool_name: "Write",
    tool_input: { file_path },
    tool_use_id: "tool_00000000-0000-4000-8000-000000000015",
    session_id: "00000000-0000-4000-8000-000000000011",
    hook_event_name: "preToolUse",
    cursor_version: "3.12.17",
    workspace_roots: [PROJECT],
    cwd,
  });

  it("a write to ../../../etc/hosts from the project is held", async () => {
    expect(await hook(cursorWrite("../../../etc/hosts", PROJECT))).toContain("fs.system-paths");
  });

  it("an absolute traversal path is held whatever the cwd", async () => {
    expect(await hook(cursorWrite("/tmp/../etc/hosts", ""))).toContain("fs.system-paths");
  });

  it('with cwd "" a relative path is not resolved', async () => {
    expect(await hook(cursorWrite("../../../etc/hosts", ""))).not.toContain("fs.system-paths");
  });
});

describe("Codex: a patch's paths are relative to the session's folder", () => {
  const codexPatch = (patch: string, cwd?: string) => ({
    hook_event_name: "PreToolUse",
    tool_name: "apply_patch",
    tool_input: { command: patch },
    turn_id: "01a0c22e-0000-4000-8000-000000000001",
    model: "gpt-5.6-luna",
    permission_mode: "bypassPermissions",
    tool_use_id: "exec-1",
    ...(cwd !== undefined ? { cwd } : {}),
  });

  it("*** Add File: ../../../etc/hosts from the project is held", async () => {
    const patch = "*** Begin Patch\n*** Add File: ../../../etc/hosts\n+x\n*** End Patch";
    expect(await hook(codexPatch(patch, PROJECT))).toContain("fs.system-paths");
  });

  it("*** Move to: ../../../etc/hosts is held", async () => {
    const patch =
      "*** Begin Patch\n*** Update File: src/x.ts\n*** Move to: ../../../etc/hosts\n@@\n-a\n+b\n*** End Patch";
    expect(await hook(codexPatch(patch, PROJECT))).toContain("fs.system-paths");
  });

  it("a patch inside the project is not held", async () => {
    const patch = "*** Begin Patch\n*** Add File: src/../lib/x.ts\n+x\n*** End Patch";
    expect(await hook(codexPatch(patch, PROJECT))).toBe("");
  });
});

describe("the span the hook builds", () => {
  const mapped = (file_path: string): MappedCall => ({ tool: "Write", args: { file_path } });

  it("keeps the separator-normalized path as file_path, exactly as before", () => {
    const attrs = buildGuardSpanContext(mapped("C:\\a\\..\\b"), { cwd: PROJECT, home: HOME }).span
      .attributes;
    expect(attrs.file_path).toBe("C:/a/../b");
    expect(attrs.file_path_resolved).toBeUndefined();
  });

  it("adds the resolved path for a relative or ~ path, given the folders", () => {
    expect(
      buildGuardSpanContext(mapped("../../../etc/hosts"), { cwd: PROJECT }).span.attributes
        .file_path_resolved,
    ).toBe("/etc/hosts");
    expect(
      buildGuardSpanContext(mapped("~/.ssh/id_rsa"), { home: HOME }).span.attributes
        .file_path_resolved,
    ).toBe("/home/test/.ssh/id_rsa");
  });

  it("adds nothing without the folders, or when it would not fit the cap", () => {
    expect(
      buildGuardSpanContext(mapped("../x")).span.attributes.file_path_resolved,
    ).toBeUndefined();
    expect(
      buildGuardSpanContext(mapped("x"), { cwd: `/${"d".repeat(9000)}` }).span.attributes
        .file_path_resolved,
    ).toBeUndefined();
  });

  it("a slash-normalized span still gets the Windows reading of its names", () => {
    const rule: GuardRule = {
      id: "t.env",
      category: "test",
      severity: "high",
      defaultAction: "block",
      title: "env",
      description: "fixture",
      match: { any_of: [{ kind: "execute_tool", file_glob: "**/.env" }] },
    };
    for (const file_path of ["\\proj\\.env. ", "\\proj\\.env::$DATA"]) {
      const call: MappedCall = { tool: "Read", args: { file_path } };
      const decision = evaluateCall(
        compileCatalog([rule]),
        buildGuardSpanContext(call),
        call,
        compileAllowlist([]),
      );
      expect(decision.matches.map((m) => m.ruleId)).toEqual(["t.env"]);
    }
  });

  it("never adds a resolved path to a shell call", () => {
    const attrs = buildGuardSpanContext(
      { tool: "Bash", args: { full_command: "cat ../x" } },
      { cwd: PROJECT, home: HOME },
    ).span.attributes;
    expect(attrs.file_path_resolved).toBeUndefined();
    expect(attrs.file_path).toBeUndefined();
  });
});

describe("the allowlist is an exemption: it must match every form of the path", () => {
  const RULE: GuardRule = {
    id: "t.system",
    category: "test",
    severity: "high",
    defaultAction: "block",
    title: "system folder",
    description: "fixture",
    match: {
      any_of: [
        { kind: "execute_tool", file_glob: "/etc/**" },
        { kind: "execute_tool", file_glob: "src/**" },
      ],
    },
  };
  const catalog = compileCatalog([RULE]);
  const decide = (file_path: string, pattern: string, cwd?: string) => {
    const call: MappedCall = { tool: "Write", args: { file_path } };
    return evaluateCall(
      catalog,
      buildGuardSpanContext(call, cwd !== undefined ? { cwd } : undefined),
      call,
      compileAllowlist([{ guardrail: "t.system", pattern }]),
    ).matches.map((m) => m.ruleId);
  };

  it("an entry that matches the path in every form still suppresses the rule", () => {
    expect(decide("/etc/hosts", "/etc/hosts")).toEqual([]);
  });

  it("an entry that matches only the raw traversal form does not borrow its exemption", () => {
    // Each pattern matches the raw string as written (a literal, or a `*` standing for one
    // name before the `..`), but not /etc/hosts, where the path actually goes.
    expect(
      decide("/home/test/project/../../../etc/hosts", "/home/test/*/../../../etc/hosts"),
    ).toEqual(["t.system"]);
    expect(decide("../../../etc/hosts", "../../../etc/hosts", PROJECT)).toEqual(["t.system"]);
  });

  it("a relative entry still covers a relative path once it is also resolved", () => {
    // A Codex patch path is relative to the session's folder; resolving it adds an absolute
    // form that a relative pattern can never match, so that form is not required.
    expect(decide("src/x.ts", "src/**", PROJECT)).toEqual([]);
    expect(decide("src/../../../../etc/hosts", "src/**", PROJECT)).toEqual(["t.system"]);
  });

  it("without the entry the traversal path is denied", () => {
    expect(decide("/tmp/../etc/hosts", "/nothing")).toEqual(["t.system"]);
  });
});
