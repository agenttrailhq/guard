/**
 * A library rule's own BLOCK FIXTURES — the exact commands and paths it exists to catch.
 *
 * ── CLI-only, and that is deliberate ─────────────────────────────────────────
 * Imported by `guardrails allow` and `status`, never by the hook. `getRule` comes from the
 * same zero-cost `@agenttrail/guardrails/guardrails` subpath the catalog uses, so this adds
 * no zod; and because nothing on the hook path imports this module, none of it reaches the
 * bundle Claude Code runs before every tool call.
 *
 * A guardrail the user wrote (`guardrails.json`) carries no fixtures, and an unknown id has
 * no rule, so both yield `[]`. Only the shipped library has fixtures to guard.
 */

import { getRule } from "@agenttrail/guardrails/guardrails";

/**
 * The command / file-path strings of a library rule's `block` fixtures.
 *
 * These are the shapes the guardrail is asserted to catch, so allowlisting one of them would
 * blind the guardrail to exactly what it guards against. `allow-guard.ts` and `status` refuse
 * to propose or accept a pattern that matches one of them.
 */
export function blockFixtureCommands(ruleId: string): readonly string[] {
  const rule = getRule(ruleId);
  if (rule === undefined) return [];
  return rule.fixtures.block.map((fixture) =>
    "command" in fixture ? fixture.command : fixture.file_path,
  );
}
