/**
 * THE ONLY WRITER TO STDOUT ON THE HOOK PATH.
 *
 * ── At most one JSON object, and nothing else ────────────────────────────────
 * Claude Code decides whether stdout is an answer or noise by its first and last
 * character (`hooks.md:784-788`): starts `{` AND ends `}` → parsed as JSON;
 * anything else → treated as plain text, discarded as a non-blocking error, and
 * THE TOOL CALL PROCEEDS. One stray `console.log`, one debug line, one colour
 * escape, and the guard is decorative while still looking installed.
 *
 * That is why this module is the single writer, why `color.ts` must never be
 * reachable from the hook path, and why `built-artifact.test.ts` asserts the built
 * bundle's stdout is empty or exactly one object with nothing around it.
 *
 * ── Never `allow` ────────────────────────────────────────────────────────────
 * A PreToolUse `"allow"` skips Claude Code's own permission prompt (hooks reference,
 * PreToolUse decision control). The guard only ever tightens a call, so it never
 * answers `allow`:
 *
 *   deny, ask            → `hookSpecificOutput` with the decision and its reason
 *   allow with a reason  → `{ "systemMessage": reason }` and no decision: a warn
 *                          match, or a call the guard could not evaluate
 *   allow with no reason → no output at all
 *
 * With no decision in its output, the call goes through Claude Code's normal
 * permission flow, as if the guard were not installed.
 *
 * ── Always exit 0. Never exit 2. Structurally ────────────────────────────────
 * Exit 2 is Claude Code's blocking signal and OVERRIDES the JSON decision,
 * including `allow` (`hooks.md:798`). Exit 1 is a non-blocking error and is not the
 * hazard (`hooks.md:836`).
 *
 * This file therefore contains NO `process.exit` at all, and the hook path never
 * assigns `process.exitCode`. That makes the invariant structural rather than
 * pattern-matched: a grep for a literal `exit(2)` would miss `process.exit(code)`
 * behind a variable and `process.exitCode = 2`, whereas "the bundle contains no
 * `process.exit(`" cannot be defeated by either.
 *
 * Letting the process end naturally also flushes stdout correctly on a pipe:
 * `process.exit()` is what makes truncated output a hazard in the first place.
 */

import type { PermissionDecision } from "./types.js";

/**
 * Build what the hook writes for one decision: a JSON object, or `""` for no output.
 *
 * `emit.test.ts` pins the exact field names: a renamed field would make Claude Code
 * read the output as plain text and run the tool.
 */
export function buildHookOutput(decision: PermissionDecision, reason: string): string {
  if (decision === "allow") {
    return reason === "" ? "" : JSON.stringify({ systemMessage: reason });
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  });
}

/** Somewhere to put one line of text. Injectable so tests never touch real stdio. */
export interface StdoutSink {
  write(text: string): void;
}

/**
 * Write the decision. Idempotent — the first call wins, so a late error path can
 * never append a second object and turn valid JSON into discarded plain text. A
 * first call that writes nothing still wins.
 */
export function createEmitter(stdout: StdoutSink): {
  emit(decision: PermissionDecision, reason: string): void;
  hasEmitted(): boolean;
} {
  let done = false;
  return {
    emit(decision, reason) {
      if (done) return;
      done = true;
      const text = buildHookOutput(decision, reason);
      if (text !== "") stdout.write(text);
    },
    hasEmitted() {
      return done;
    },
  };
}
