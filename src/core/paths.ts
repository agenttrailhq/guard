/**
 * Where the guard keeps its state, `~/.agenttrail/guard/`, and where it finds each other
 * app's hooks file.
 *
 * ── Every path here is load-bearing for REMOVAL, not just for install ────────
 * `uninstall` deletes what these name and `status --clear-history` empties what
 * `eventsPath` names. A path that drifts does not fail loudly: the install still works,
 * and the uninstall quietly leaves a live hook entry behind pointing at a script the user
 * believes is gone. `paths.test.ts` pins every exported path for every app for that
 * reason.
 *
 * Nothing here touches the filesystem. Each function is `join` over a home directory the
 * caller supplies, so the tests need no real home.
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

/**
 * `~/.codex/hooks.json` — Codex CLI's user hooks file, which holds guard's Codex entry.
 *
 * Codex owns this file. Guard registers in it and NOWHERE ELSE: Codex also reads a
 * `[hooks]` table in `~/.codex/config.toml`, and the two layers AGGREGATE rather than
 * override, so an entry in both fires the hook twice for one tool call. JSON is also the
 * only one of the two guard can read back — it has no TOML parser and must not grow one.
 */
export function codexHooksPath(homedir: string): string {
  return join(homedir, ".codex", "hooks.json");
}

/**
 * `codex/` — what `init --agent codex` keeps. The hook never reads anything in it.
 *
 * Deliberately parallel to `cursor/`, file for file, so uninstall and status have one
 * shape to handle rather than one per app.
 */
export function guardCodexDir(homedir: string): string {
  return join(guardDir(homedir), "codex");
}

/**
 * `codex/guard-hook.mjs` — the copy of the hook that guard's Codex entry runs.
 *
 * A COPY, as for Cursor, not a reference into the Claude Code plugin's cache: Claude Code
 * deletes that cache on uninstall, which would leave Codex running a hook command whose
 * file no longer exists.
 */
export function codexHookCopyPath(homedir: string): string {
  return join(guardCodexDir(homedir), "guard-hook.mjs");
}

/** `codex/hooks.json.backup` — `~/.codex/hooks.json` as it was before the first install. */
export function codexHooksBackupPath(homedir: string): string {
  return join(guardCodexDir(homedir), "hooks.json.backup");
}

/** `codex/hooks.json.was-absent` — present when there was no `~/.codex/hooks.json` before the first install. */
export function codexHooksAbsentPath(homedir: string): string {
  return join(guardCodexDir(homedir), "hooks.json.was-absent");
}

/** `codex/install.json` — `{installedAt, hookPath, nodePath, guardVersion}`, as Cursor's. */
export function codexInstallRecordPath(homedir: string): string {
  return join(guardCodexDir(homedir), "install.json");
}
