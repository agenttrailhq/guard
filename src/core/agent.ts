/**
 * Which app a hook run belongs to.
 *
 * Two questions with separate answers:
 * - the hook's `--agent` flag says which app's hook configuration LAUNCHED this run;
 * - the payload's shape says which app SENT the call.
 *
 * Each app's hook command names the app, for example
 * `node guard-hook.mjs --agent claude`. The flag is read by hand, not with `node:util`'s
 * `parseArgs`, so the hook bundle gains no import.
 */

import type { AgentSource, CursorHookPayload } from "./types.js";

/** `value` as an app name, when it is exactly one. */
function agentNamed(value: string | undefined): AgentSource | undefined {
  return value === "claude" || value === "cursor" ? value : undefined;
}

/**
 * The app named by `--agent <name>` or `--agent=<name>` in `argv`.
 *
 * Only the exact names `claude` and `cursor` count, and the first `--agent` decides.
 * No flag, a flag with no value, a value that is another flag, and an unknown name all
 * give `claude`, so a Claude Code hook command written without the flag keeps working.
 *
 * Pure, and never throws.
 *
 * @param argv - the arguments after the script, such as `process.argv.slice(2)`.
 */
export function agentFromArgv(argv: readonly string[]): AgentSource {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--agent") return agentNamed(argv[i + 1]) ?? "claude";
    if (arg?.startsWith("--agent=")) return agentNamed(arg.slice("--agent=".length)) ?? "claude";
  }
  return "claude";
}

/**
 * Did Cursor send this payload?
 *
 * True when `cursor_version` is a string, or when `hook_event_name` is a string that
 * starts with a lowercase letter. Cursor names its events in camelCase (`preToolUse`,
 * `beforeShellExecution`) and puts `cursor_version` on every payload. Claude Code names
 * its events in PascalCase (`PreToolUse`) and sends no `cursor_version`.
 *
 * The launching flag cannot answer this on its own: Cursor can also run Claude Code
 * plugin hooks, and hands them Cursor's payload.
 *
 * Pure, and never throws.
 */
export function isCursorPayload(payload: unknown): payload is CursorHookPayload {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
  const { cursor_version, hook_event_name } = payload as CursorHookPayload;
  if (typeof cursor_version === "string") return true;
  return typeof hook_event_name === "string" && /^[a-z]/.test(hook_event_name);
}
