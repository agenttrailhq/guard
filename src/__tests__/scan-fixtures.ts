/**
 * Shared fixtures for the `scan` suites: a hand-built catalog, session builders, and
 * a synthetic transcript writer.
 *
 * ── The catalog here is INJECTED, never `SHIPPED_CATALOG` ───────────────────
 * The shipped catalog grows. A test asserting "3 findings" against it would go red
 * the day a rule is added, in a file its author never opened, and the natural fix —
 * updating the number — would erase the assertion's meaning. Every count asserted in
 * these suites is therefore hand-computed against rules defined here.
 *
 * ── `label` is written BARE, and that is a real trap ───────────────────────
 * A rule's `label` is a picomatch pattern. `"{Bash,PowerShell}"` is a valid two-element
 * alternation; **`"{Bash}"` — one element — is not reliable and matches nothing, with
 * no error anywhere.** A fixture rule written that way looks correct, compiles, and
 * silently never fires, so the suite would measure an aggregator that had nothing to
 * aggregate. Single-tool rules below are spelled `"Bash"`.
 */

import type { ParsedSession, ToolUse, Turn, Usage } from "../core/transcript/transcript-types.js";
import type { GuardRule } from "../core/types.js";

/** A rule for shell commands that delete recursively. */
export const RULE_RM_RF: GuardRule = {
  id: "t.rm-rf",
  category: "destructive-data",
  severity: "critical",
  defaultAction: "block",
  title: "Recursive delete",
  description: "Fires on `rm -rf`. Does not match the long forms.",
  match: {
    any_of: [{ kind: "execute_tool", label: "Bash", detail_matches: ["\\brm\\s+-rf\\b"] }],
  },
};

/** A rule for opening a dotenv file through a file tool. */
export const RULE_ENV_FILE: GuardRule = {
  id: "t.env-file",
  category: "secret-exposure",
  severity: "high",
  defaultAction: "require_approval",
  title: "Reading a .env file",
  description: "Matches the path only; it cannot tell whether the file holds a secret.",
  match: { any_of: [{ kind: "execute_tool", file_glob: "**/.env*" }] },
};

/** A rule that warns rather than blocks, so the warn path is exercised. */
export const RULE_GIT_CHECKOUT: GuardRule = {
  id: "t.git-checkout",
  category: "working-tree",
  severity: "medium",
  defaultAction: "warn",
  title: "Discards uncommitted work",
  description: "Matches `git checkout --`. Does not match `git restore`.",
  match: {
    any_of: [{ kind: "execute_tool", label: "Bash", detail_contains: ["git checkout --"] }],
  },
};

/** A rule that no fixture command matches, so "absent, not zero" is testable. */
export const RULE_NEVER: GuardRule = {
  id: "t.never",
  category: "prod-infra",
  severity: "low",
  defaultAction: "warn",
  title: "Never fires on these fixtures",
  description: "Present in the catalog so an unfired rule can be asserted absent.",
  match: {
    any_of: [{ kind: "execute_tool", label: "Bash", detail_contains: ["kubectl delete ns"] }],
  },
};

/** The catalog every `scan` unit test compiles. */
export const TEST_CATALOG: readonly GuardRule[] = [
  RULE_RM_RF,
  RULE_ENV_FILE,
  RULE_GIT_CHECKOUT,
  RULE_NEVER,
];

/** Build a `ToolUse` without repeating the id bookkeeping in every test. */
export function toolUse(name: string, input: Record<string, unknown>, id = "tu"): ToolUse {
  return { toolUseId: id, name, input };
}

/** A `Bash` tool use. */
export function bash(command: string, id = "tu"): ToolUse {
  return toolUse("Bash", { command }, id);
}

/** Build one assistant turn. */
export function turn(toolUses: readonly ToolUse[], usage: Usage = {}): Turn {
  return {
    messageUuid: "m",
    timestamp: "2026-09-08T00:00:00.000Z",
    model: "claude-opus-5",
    usage,
    text: "",
    toolUses,
    isSidechain: false,
    promptUuid: "p",
  };
}

/** Build one parsed session out of turns. */
export function session(turns: readonly Turn[], skippedLines = 0): ParsedSession {
  return {
    sessionId: "s",
    version: "2.1.0",
    gitBranch: "main",
    cwd: "/Users/priya/clients/acme/app",
    turns,
    userPrompts: [],
    toolResults: new Map(),
    firstTimestamp: "2026-09-08T00:00:00.000Z",
    lastTimestamp: "2026-09-08T00:01:00.000Z",
    skippedLines,
  };
}

/** One JSONL transcript line for an assistant message carrying tool uses. */
export function assistantLine(toolUses: readonly ToolUse[], usage: Usage = {}): string {
  return JSON.stringify({
    type: "assistant",
    uuid: `a-${toolUses[0]?.toolUseId ?? "0"}`,
    timestamp: "2026-09-08T00:00:00.000Z",
    sessionId: "fixture-session",
    version: "2.1.0",
    gitBranch: "main",
    cwd: "/Users/priya/clients/acme/app",
    message: {
      role: "assistant",
      model: "claude-opus-5",
      usage,
      content: toolUses.map((u) => ({
        type: "tool_use",
        id: u.toolUseId,
        name: u.name,
        input: u.input,
      })),
    },
  });
}

/** One JSONL transcript line for a human prompt. */
export function userLine(text: string): string {
  return JSON.stringify({
    type: "user",
    uuid: "u-1",
    timestamp: "2026-09-08T00:00:00.000Z",
    sessionId: "fixture-session",
    cwd: "/Users/priya/clients/acme/app",
    message: { role: "user", content: text },
  });
}
