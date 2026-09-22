// cspell:words uncompilable
/**
 * `agenttrail-guard hook` — the runtime Claude Code, Cursor and Codex invoke before a
 * tool call.
 *
 * stdin JSON → map → normalize → evaluate → at most ONE JSON object → exit 0.
 *
 * stdin is read and parsed once, and then one of three paths answers:
 * - the Cursor path, Cursor's payload in and Cursor's answer out (`core/cursor-mapper.ts`,
 *   `core/cursor-emit.ts`), under `--agent cursor`, and for a Cursor payload under any
 *   flag: Cursor can run guard's Claude Code plugin and hand it Cursor's payload;
 * - the Codex path, the same way (`core/codex-mapper.ts`, `core/codex-emit.ts`), where an
 *   approval becomes a deny because Codex rejects `ask` and runs the action;
 * - otherwise the Claude Code path (`core/mapper.ts`, `core/emit.ts`).
 * All three load and evaluate the same rules, through `loadRules`.
 *
 * ── WHICH app, and which PROTOCOL, are two questions ─────────────────────────
 * `sentBy` is the app that sent the call: it is what a decision-log line names, and it is
 * decided by the payload's own shape (`core/agent.ts`), falling back to the `--agent`
 * flag and finally to Claude Code. `hookProtocolOf(sentBy)` then says which answer shape
 * goes back. They used to be one boolean, which is why Codex — whose payload is Claude
 * Code's shape plus two fields — would have been answered in Claude Code's terms, which
 * for an approval means an `ask` that Codex rejects while running the action. The switch
 * is in `core/agent.ts` and fails to compile for an app it has no branch for.
 *
 * ── A payload no app claims is RECORDED ──────────────────────────────────────
 * Answering it is not enough. `NOT_CHECKED_MESSAGE` goes to the agent, which relays it or
 * does not, and then the moment is gone: nothing on disk says guard saw something it
 * could not read. So an `UnattributedPayload` is spooled for it (see
 * `core/crash-capture.ts` — local, bounded, sent nowhere unless the user asks).
 *
 * It is a narrow case: only a payload that identifies no app AND arrived with no usable
 * `--agent`. An event guard DOES recognise and has no opinion on, such as Cursor's
 * `afterFileEdit`, stays silent — it was understood, and recording every one of those
 * would fill the spool with a healthy agent's ordinary traffic.
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
 * Cursor shows `{}` nowhere, so the crash record is its only trace. A Codex payload gets
 * the same message Claude Code gets, as `systemMessage`, which Codex shows in its terminal
 * UI and decides nothing by. Input that is not a JSON object cannot be told apart, so the
 * flag picks: `{}` under `--agent cursor`, the message otherwise.
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

import { detectAgent, hookProtocolOf, unhandledAgent } from "../core/agent.js";
import { SHIPPED_CATALOG } from "../core/catalog.js";
import {
  buildCodexAnswer,
  codexSystemMessage,
  createCodexEmitter,
  NO_ANSWER,
} from "../core/codex-emit.js";
import { codexCallKey, mapCodexCall } from "../core/codex-mapper.js";
import { parseConfig } from "../core/config.js";
import {
  buildCursorAnswer,
  createCursorEmitter,
  type EvaluatedCandidate,
  isGuardsCursorEntry,
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
  CodexHookPayload,
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

/**
 * The local record for a payload no supported app claims.
 *
 * Carries no payload and no message worth reading: `core/crash-record.ts` keeps an
 * error's CONSTRUCTOR NAME and its scrubbed stack, and drops the message entirely,
 * because a message is where a slice of the user's command ends up. So the name is the
 * whole signal, and it is a name a person can act on when it shows up in `crash-report`.
 */
class UnattributedPayload extends Error {
  constructor() {
    super("hook payload matched no supported app");
    this.name = "UnattributedPayload";
  }
}

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
   *
   * Omitted means the command line named no app guard knows — an absent flag, or a name
   * it does not recognise; `core/agent.ts` does not turn the second into the first. The
   * payload then decides, and Claude Code is the last resort.
   *
   * It is only ever the TIE-BREAKER. A payload that positively identifies its app
   * overrules it under any flag, because Cursor and Codex can both run guard's Claude
   * Code plugin and hand it their own payload. A decision-log line names the app that
   * SENT the call, not the one named here.
   */
  readonly agent?: AgentSource;
}

/**
 * The payload's `tool_use_id`, when it is a non-empty string.
 *
 * Used ONLY to dedupe a hook invoked twice for one tool call (`core/events.ts`); it never
 * reaches a rule or the decision log, so Cursor's "no id in the log" guarantee holds. Both
 * Claude Code and Cursor put a `tool_use_id` on the payload. Codex puts one on only ONE of
 * the two events it fires per action, so that path keys on `core/codex-mapper.ts`'s
 * `codexCallKey` instead and never comes here.
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
  // The app whose hook configuration launched this run, when its command line named one
  // guard knows. `undefined` is not an error: the flag is advisory here (`core/agent.ts`)
  // and the payload is the better witness.
  const launchedAs: AgentSource | undefined = deps.agent;
  const stdout: StdoutSink = { write: (text) => io.writeStdout(text) };
  const claudeEmitter = createEmitter(stdout);
  const cursorEmitter = createCursorEmitter(stdout);
  const codexEmitter = createCodexEmitter(stdout);

  // The app that sent the call, and therefore the protocol that answers. The flag decides
  // until the payload is parsed, and the payload then overrules it: Cursor and Codex can
  // each run guard's Claude Code plugin and hand it their own payload. Set before either
  // emitter writes, so only one of them can ever write.
  let sentBy: AgentSource = launchedAs ?? "claude";
  let protocol = hookProtocolOf(sentBy);

  try {
    // stdin is read and parsed once, here. Every path takes the parsed payload.
    const payload = parsePayload(await io.readStdin());

    // A POSITIVE identification overrules the flag; the residual one does not.
    // `detectAgent` recognises Cursor and Codex by fields of their own, and calls
    // everything else that looks like a `PreToolUse` Claude Code's. The first kind may
    // overrule the flag, because Cursor and Codex can each run guard's Claude Code plugin
    // and hand it their own payload, and that copy has to answer in their terms. The
    // second must not: under `--agent cursor` the answer is read by Cursor, and
    // `hookSpecificOutput` there is not an answer at all.
    const detected = detectAgent(payload);
    if (detected !== undefined && (launchedAs === undefined || detected !== "claude")) {
      sentBy = detected;
      protocol = hookProtocolOf(sentBy);
    }

    if (detected === undefined && launchedAs === undefined) {
      // No app claims this payload and no flag named one, so there is no mapper to try
      // and nothing to evaluate it against. Fail open, say so, and — the part that is new
      // — leave a trace, because otherwise the moment is answered and then gone and
      // nobody can find out their hook is mis-wired. Nothing is read to do this.
      claudeEmitter.emit("allow", NOT_CHECKED_MESSAGE);
      try {
        deps.captureCrash?.(new UnattributedPayload());
      } catch {
        /* a failed record is never worth failing a tool call over */
      }
      return;
    }

    // One arm per protocol, with no fallback: a fourth protocol fails to COMPILE here
    // rather than being answered in some other app's terms.
    switch (protocol) {
      case "cursor":
        // `launchedAs`, not `sentBy`: on this path the payload is already known to be
        // Cursor's, and what is still open is whether guard's own Cursor entry is the one
        // asking or whether some other app's copy of guard received it.
        answerCursorCall(io, deps, payload, launchedAs, cursorEmitter);
        break;
      case "codex":
        answerCodexCall(io, deps, payload, codexEmitter);
        break;
      case "claude":
        answerClaudeCodeCall(io, deps, payload, sentBy, claudeEmitter);
        break;
      default:
        // Unreachable: the union above is exhausted. A throw here lands in the catch
        // below, which fails open like every other unforeseen error.
        unhandledAgent(protocol);
    }
  } catch (err) {
    // Unreadable stdin, malformed JSON, or any unforeseen throw. No decision: `{}` on
    // Cursor's protocol, otherwise a message that names no content — which Codex accepts
    // on every event and decides nothing by.
    if (protocol === "cursor") {
      cursorEmitter.emit(NO_OPINION);
    } else if (protocol === "codex") {
      codexEmitter.emit(codexSystemMessage(NOT_CHECKED_MESSAGE));
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
 *
 * `sentBy` is the app the payload came from, and it is written to the decision log
 * verbatim. It is `claude` in practice — Codex has answers of its own and is dispatched
 * before this — but it is taken from the payload rather than assumed, so a line can never
 * name the wrong app.
 */
function answerClaudeCodeCall(
  io: GuardIO,
  deps: HookDeps,
  payload: PreToolUsePayload,
  sentBy: AgentSource,
  emitter: ReturnType<typeof createEmitter>,
): void {
  const mapped = mapToolCall(payload);

  const { catalog, allowlist } = loadRules(io, deps);

  const decision = evaluateCall(catalog, buildGuardSpanContext(mapped), mapped, allowlist);

  emitter.emit(decision.decision, decision.reason);

  // Recording is best-effort and must never change the decision. The emit above
  // has already happened, so even a throw here cannot alter what Claude Code sees.
  try {
    // `agent` names the app that SENT the call, read off the payload rather than fixed
    // to `"claude"` — which is how Codex used to be mislabelled.
    // `callId` dedupes a double invocation and is never logged.
    (deps.recorder ?? createEventRecorder(io)).record({
      mapped,
      decision,
      agent: sentBy,
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
 * `launchedAs` is the app whose hook configuration launched the run. Anything but
 * `cursor` — including no flag at all — is some other app's copy of guard receiving a
 * Cursor call, and its answer depends on whether guard's own Cursor entries are installed
 * (`core/cursor-emit.ts`). Only then is `~/.cursor/hooks.json` read: never for a Claude
 * Code call, and never under `--agent cursor`.
 *
 * Every decision-log line written here says `agent: "cursor"`, whichever app launched it.
 */
function answerCursorCall(
  io: GuardIO,
  deps: HookDeps,
  payload: CursorHookPayload,
  launchedAs: AgentSource | undefined,
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
    !isGuardsCursorEntry(launchedAs) &&
    hasGuardCursorEntry(io.readFile(cursorHooksPath(io.homedir())));

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

/**
 * The Codex path: a Codex payload, or anything under `--agent codex`.
 *
 * A tool the guard has no channel for, and an event it does not answer, write nothing at
 * all without reading a file. A throw from here reaches `runHook`, which writes a message
 * saying the call was not checked and spools a crash record.
 *
 * Unlike the Cursor path this does not read the launching flag. Codex's answer is the same
 * whichever app's entry produced it: both of Codex's events are answered in full, neither
 * defers to the other, and there is no second checkpoint to leave an approval for — Codex
 * rejects `ask` and runs the action, so an approval is denied where it is seen.
 *
 * `callId` is the key from `core/codex-mapper.ts`, NOT the payload's `tool_use_id`:
 * `PermissionRequest` carries no id, so keying on one would write the same action's
 * decision twice. Every line written here says `agent: "codex"`.
 */
function answerCodexCall(
  io: GuardIO,
  deps: HookDeps,
  payload: CodexHookPayload,
  emitter: ReturnType<typeof createCodexEmitter>,
): void {
  const call = mapCodexCall(payload);

  // Nothing to evaluate: no answer, and no rule is read to decide that.
  if (call === undefined) {
    emitter.emit(NO_ANSWER);
    return;
  }

  const { catalog, allowlist } = loadRules(io, deps);
  const evaluate = (mapped: MappedCall): EvaluatedCandidate => ({
    mapped,
    decision: evaluateCall(catalog, buildGuardSpanContext(mapped), mapped, allowlist),
  });

  // A patch naming several files has one candidate each. The strictest verdict is
  // answered, and logged once — as a `Grep`'s two candidates are on the Cursor path.
  const [first, ...rest] = call.candidates;
  const kept = strictestCandidate([evaluate(first), ...rest.map(evaluate)]);

  const answer = buildCodexAnswer({ event: call.event, decision: kept.decision });
  emitter.emit(answer.output);

  // As on the other paths: after the answer is out, best-effort, never fatal.
  if (answer.record) {
    try {
      (deps.recorder ?? createEventRecorder(io)).record({
        mapped: kept.mapped,
        decision: kept.decision,
        agent: "codex",
        callId: codexCallKey(payload),
      });
    } catch {
      /* a failed write is not a reason to block a developer's command */
    }
  }
}
