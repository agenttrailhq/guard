// cspell:words uncompilable
/**
 * `agenttrail-guard hook` — the runtime Claude Code invokes before every tool call.
 *
 * stdin JSON → map → normalize → evaluate → ONE JSON object → exit 0.
 *
 * ── Fail-open is the whole contract ────────────────────────────
 * A bug in the guard must never stop the agent. So EVERY error path here emits `allow`
 * and returns normally: unreadable stdin, malformed JSON, a missing or corrupt config,
 * an uncompilable rule, an evaluator that throws, a recorder that throws. There is no
 * path that denies on error and no path that exits non-zero.
 *
 * ── No internal watchdog, on purpose ─────────────────────────────────
 * Claude Code's default `timeout` for a command hook is 600s (`hooks.md:428`); we
 * set `"timeout": 10` in our own `plugin/hooks/hooks.json`. No watchdog is needed
 * because overrun already fails the way we want: "On PreToolUse … a timed-out
 * command hook lets the tool call continue" (`hooks.md:3186`). An overrunning guard
 * allows, which is the fail-open posture.
 *
 * That also makes compile-once (`rules.ts`) a requirement rather than an
 * optimization: nothing else keeps a 56-rule catalog inside a 10s budget.
 */

import { SHIPPED_CATALOG } from "../core/catalog.js";
import { parseConfig } from "../core/config.js";
import { createEmitter } from "../core/emit.js";
import { compileAllowlist, evaluateCall } from "../core/evaluate.js";
import { createEventRecorder, type EventRecorder } from "../core/events.js";
import { mapToolCall } from "../core/mapper.js";
import { buildGuardSpanContext } from "../core/normalize.js";
import { configPath, userRulesPath } from "../core/paths.js";
import { compileCatalog } from "../core/rules.js";
import type { GuardRule, PreToolUsePayload } from "../core/types.js";
import { parseUserRulesData } from "../core/user-rules-data.js";
import type { GuardIO } from "../io.js";

/** Overrides for tests. Production passes nothing and gets the bundled catalog. */
export interface HookDeps {
  /** The rule catalog. `@agenttrail/guardrails` arrives through here. */
  readonly catalog?: readonly GuardRule[];
  /**
   * Decision log sink. Defaults to the real `events.jsonl` writer; tests pass
   * `NOOP_RECORDER` (or a spy) so no suite touches a real home directory.
   */
  readonly recorder?: EventRecorder;
  /**
   * Crash sink. Writes to a LOCAL spool and nothing else — there is no
   * network on this path and `net/crash-transport.ts` is not in this module's
   * import graph, which `no-network.test.ts` proves with a parser.
   *
   * Also the seam the tests use to force a crash. The released binary has no switch
   * that makes it fail, so the fault is injected here instead.
   */
  readonly captureCrash?: (err: unknown) => void;
}

/** Parse the payload. Anything that is not a JSON object is rejected. */
function parsePayload(input: string): PreToolUsePayload {
  const parsed: unknown = JSON.parse(input);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("PreToolUse payload is not a JSON object");
  }
  return parsed as PreToolUsePayload;
}

/**
 * Run the hook.
 *
 * Always resolves, never rejects, and never touches `process.exitCode` — so the
 * process ends at 0 whatever happened. Writes exactly one JSON object to stdout.
 */
export async function runHook(io: GuardIO, deps: HookDeps = {}): Promise<void> {
  const emitter = createEmitter({ write: (text) => io.writeStdout(text) });

  try {
    const payload = parsePayload(await io.readStdin());
    const mapped = mapToolCall(payload);

    // Config is read fail-open: absent or corrupt both yield DEFAULT_CONFIG.
    const config = parseConfig(io.readFile(configPath(io.homedir())));

    // The user's OWN rules, from `guardrails.json`.
    //
    // Read here and nowhere else on this path. This file once never touched that file
    // at all: `init` seeded it, `status` counted it and printed "(N of them
    // yours)", the README documented it — and the hook never loaded it, so a rule a
    // user wrote enforced nothing while the tool said it did.
    //
    // `parseUserRulesData`, not `loadUserRules`: the latter validates with
    // `parsePolicyPredicate`, which is zod, and `built-artifact.test.ts` asserts this
    // bundle contains no `ZodError`/`ZodType`. Validation happens at WRITE time in
    // `guardrails add`; what arrives here is plain data, and `compileCatalog` already skips
    // per-rule on a predicate that will not compile.
    //
    // Fail-open, like the config read above: an unreadable or malformed file yields an
    // empty list, so a broken personal rules file can never take the shipped catalog
    // down with it.
    const userRules = parseUserRulesData(io.readFile(userRulesPath(io.homedir())));

    // COMPILE ONCE for the whole catalog, before any evaluation.
    const catalog = compileCatalog([...(deps.catalog ?? SHIPPED_CATALOG), ...userRules], config);
    const allowlist = compileAllowlist(config.allowlist);

    const decision = evaluateCall(catalog, buildGuardSpanContext(mapped), mapped, allowlist);

    emitter.emit(decision.decision, decision.reason);

    // Recording is best-effort and must never change the decision. The emit above
    // has already happened, so even a throw here cannot alter what Claude Code sees.
    try {
      (deps.recorder ?? createEventRecorder(io)).record({ mapped, decision });
    } catch {
      /* a failed write is not a reason to block a developer's command */
    }
  } catch (err) {
    // Unreadable stdin, malformed JSON, or any unforeseen throw. Allow, and say so
    // in a reason that names no content.
    emitter.emit("allow", "agenttrail-guard could not evaluate this action; allowing.");

    // Record it locally, AFTER the decision is already out. Best-effort and
    // strictly last: a throw from here cannot reach the emitter, cannot change the
    // decision, and cannot alter the exit code. `captureCrash` swallows internally
    // too — this second guard exists because the seam is injectable and a test
    // double could throw where the real one would not.
    try {
      deps.captureCrash?.(err);
    } catch {
      /* a failed crash record is never worth failing a tool call over */
    }
  }
}
