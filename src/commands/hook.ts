// cspell:words uncompilable
/**
 * `agenttrail-guard hook` — the runtime Claude Code and Cursor invoke before a tool call.
 *
 * stdin JSON → map → normalize → evaluate → at most ONE JSON object → exit 0.
 *
 * stdin is read and parsed once, and then one of two paths answers:
 * - the Cursor path, Cursor's payload in and Cursor's answer out (`core/cursor-mapper.ts`,
 *   `core/cursor-emit.ts`), under `--agent cursor`, and for a Cursor payload under any
 *   flag: Cursor can run guard's Claude Code plugin and hand it Cursor's payload;
 * - otherwise the Claude Code path (`core/mapper.ts`, `core/emit.ts`).
 * Both paths load and evaluate the same rules, through `loadRules`.
 *
 * ── Fail-open is the whole contract ────────────────────────────
 * A bug in the guard must never stop the agent. So EVERY error path here gives no
 * decision and returns normally: unreadable stdin, malformed JSON, a missing or
 * corrupt config, an uncompilable rule, an evaluator that throws, a recorder that
 * throws. There is no path that denies on error and no path that exits non-zero.
 *
 * Failing open never means answering `allow`, which would also skip Claude Code's
 * own permission prompt (see `core/emit.ts`). A call the guard could not evaluate
 * gets a message saying so, and goes through Claude Code's normal permission flow.
 * Once the payload is known to be Cursor's, it gets `{}` instead, under either flag.
 * Cursor shows `{}` nowhere, so the crash record is its only trace. Input that is not a
 * JSON object cannot be told apart, so the flag picks: `{}` under `--agent cursor`, the
 * message otherwise.
 *
 * ── No internal watchdog, on purpose ─────────────────────────────────
 * Claude Code's default `timeout` for a command hook is 600s (`hooks.md:428`); we
 * set `"timeout": 10` in our own `plugin/hooks/hooks.json`. No watchdog is needed
 * because overrun already fails the way we want: "On PreToolUse … a timed-out
 * command hook lets the tool call continue" (`hooks.md:3186`). An overrunning guard
 * gives no decision, which is the fail-open posture. Cursor lets a timed-out hook's
 * call through too, unless the entry sets `failClosed`.
 *
 * That also makes compile-once (`rules.ts`) a requirement rather than an
 * optimization: nothing else keeps a 56-rule catalog inside a 10s budget.
 */

import { isCursorPayload } from "../core/agent.js";
import { SHIPPED_CATALOG } from "../core/catalog.js";
import { parseConfig } from "../core/config.js";
import {
  buildCursorAnswer,
  createCursorEmitter,
  type EvaluatedCandidate,
  NO_OPINION,
  strictestCandidate,
} from "../core/cursor-emit.js";
import { hasGuardCursorEntry } from "../core/cursor-entry.js";
import { mapCursorCall } from "../core/cursor-mapper.js";
import { createEmitter, type StdoutSink } from "../core/emit.js";
import { type CompiledAllowlist, compileAllowlist, evaluateCall } from "../core/evaluate.js";
import { createEventRecorder, type EventRecorder } from "../core/events.js";
import { mapToolCall } from "../core/mapper.js";
import { buildGuardSpanContext } from "../core/normalize.js";
import { configPath, cursorHooksPath, userRulesPath } from "../core/paths.js";
import { type CompiledRule, compileCatalog } from "../core/rules.js";
import type {
  AgentSource,
  CursorHookPayload,
  GuardRule,
  MappedCall,
  PreToolUsePayload,
} from "../core/types.js";
import { parseUserRulesData } from "../core/user-rules-data.js";
import type { GuardIO } from "../io.js";

/** Shown to the user when the guard could not evaluate a call. Names no content. */
export const NOT_CHECKED_MESSAGE =
  "agenttrail-guard could not evaluate this action; it was not checked.";

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
  /**
   * The app whose hook configuration launched this run, from the `--agent` flag.
   * Omitted means `claude`.
   *
   * `cursor` runs the Cursor path. Otherwise a Cursor payload still runs the Cursor path,
   * answered as guard's Claude Code plugin, and any other payload is read as Claude Code's.
   * A decision-log line names the app that SENT the call: `cursor` for every Cursor
   * payload, `claude` for Claude Code's.
   */
  readonly agent?: AgentSource;
}

/**
 * The payload's `tool_use_id`, when it is a non-empty string.
 *
 * Used ONLY to dedupe a hook invoked twice for one tool call (`core/events.ts`); it never
 * reaches a rule or the decision log, so Cursor's "no id in the log" guarantee holds. Both
 * Claude Code and Cursor put a `tool_use_id` on the payload.
 */
function callIdOf(payload: PreToolUsePayload | CursorHookPayload): string | undefined {
  const id = (payload as { tool_use_id?: unknown }).tool_use_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** Parse the payload. Anything that is not a JSON object is rejected. */
function parsePayload(input: string): PreToolUsePayload {
  const parsed: unknown = JSON.parse(input);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("PreToolUse payload is not a JSON object");
  }
  return parsed as PreToolUsePayload;
}

/** The rules one call is evaluated against. Shared by both paths, so they cannot drift. */
function loadRules(
  io: GuardIO,
  deps: HookDeps,
): { catalog: readonly CompiledRule[]; allowlist: CompiledAllowlist } {
  // Config is read fail-open: absent or corrupt both yield DEFAULT_CONFIG.
  const config = parseConfig(io.readFile(configPath(io.homedir())));

  // The user's OWN rules, from `guardrails.json`.
  //
  // Read here and nowhere else on the hook path. This file once never touched that file
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
  return { catalog, allowlist };
}

/**
 * Run the hook.
 *
 * Always resolves, never rejects, and never touches `process.exitCode` — so the
 * process ends at 0 whatever happened. Writes at most one JSON object to stdout.
 */
export async function runHook(io: GuardIO, deps: HookDeps = {}): Promise<void> {
  const launchedAs: AgentSource = deps.agent === "cursor" ? "cursor" : "claude";
  const stdout: StdoutSink = { write: (text) => io.writeStdout(text) };
  const claudeEmitter = createEmitter(stdout);
  const cursorEmitter = createCursorEmitter(stdout);

  // Which emitter a failure answers with. The flag decides until the payload is parsed,
  // and a Cursor payload then switches it to Cursor's under either flag. It is set before
  // either path writes anything, so only one emitter can ever write.
  let cursorAnswers = launchedAs === "cursor";

  try {
    // stdin is read and parsed once, here. Both paths take the parsed payload.
    const payload = parsePayload(await io.readStdin());
    cursorAnswers = cursorAnswers || isCursorPayload(payload);

    if (cursorAnswers) {
      answerCursorCall(io, deps, payload, launchedAs, cursorEmitter);
    } else {
      answerClaudeCodeCall(io, deps, payload, claudeEmitter);
    }
  } catch (err) {
    // Unreadable stdin, malformed JSON, or any unforeseen throw. No decision: `{}` for a
    // Cursor payload or under `--agent cursor`, otherwise a message that names no content.
    if (cursorAnswers) {
      cursorEmitter.emit(NO_OPINION);
    } else {
      claudeEmitter.emit("allow", NOT_CHECKED_MESSAGE);
    }

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

/**
 * The Claude Code path: Claude Code's payload, answered with Claude Code's output.
 *
 * A throw from here reaches `runHook`, which answers that the call was not checked.
 */
function answerClaudeCodeCall(
  io: GuardIO,
  deps: HookDeps,
  payload: PreToolUsePayload,
  emitter: ReturnType<typeof createEmitter>,
): void {
  const mapped = mapToolCall(payload);

  const { catalog, allowlist } = loadRules(io, deps);

  const decision = evaluateCall(catalog, buildGuardSpanContext(mapped), mapped, allowlist);

  emitter.emit(decision.decision, decision.reason);

  // Recording is best-effort and must never change the decision. The emit above
  // has already happened, so even a throw here cannot alter what Claude Code sees.
  try {
    // `agent` names the app that sent the call. This path reads Claude Code's payload
    // shape, so it is `claude`. `callId` dedupes a double invocation and is never logged.
    (deps.recorder ?? createEventRecorder(io)).record({
      mapped,
      decision,
      agent: "claude",
      callId: callIdOf(payload),
    });
  } catch {
    /* a failed write is not a reason to block a developer's command */
  }
}

/**
 * The Cursor path: a Cursor payload, or anything under `--agent cursor`.
 *
 * An event the guard does not check answers `{}`, which is no opinion, without reading a
 * file. A throw from here reaches `runHook`, which answers `{}` and spools a crash record.
 *
 * `launchedAs` is the app whose hook configuration launched the run. Launched as `claude`,
 * this is guard's Claude Code plugin receiving a Cursor call, and its answer depends on
 * whether guard's own Cursor entries are installed (`core/cursor-emit.ts`). Only then is
 * `~/.cursor/hooks.json` read: never for a Claude Code call, and never under
 * `--agent cursor`.
 *
 * Every decision-log line written here says `agent: "cursor"`, whichever app launched it.
 */
function answerCursorCall(
  io: GuardIO,
  deps: HookDeps,
  payload: CursorHookPayload,
  launchedAs: AgentSource,
  emitter: ReturnType<typeof createCursorEmitter>,
): void {
  const call = mapCursorCall(payload);

  // An event the guard does not check gets no opinion, without reading a rule.
  if (call === undefined) {
    emitter.emit(NO_OPINION);
    return;
  }

  const { catalog, allowlist } = loadRules(io, deps);
  const evaluate = (mapped: MappedCall): EvaluatedCandidate => ({
    mapped,
    decision: evaluateCall(catalog, buildGuardSpanContext(mapped), mapped, allowlist),
  });

  // A `Grep` can have two candidates. The stricter verdict is answered, and logged once.
  const [first, ...rest] = call.candidates;
  const kept = strictestCandidate([evaluate(first), ...rest.map(evaluate)]);

  // Missing or unreadable counts as not installed: `readFile` returns `undefined`, and
  // `hasGuardCursorEntry` answers `false` for anything it cannot read.
  const cursorEntryPresent =
    launchedAs === "claude" && hasGuardCursorEntry(io.readFile(cursorHooksPath(io.homedir())));

  const answer = buildCursorAnswer({
    launchedAs,
    event: call.event,
    tool: call.cursorTool,
    decision: kept.decision,
    cursorEntryPresent,
  });
  emitter.emit(answer.output);

  // As on the Claude Code path: after the answer is out, best-effort, never fatal.
  if (answer.record) {
    try {
      (deps.recorder ?? createEventRecorder(io)).record({
        mapped: kept.mapped,
        decision: kept.decision,
        agent: "cursor",
        callId: callIdOf(payload),
      });
    } catch {
      /* a failed write is not a reason to block a developer's command */
    }
  }
}
