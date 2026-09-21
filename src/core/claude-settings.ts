// cspell:words nocase uncompilable
/**
 * Reading Claude Code's own `settings.json` to answer one question `status` and `init`
 * would otherwise get wrong: **which `require_approval` guardrails will never prompt.**
 *
 * ── The gap this closes ──────────────────────────────────────────────────────
 * A guardrail set to `require_approval` returns Claude Code's `ask` decision. But
 * Claude Code's own `permissions.allow` list wins over a hook's `ask`: when
 * `settings.json` allows a tool outright — `"Bash"`, `"Read"`, `"Edit"` — a call to
 * that tool runs with NO prompt. The guard cannot change this (Claude Code decides),
 * and the hook cannot see that it happened, so the call is still recorded as a hold.
 * Left unsaid, `status` overstates enforcement: it counts a hold that can never fire.
 *
 * This module is READ-ONLY and PURE. It never writes `settings.json` (that file is
 * Claude Code's), takes no IO of its own, and reads no environment — the caller passes
 * the file text and, for the default path, `CLAUDE_CONFIG_DIR`. It is imported only by
 * `commands/status.ts` and `commands/init.ts`, never from the hook path.
 *
 * ── How a guardrail is mapped to the tools it fires on ───────────────────────
 * The guard has no per-rule "tool" field. A rule targets a tool through the CHANNEL it
 * matches on (`core/mapper.ts`):
 *   - a `label` glob (e.g. `{Bash,PowerShell}`) names the tool directly;
 *   - a `file_glob` reads `file_path`, which only the FILE tools carry;
 *   - a bare `detail_*` condition reads `detail`, which the guard fills from a shell
 *     command, so it fires on the shell tools.
 * `none_of` (the exemptions) is excluded, exactly as `core/rule-view.ts` does.
 *
 * ── Matching is CONSERVATIVE, at tool granularity ────────────────────────────
 * Only a BARE allow (`"Bash"`, no parentheses) counts as an override: it lets every
 * call to that tool through. A SCOPED allow (`"Bash(git:*)"`) is narrower — it covers
 * only some commands — and this cannot prove a given guardrail's commands fall inside
 * that scope, so a scoped allow is NOT counted. That never claims a hold is dead when
 * it might still fire; the wording says "will not prompt" for the tools it does name.
 */

import { join } from "node:path";
import picomatch from "picomatch";
import type { Match } from "../engine/policy-predicate.js";
import type { GuardAction } from "./types.js";

/** Shell tools: the guard fills `detail` from `command`, so shell rules fire here. */
const SHELL_TOOLS = ["Bash", "PowerShell"] as const;

/** File tools: they carry `file_path`, which `file_glob` reads (`core/mapper.ts`). */
const FILE_TOOLS = ["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"] as const;

/** The tool names a `label` glob is expanded against. */
const LABEL_UNIVERSE = [...SHELL_TOOLS, ...FILE_TOOLS, "WebSearch", "WebFetch"] as const;

/** Claude Code's user settings path, honouring `CLAUDE_CONFIG_DIR`. */
export function claudeSettingsPath(home: string, configDir?: string): string {
  const dir =
    configDir !== undefined && configDir.trim().length > 0
      ? configDir.trim()
      : join(home, ".claude");
  return join(dir, "settings.json");
}

/**
 * The tools a guardrail's `match` can fire on, derived from its channels.
 *
 * Walks only the POSITIVE arms (`any_of`, `all_of`); `none_of` narrows and adds no
 * tool. A `label` glob is expanded against the known tool names; a `file_glob`
 * condition maps to the file tools; anything else (a `detail_*` condition, or a bare
 * `kind`) maps to the shell tools, the channel the guard fills from a command.
 */
export function toolsForMatch(match: Match): string[] {
  const tools = new Set<string>();
  const positive = [...(match.any_of ?? []), ...(match.all_of ?? [])];
  for (const condition of positive) {
    if (typeof condition.label === "string" && condition.label.length > 0) {
      let isMatch: (candidate: string) => boolean;
      try {
        isMatch = picomatch(condition.label, { nocase: true });
      } catch {
        continue; // an uncompilable label matches nothing rather than throwing
      }
      for (const tool of LABEL_UNIVERSE) if (isMatch(tool)) tools.add(tool);
    } else if (typeof condition.file_glob === "string") {
      for (const tool of FILE_TOOLS) tools.add(tool);
    } else {
      for (const tool of SHELL_TOOLS) tools.add(tool);
    }
  }
  return [...tools];
}

/**
 * Split one `permissions.allow` entry into its tool and whether it is scoped.
 *
 * `"Read"` → `{ tool: "Read", scoped: false }` (a broad allow of every Read call).
 * `"Bash(git:*)"` → `{ tool: "Bash", scoped: true }` (narrower — only some commands).
 * A blank entry, or one that is only a specifier, is `undefined`.
 */
export function allowedToolLabel(entry: string): { tool: string; scoped: boolean } | undefined {
  const trimmed = entry.trim();
  if (trimmed.length === 0) return undefined;
  const paren = trimmed.indexOf("(");
  if (paren === -1) return { tool: trimmed, scoped: false };
  const tool = trimmed.slice(0, paren).trim();
  if (tool.length === 0) return undefined;
  return { tool, scoped: true };
}

/**
 * Extract `permissions.allow` from `settings.json` text.
 *
 * `undefined` when there is no usable list: a missing file (text `undefined`), text
 * that is not JSON, or a shape without a `permissions.allow` array. A present but empty
 * array is `[]`. Non-string entries are dropped. Never throws — a broken settings file
 * must not make `status` or `init` fail.
 */
export function readPermissionAllow(text: string | undefined): string[] | undefined {
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const permissions = (parsed as Record<string, unknown>).permissions;
  if (permissions === null || typeof permissions !== "object" || Array.isArray(permissions)) {
    return undefined;
  }
  const allow = (permissions as Record<string, unknown>).allow;
  if (!Array.isArray(allow)) return undefined;
  return allow.filter((entry): entry is string => typeof entry === "string");
}

/** How many `require_approval` guardrails a settings allow list silently overrides. */
export interface ApprovalOverride {
  /** `require_approval` guardrails considered. */
  readonly total: number;
  /** Of those, how many fire on a tool the allow list permits outright. */
  readonly overridden: number;
  /** The allowed tool names responsible, unique and sorted. */
  readonly tools: readonly string[];
}

/**
 * Count the `require_approval` guardrails whose tool `settings.json` allows outright.
 *
 * `rules` carries each guardrail's effective action, so a pack that is off or an action
 * override is already reflected by the caller. Only bare (unscoped) allows count.
 */
export function approvalOverride(
  rules: readonly { readonly match: Match; readonly action: GuardAction }[],
  allow: readonly string[],
): ApprovalOverride {
  const approvals = rules.filter((rule) => rule.action === "require_approval");

  const broadlyAllowed = new Set<string>();
  for (const entry of allow) {
    const parsed = allowedToolLabel(entry);
    if (parsed !== undefined && !parsed.scoped) broadlyAllowed.add(parsed.tool);
  }

  const affectedTools = new Set<string>();
  let overridden = 0;
  for (const rule of approvals) {
    const hits = toolsForMatch(rule.match).filter((tool) => broadlyAllowed.has(tool));
    if (hits.length > 0) {
      overridden += 1;
      for (const tool of hits) affectedTools.add(tool);
    }
  }

  return { total: approvals.length, overridden, tools: [...affectedTools].sort() };
}

/**
 * The one message `status` and `init` both print — identical text, so the two cannot
 * drift. Empty when nothing is overridden, so callers print nothing on a clean setup.
 *
 * Two lines: the count with the tools named, then the mechanism. It names the tools
 * rather than the guardrails because the tool is what the reader controls in
 * `settings.json`; the guardrail count tells them the size of the hole.
 */
export function formatApprovalOverride(override: ApprovalOverride): string[] {
  if (override.overridden === 0) return [];
  return [
    `${override.overridden} of ${override.total} approval guardrails will not prompt because settings.json allows: ${override.tools.join(", ")}`,
    "Claude Code runs an allowed tool before the guard's hold can ask — the hold is skipped, though still recorded.",
  ];
}
