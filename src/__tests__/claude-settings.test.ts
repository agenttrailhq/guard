/**
 * The read model behind the approval-override disclosure: mapping guardrails to the
 * tools they fire on, reading `permissions.allow` from Claude Code's `settings.json`,
 * and counting the `require_approval` guardrails an allow rule silently overrides.
 *
 * A hold returns Claude Code's `ask`, but a matching `permissions.allow` rule wins and
 * runs the tool with no prompt. These are the pieces that let `status` and `init` say so
 * rather than count a hold that can never fire.
 */

import { describe, expect, it } from "vitest";
import {
  allowedToolLabel,
  approvalOverride,
  claudeSettingsPath,
  formatApprovalOverride,
  readPermissionAllow,
  toolsForMatch,
} from "../core/claude-settings.js";
import type { GuardAction } from "../core/types.js";
import type { Match } from "../engine/policy-predicate.js";

/** A shell rule: a `{Bash,PowerShell}` label plus a command pattern. */
const SHELL_MATCH: Match = {
  any_of: [{ kind: "execute_tool", label: "{Bash,PowerShell}", detail_matches: ["\\brm\\b"] }],
};

/** A file rule: a `file_glob`, no label — it reads `file_path`, so it is a file tool. */
const FILE_MATCH: Match = {
  any_of: [{ kind: "execute_tool", file_glob: "/etc/**" }],
};

/** A bare `detail_*` rule, no label: the guard fills `detail` from a command → shell. */
const DETAIL_MATCH: Match = {
  any_of: [{ kind: "execute_tool", detail_contains: ["npm install"] }],
};

function rule(action: GuardAction, match: Match): { match: Match; action: GuardAction } {
  return { action, match };
}

describe("claudeSettingsPath", () => {
  it("defaults to ~/.claude/settings.json", () => {
    expect(claudeSettingsPath("/home/dev")).toBe("/home/dev/.claude/settings.json");
  });

  it("honours CLAUDE_CONFIG_DIR when it is set", () => {
    expect(claudeSettingsPath("/home/dev", "/cfg/claude")).toBe("/cfg/claude/settings.json");
  });

  it("falls back to the default when the config dir is blank", () => {
    expect(claudeSettingsPath("/home/dev", "   ")).toBe("/home/dev/.claude/settings.json");
  });
});

describe("allowedToolLabel", () => {
  it("reads a bare allow as unscoped", () => {
    expect(allowedToolLabel("Read")).toEqual({ tool: "Read", scoped: false });
  });

  it("reads a parenthesised allow as scoped, keeping the tool", () => {
    expect(allowedToolLabel("Bash(git:*)")).toEqual({ tool: "Bash", scoped: true });
  });

  it("trims surrounding whitespace", () => {
    expect(allowedToolLabel("  Bash  ")).toEqual({ tool: "Bash", scoped: false });
  });

  it("rejects a blank entry and a specifier with no tool", () => {
    expect(allowedToolLabel("")).toBeUndefined();
    expect(allowedToolLabel("(foo)")).toBeUndefined();
  });
});

describe("readPermissionAllow", () => {
  it("is undefined when the file is missing", () => {
    expect(readPermissionAllow(undefined)).toBeUndefined();
  });

  it("is undefined on unparseable text rather than throwing", () => {
    expect(readPermissionAllow("{ not json")).toBeUndefined();
  });

  it("is undefined when there is no permissions.allow array", () => {
    expect(readPermissionAllow("[]")).toBeUndefined();
    expect(readPermissionAllow("{}")).toBeUndefined();
    expect(readPermissionAllow(JSON.stringify({ permissions: {} }))).toBeUndefined();
    expect(readPermissionAllow(JSON.stringify({ permissions: { allow: "Bash" } }))).toBeUndefined();
  });

  it("returns the string entries and drops non-strings", () => {
    const text = JSON.stringify({ permissions: { allow: ["Read", "Bash(git:*)", 5, null] } });
    expect(readPermissionAllow(text)).toEqual(["Read", "Bash(git:*)"]);
  });

  it("returns an empty list for a present but empty allow", () => {
    expect(readPermissionAllow(JSON.stringify({ permissions: { allow: [] } }))).toEqual([]);
  });
});

describe("toolsForMatch", () => {
  it("expands a {Bash,PowerShell} label to both shell tools", () => {
    expect(new Set(toolsForMatch(SHELL_MATCH))).toEqual(new Set(["Bash", "PowerShell"]));
  });

  it("maps a file_glob condition to the file tools", () => {
    expect(new Set(toolsForMatch(FILE_MATCH))).toEqual(
      new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"]),
    );
  });

  it("maps a bare detail condition to the shell tools", () => {
    expect(new Set(toolsForMatch(DETAIL_MATCH))).toEqual(new Set(["Bash", "PowerShell"]));
  });

  it("unions the tools of every positive arm, ignoring none_of", () => {
    const mixed: Match = {
      any_of: [
        { kind: "execute_tool", label: "{Bash,PowerShell}", detail_matches: ["x"] },
        { kind: "execute_tool", file_glob: "**/.cursor/mcp.json" },
      ],
      none_of: [{ kind: "execute_tool", label: "{Bash,PowerShell}", detail_contains: ["echo"] }],
    };
    expect(new Set(toolsForMatch(mixed))).toEqual(
      new Set(["Bash", "PowerShell", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit"]),
    );
  });
});

describe("approvalOverride", () => {
  const rules = [
    rule("require_approval", SHELL_MATCH), // fires on Bash / PowerShell
    rule("require_approval", FILE_MATCH), // fires on the file tools
    rule("block", SHELL_MATCH), // not an approval hold — never counted
    rule("warn", DETAIL_MATCH), // not an approval hold — never counted
  ];

  it("counts only require_approval rules in the total", () => {
    expect(approvalOverride(rules, []).total).toBe(2);
  });

  it("a bare Bash allow overrides the shell hold and names Bash", () => {
    const result = approvalOverride(rules, ["Bash"]);
    expect(result).toEqual({ total: 2, overridden: 1, tools: ["Bash"] });
  });

  it("a bare Read allow overrides the file hold and names Read", () => {
    const result = approvalOverride(rules, ["Read"]);
    expect(result).toEqual({ total: 2, overridden: 1, tools: ["Read"] });
  });

  it("allowing both tools overrides both holds and names both, sorted", () => {
    const result = approvalOverride(rules, ["Read", "Bash"]);
    expect(result).toEqual({ total: 2, overridden: 2, tools: ["Bash", "Read"] });
  });

  it("a scoped allow is narrower and is NOT counted", () => {
    expect(approvalOverride(rules, ["Bash(git:*)"]).overridden).toBe(0);
  });

  it("an empty allow list overrides nothing", () => {
    expect(approvalOverride(rules, [])).toEqual({ total: 2, overridden: 0, tools: [] });
  });
});

describe("formatApprovalOverride", () => {
  it("is empty when nothing is overridden, so callers print nothing", () => {
    expect(formatApprovalOverride({ total: 5, overridden: 0, tools: [] })).toEqual([]);
  });

  it("states the count and names the tools", () => {
    const lines = formatApprovalOverride({ total: 5, overridden: 3, tools: ["Bash", "Read"] });
    expect(lines[0]).toBe(
      "3 of 5 approval guardrails will not prompt because settings.json allows: Bash, Read",
    );
    expect(lines[1]).toContain("Claude Code runs an allowed tool before the guard's hold can ask");
  });
});
