/**
 * `--agent` on `init` and `uninstall`: which app to install guard for, or remove it from.
 *
 * The flag is required, and only the exact names `claude` and `cursor` count. With the
 * CLI's options, `node:util`'s `parseArgs` gives a lone `--agent` as `true`, and in
 * `--agent --print` takes `--print` as the value, so both are refused here along with a
 * missing flag and any other name.
 */

import type { AgentSource } from "../core/types.js";

/** The app an `--agent` value names, when it is exactly `claude` or `cursor`. */
export function chosenAgent(value: unknown): AgentSource | undefined {
  return value === "claude" || value === "cursor" ? value : undefined;
}

/** What `command` prints, before changing anything, when `--agent` names no supported app. */
export function agentChoiceMessage(command: string): string {
  return (
    `agenttrail-guard ${command}: choose --agent claude or --agent cursor.\n\n` +
    `  agenttrail-guard ${command} --agent claude   for Claude Code\n` +
    `  agenttrail-guard ${command} --agent cursor   for Cursor\n`
  );
}
