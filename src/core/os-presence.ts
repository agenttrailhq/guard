/**
 * Whether AgentTrail OS enforces Cursor or Codex on this machine, for `init`'s coexistence
 * check. Mirrors the Claude Code check (`plugin/install.ts`): two hooks deciding every call
 * means two decisions and two prompts, so `init` declines.
 *
 * The signal is the per-machine record AgentTrail OS keeps for each app while its enforcement
 * is on, `~/.agenttrail/<app>/enforcement.json` with `{"v": 1, "enabled": true}`. Its hook
 * entries can live in each project's own hooks file, which `init` cannot enumerate; the record
 * covers all of them. AgentTrail OS does not enforce Codex yet, so that check finds nothing
 * today and starts to decline once it does.
 *
 * Reads only; a record that is missing or does not parse counts as not enforcing.
 */

import { join } from "node:path";

/** The record AgentTrail OS keeps for an app while it enforces there. */
export function osEnforcementRecordPath(home: string, app: "cursor" | "codex"): string {
  return join(home, ".agenttrail", app, "enforcement.json");
}

function enforcing(text: string | undefined): boolean {
  if (text === undefined) return false;
  try {
    const record: unknown = JSON.parse(text);
    return (
      record !== null &&
      typeof record === "object" &&
      (record as { v?: unknown }).v === 1 &&
      (record as { enabled?: unknown }).enabled === true
    );
  } catch {
    return false;
  }
}

/** AgentTrail OS enforces Cursor on this machine. */
export function osCursorPresent(
  readFile: (p: string) => string | undefined,
  home: string,
): boolean {
  return enforcing(readFile(osEnforcementRecordPath(home, "cursor")));
}

/** AgentTrail OS enforces Codex on this machine. */
export function osCodexPresent(readFile: (p: string) => string | undefined, home: string): boolean {
  return enforcing(readFile(osEnforcementRecordPath(home, "codex")));
}

/** What `init` prints when it declines, for the app named. */
export function osPresentMessage(app: "Cursor" | "Codex"): string {
  return (
    `AgentTrail OS is already enforcing ${app} on this machine.\n\n` +
    "It already checks every tool call there. Running both would mean two hooks\n" +
    "deciding on every tool call: two prompts, twice the latency, no benefit.\n" +
    "Leaving your setup untouched.\n\n" +
    "Nothing was written and nothing was changed.\n"
  );
}
