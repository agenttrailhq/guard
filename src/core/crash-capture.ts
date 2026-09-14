/**
 * `captureCrash` — what `hook` and `scan` do when they crash.
 *
 * They write to the local spool. They do not send, they cannot send, and
 * `net/crash-transport.ts` is not in their import graph — which is what lets
 * `no-network.test.ts` prove it with a parser instead of asserting it about a boolean.
 *
 * ── Note what is NOT gated on `crashReports` here ────────────────────────────
 * Capture runs regardless of the setting; only SENDING is gated. Two reasons, and
 * the second is the one that matters:
 *
 *   1. Capture is a local file under the user's own `~/.agenttrail/guard/`, the same
 *      contract as `events.jsonl` — it never leaves the machine, and deleting it is
 *      always safe. Gating it would mean a user who turns reporting on after hitting
 *      a bug has nothing to send.
 *   2. Config is read from disk and CAN ITSELF BE THE THING THAT CRASHED. A capture
 *      path that must first parse config has a hole exactly where it is needed most.
 *
 * The user-visible promise is unaffected: nothing is transmitted without
 * `crashReports: true` AND an explicit `crash-report --send`.
 *
 * ── It can never throw, and never re-enters ──────────────────────────────────
 * Everything is inside one swallowing `try`, and a module-level flag stops a crash
 * inside the crash handler from recursing. A bug in the crash handler must not be able
 * to stop the agent.
 */

import type { GuardIO } from "../io.js";
import { buildCrashRecord, type CrashMeta, type ScrubSecrets } from "./crash-record.js";
import { spoolCrash } from "./crash-store.js";

/** Re-entry guard: one capture per process, at most. */
let capturing = false;

/** Everything `captureCrash` needs that is not the error. Injected for tests. */
export interface CaptureDeps {
  readonly io: GuardIO;
  readonly scrubSecrets: ScrubSecrets;
  readonly command: CrashMeta["command"];
  readonly guardVersion: string;
  readonly now: () => number;
}

/**
 * Spool one crash. Returns whether it was written, for tests — no caller on the hook
 * path acts on the result, because there is no useful action to take.
 */
export function captureCrash(err: unknown, deps: CaptureDeps): boolean {
  if (capturing) return false;
  capturing = true;
  try {
    const now = deps.now();
    const record = buildCrashRecord(
      err,
      {
        ts: new Date(now).toISOString(),
        guardVersion: deps.guardVersion,
        nodeVersion: process.version,
        platform: process.platform,
        command: deps.command,
      },
      deps.scrubSecrets,
    );
    return spoolCrash(deps.io, record, now);
  } catch {
    // A failure to record a crash is not itself worth reporting anywhere. There is
    // no channel that would not risk making things worse.
    return false;
  } finally {
    capturing = false;
  }
}

/** Test-only: reset the re-entry flag between cases. */
export function resetCaptureGuardForTests(): void {
  capturing = false;
}
