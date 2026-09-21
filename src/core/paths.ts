/**
 * Where the guard keeps its state, `~/.agenttrail/guard/`, and where it finds Cursor's
 * hooks file.
 */

import { join } from "node:path";

/** The guard's config directory. */
export function guardDir(homedir: string): string {
  return join(homedir, ".agenttrail", "guard");
}

/** `config.json` — packs, action overrides, allowlist. */
export function configPath(homedir: string): string {
  return join(guardDir(homedir), "config.json");
}

/** `guardrails.json` — the user's own guardrails. Read by the `guardrails` surface. */
export function userRulesPath(homedir: string): string {
  return join(guardDir(homedir), "guardrails.json");
}

/** `events.jsonl` — the local decision log. Written by `core/events.ts`. */
export function eventsPath(homedir: string): string {
  return join(guardDir(homedir), "events.jsonl");
}

/**
 * `.last-decision` — a one-line marker holding a HASH of the last decision the recorder
 * wrote, so the recorder can tell a duplicate hook invocation from a fresh call.
 *
 * Each hook run is its own process, so the marker is how one run's key reaches the next.
 * It is a hash and a timestamp only — never a command, never a tool_use_id in the clear —
 * so nothing here is a decision-log line or a rule input. Deleting it is always safe.
 */
export function dedupMarkerPath(homedir: string): string {
  return join(guardDir(homedir), ".last-decision");
}

/**
 * `crashes/` — the local crash spool.
 *
 * A DIRECTORY, not a file, because `hook` can run many times concurrently and
 * appending to one file from several processes interleaves partial writes. One
 * atomic file per crash sidesteps locking entirely.
 *
 * Nothing here is ever sent unless the user has turned crash reporting on AND runs
 * `agenttrail-guard crash-report --send`. Deleting the directory is always safe.
 */
export function crashesDir(homedir: string): string {
  return join(guardDir(homedir), "crashes");
}

/**
 * `~/.cursor/hooks.json` — Cursor's user hooks file, which holds guard's Cursor entries.
 *
 * Cursor owns this file. The hook only reads it, and only when guard's Claude Code plugin
 * receives a Cursor call (`commands/hook.ts`).
 */
export function cursorHooksPath(homedir: string): string {
  return join(homedir, ".cursor", "hooks.json");
}

/**
 * `cursor/` — what `init --agent cursor` keeps (`cursor/install.ts`). The hook never reads
 * anything in it.
 */
export function guardCursorDir(homedir: string): string {
  return join(guardDir(homedir), "cursor");
}

/** `cursor/guard-hook.mjs` — the copy of the hook that guard's Cursor entries run. */
export function cursorHookCopyPath(homedir: string): string {
  return join(guardCursorDir(homedir), "guard-hook.mjs");
}

/** `cursor/hooks.json.backup` — `~/.cursor/hooks.json` as it was before the first install. */
export function cursorHooksBackupPath(homedir: string): string {
  return join(guardCursorDir(homedir), "hooks.json.backup");
}

/** `cursor/hooks.json.was-absent` — present when there was no `~/.cursor/hooks.json` before the first install. */
export function cursorHooksAbsentPath(homedir: string): string {
  return join(guardCursorDir(homedir), "hooks.json.was-absent");
}

/** `cursor/install.json` — `{installedAt, hookPath, nodePath, guardVersion}`. */
export function cursorInstallRecordPath(homedir: string): string {
  return join(guardCursorDir(homedir), "install.json");
}
