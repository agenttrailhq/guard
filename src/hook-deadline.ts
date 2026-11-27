/**
 * The hook's main thread: it reads the call, hands the check to a worker thread, writes the
 * one answer, and answers on its own when the check has not finished in time.
 *
 * ── Why a deadline at all ───────────────────────────────────────────────────
 * Every agent lets a call through when its hook overruns the entry's `timeout` (10 s in all
 * three of guard's entries), or dies without answering. So a check that ran too long would
 * be an allow, and any input that made evaluation slow would turn into one. The check runs
 * on a worker thread so that this thread stays free to answer at {@link HOOK_DEADLINE_MS},
 * however long a pattern takes to match. A timer on the same thread as the pattern could
 * not fire until the pattern returned.
 *
 * ── What this thread does, and does not do ──────────────────────────────────
 * It reads stdin (a stream, not the thread pool), parses it, and decides the deadline answer
 * from the payload's event and tool names alone. It reads no file. A thread blocked in a
 * system call cannot be stopped, and Node waits for it before the process can exit, so all
 * file access happens on the worker. If the worker is stuck that way, `terminate()` never
 * resolves, and after {@link TERMINATE_GRACE_MS} the hook ends itself with `SIGKILL`. The
 * agent then sees a hook that failed, which only the agent's own fail-closed setting blocks.
 *
 * ── The deadline answer ─────────────────────────────────────────────────────
 * The same approval guard gives a call it cannot check in full, in each app's own terms
 * (Codex has no approval, so there it is a deny). A call guard does not check at all keeps
 * today's no-opinion answer. Where AgentTrail OS enforces the project, guard stays silent
 * only after the worker has reported that every step-aside check passed: the sentinel
 * alone can come from a repository's own settings, and two decisions on one call are safer
 * than none.
 *
 * The answer names no content. It is written once: the first of the worker's answer and
 * the deadline's wins, and the other is dropped.
 */

import { NOT_CHECKED_MESSAGE } from "./commands/hook.js";
import { detectAgent, hookProtocolOf } from "./core/agent.js";
import { buildCodexAnswer, NO_ANSWER } from "./core/codex-emit.js";
import { codexCheckedEvent } from "./core/codex-mapper.js";
import { buildCursorAnswer, NO_OPINION } from "./core/cursor-emit.js";
import { cursorCheckedCall } from "./core/cursor-mapper.js";
import { buildHookOutput } from "./core/emit.js";
import type {
  AgentSource,
  CodexHookPayload,
  CursorHookPayload,
  GuardDecision,
} from "./core/types.js";

/** How long the check has, counted from the hook's start. Well inside the entries' 10 s. */
export const HOOK_DEADLINE_MS = 6_000;

/**
 * How long a terminated worker has to stop before the hook ends itself.
 *
 * Long on purpose. A worker that is only BUSY (a pattern still backtracking) stops when it
 * is terminated, but on a starved machine that can take well over a second: measured with 16
 * slow hooks on one CPU, a 250 ms grace killed 6 of them that were not stuck at all, and a
 * killed hook is a failed hook to every agent, so its answer can be ignored. Only a worker
 * blocked in a system call never stops. 6 s plus this is still inside the entries' 10 s.
 */
export const TERMINATE_GRACE_MS = 2_500;

/** Most memory the worker may use, so input that exhausts it ends the worker, not the hook. */
export const HOOK_WORKER_MAX_HEAP_MB = 256;

/** Marks the worker thread this module starts. */
export const HOOK_WORKER_ROLE = "agenttrail-guard-hook";

/** Shown when the check did not finish in time. Names no content. */
export const DEADLINE_REASON = "agenttrail-guard could not finish checking this action in time";

/** What the worker is started with. */
export interface HookWorkerInput {
  readonly role: typeof HOOK_WORKER_ROLE;
  /** stdin, as read. */
  readonly input: string;
  /** The app named by `--agent`, when it named one guard knows. */
  readonly agent?: AgentSource;
  /** The hook process's working folder and home, so the worker never derives its own. */
  readonly cwd: string;
  readonly home: string;
}

/** What the worker sends back. */
export type HookWorkerMessage =
  | { readonly kind: "stepAside"; readonly standDown: boolean }
  | { readonly kind: "answer"; readonly text: string };

/** The part of a `Worker` this module uses. */
export interface WorkerHandle {
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  terminate(): Promise<unknown>;
}

/** Everything the supervisor needs from the process. Injectable for tests. */
export interface SuperviseDeps {
  readonly agent?: AgentSource;
  readonly cwd: string;
  readonly home: string;
  readonly readStdin: () => Promise<string>;
  /** Write the answer to stdout; resolves once it is flushed. */
  readonly write: (text: string) => Promise<void>;
  readonly startWorker: (input: HookWorkerInput) => WorkerHandle;
  /** Run `fn` after `ms`; returns a cancel. */
  readonly schedule: (fn: () => void, ms: number) => () => void;
  /** Stop reading stdin, so a pipe nobody closes does not keep the process alive. */
  readonly releaseStdin: () => void;
  /** End the process now, whatever its threads are doing. */
  readonly killSelf: () => void;
  readonly deadlineMs?: number;
  readonly graceMs?: number;
}

/** An approval with nothing matched: what every app's builder turns into its own answer. */
const ASK: GuardDecision = { decision: "ask", reason: DEADLINE_REASON, matches: [] };

/** What the deadline answer is decided from. */
export interface DeadlineAnswerInput {
  readonly agent?: AgentSource;
  /** The parsed payload, or `undefined` when none arrived or it was not a JSON object. */
  readonly payload?: object;
  /** True only when the worker reported that every step-aside check passed. */
  readonly standDown: boolean;
}

/**
 * The answer written when the check has not finished in time. Pure and cheap: event and tool
 * names only, no file and no pattern.
 */
export function deadlineAnswer({ agent, payload, standDown }: DeadlineAnswerInput): string {
  if (payload === undefined) {
    // Nothing to read the app or the event from: the flag decides the protocol, and the
    // answer must be valid for every event guard's entry for that app is registered on.
    switch (hookProtocolOf(agent ?? "claude")) {
      case "cursor":
        // The approval-deny guard gives on `preToolUse`; a valid answer on both of guard's
        // Cursor events.
        return buildCursorAnswer({
          launchedAs: agent,
          event: "preToolUse",
          tool: "",
          decision: ASK,
          cursorEntryPresent: false,
        }).output;
      case "codex":
        // `PreToolUse` fires for every action, so this shape blocks there.
        return buildCodexAnswer({ event: "PreToolUse", decision: ASK }).output;
      default:
        return buildHookOutput("ask", DEADLINE_REASON);
    }
  }

  // The same choice of app `runHook` makes: a positive identification overrules the flag.
  const detected = detectAgent(payload);
  if (detected === undefined && agent === undefined) {
    return buildHookOutput("allow", NOT_CHECKED_MESSAGE);
  }
  let sentBy: AgentSource = agent ?? "claude";
  if (detected !== undefined && (agent === undefined || detected !== "claude")) sentBy = detected;

  switch (hookProtocolOf(sentBy)) {
    case "cursor": {
      const call = cursorCheckedCall(payload as CursorHookPayload);
      if (call === undefined) return NO_OPINION;
      return buildCursorAnswer({
        launchedAs: agent,
        event: call.event,
        tool: call.tool,
        decision: ASK,
        cursorEntryPresent: false,
      }).output;
    }
    case "codex": {
      const event = codexCheckedEvent(payload as CodexHookPayload);
      if (event === undefined) return NO_ANSWER;
      return buildCodexAnswer({ event, decision: ASK }).output;
    }
    default:
      return standDown ? "" : buildHookOutput("ask", DEADLINE_REASON);
  }
}

function isWorkerMessage(value: unknown): value is HookWorkerMessage {
  if (value === null || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "answer") return typeof (value as { text?: unknown }).text === "string";
  if (kind === "stepAside")
    return typeof (value as { standDown?: unknown }).standDown === "boolean";
  return false;
}

/**
 * Run one hook call: read it, check it on a worker, write one answer, and end.
 *
 * Resolves when nothing more will happen: the worker has ended, or the hook is ending itself.
 * Never rejects.
 */
export async function superviseHook(deps: SuperviseDeps): Promise<void> {
  const deadlineMs = deps.deadlineMs ?? HOOK_DEADLINE_MS;
  const graceMs = deps.graceMs ?? TERMINATE_GRACE_MS;

  let answered = false;
  let failing = false;
  let finished = false;
  let payload: object | undefined;
  let standDown = false;
  let worker: WorkerHandle | undefined;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const answer = async (text: string): Promise<void> => {
    if (answered) return;
    answered = true;
    if (text === "") return;
    try {
      await deps.write(text);
    } catch {
      /* stdout is gone; there is nobody left to answer */
    }
  };

  let cancelDeadline: () => void = () => {};
  const finish = (): void => {
    if (finished) return;
    finished = true;
    cancelDeadline();
    resolveDone();
  };

  // The check did not finish, or cannot: answer, stop the worker, and end.
  const failSafe = async (): Promise<void> => {
    if (failing) return;
    failing = true;
    await answer(deadlineAnswer({ agent: deps.agent, payload, standDown }));
    try {
      deps.releaseStdin();
    } catch {
      /* already closed */
    }
    const running = worker;
    if (running === undefined) {
      finish();
      return;
    }
    let stopped = false;
    const cancelKill = deps.schedule(() => {
      if (!stopped) deps.killSelf();
    }, graceMs);
    const stop = () => {
      stopped = true;
      cancelKill();
      finish();
    };
    running.terminate().then(stop, stop);
  };

  cancelDeadline = deps.schedule(() => {
    void failSafe();
  }, deadlineMs);

  // Not awaited: a stdin nobody closes must not keep this function from settling once the
  // deadline has answered.
  void start();
  return done;

  async function start(): Promise<void> {
    let input = "";
    try {
      input = await deps.readStdin();
    } catch {
      // Unreadable stdin: the worker gets nothing to parse and answers "not checked", as the
      // hook always has for this.
    }
    if (failing) return;

    try {
      const parsed: unknown = JSON.parse(input);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed;
    } catch {
      /* not JSON: the worker answers it, as before */
    }

    try {
      worker = deps.startWorker({
        role: HOOK_WORKER_ROLE,
        input,
        ...(deps.agent !== undefined ? { agent: deps.agent } : {}),
        cwd: deps.cwd,
        home: deps.home,
      });
    } catch {
      // A worker that cannot start has not checked anything.
      void failSafe();
      return;
    }

    const running = worker;
    running.on("message", (message) => {
      if (!isWorkerMessage(message)) return;
      if (message.kind === "stepAside") standDown = message.standDown;
      else void answer(message.text);
    });
    // An `error` here is the worker running out of memory or failing outside the check: the
    // check itself catches everything it throws. It is answered as the deadline is, not as
    // "not checked", because input can cause it on purpose.
    running.on("error", () => {
      void failSafe();
    });
    running.on("exit", () => {
      if (answered) finish();
      else void failSafe();
    });
  }
}
