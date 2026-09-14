/**
 * Where the guard keeps its state: `~/.agenttrail/guard/`.
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
