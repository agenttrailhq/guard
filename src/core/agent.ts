// cspell:words codx
/**
 * Which app a hook run belongs to, and the one place a dispatch over `AgentSource` is
 * made exhaustive.
 *
 * Two questions with separate answers:
 * - the hook's `--agent` flag says which app's hook configuration LAUNCHED this run;
 * - the payload's shape says which app SENT the call.
 *
 * Each app's hook command names the app, for example
 * `node guard-hook.mjs --agent claude`. The flag is read by hand, not with `node:util`'s
 * `parseArgs`, so the hook bundle gains no import.
 *
 * ── The flag is ADVISORY on the hook path ────────────────────────────────────
 * It used to be authoritative-with-a-default: any value that was not `cursor` became
 * `claude`, so `--agent codx` silently answered as Claude Code. Now an unrecognized
 * value is `undefined` — no claim — and the payload decides. It is not an error: a hook
 * that refuses to run is a hook that protects nothing, so there is no throw anywhere on
 * this path. `commands/hook.ts` records a payload that no app claims.
 *
 * On the CLI path the opposite holds: `commands/agent-choice.ts` refuses an unknown
 * `--agent` outright, because there `init`/`uninstall`/`scan` would otherwise act on the
 * wrong app's files.
 *
 * ── Every app must be named, or the build fails ──────────────────────────────
 * `unhandledAgent` below is the default arm of every switch over `AgentSource` in this
 * package. Adding a name to `AGENTS` then fails to COMPILE at each switch that has no
 * branch for it. That is the point: before it existed, each consumer was a ternary
 * falling back to Claude Code, so a new app compiled clean and was silently mislabelled.
 */

import {
  AGENTS,
  type AgentSource,
  type CodexHookPayload,
  type CursorHookPayload,
} from "./types.js";

/**
 * The default arm of every switch over `AgentSource`.
 *
 * The parameter is `never`, so the call only type-checks where the switch above it has
 * already covered every app. It throws because it is UNREACHABLE — reaching it would
 * mean the union was widened past the compiler, which no build allows. Callers on the
 * hook path sit inside `runHook`'s try, so even that impossible throw fails open.
 */
export function unhandledAgent(agent: never): never {
  throw new Error(`agenttrail-guard: no branch for agent ${String(agent)}`);
}

/**
 * The app's name as a person writes it — for the CLI's `--agent` menu, and for the scan
 * report's "whose sessions these are".
 *
 * One switch, so the menu and the report can never disagree about what an app is called.
 */
export function agentDisplayName(agent: AgentSource): string {
  switch (agent) {
    case "claude":
      return "Claude Code";
    case "cursor":
      return "Cursor";
    case "codex":
      return "Codex CLI";
    default:
      return unhandledAgent(agent);
  }
}

/**
 * Which hook protocol answers for an app: whose payload shape goes in, and whose answer
 * shape comes out.
 *
 * Deliberately a SEPARATE union rather than an `AgentSource`, so that a fourth app can
 * borrow a protocol without a fourth answer builder having to exist first. Widening it
 * breaks every consumer at compile time, which is how Codex's answers came to exist:
 * measured on codex-cli 0.154.0, `permissionDecision: "ask"` is rejected there and the
 * action RUNS, and an unknown output field voids the whole answer — so answering Codex on
 * Claude Code's protocol would have disabled most of the catalogue in silence.
 */
export type HookProtocol = "claude" | "cursor" | "codex";

/**
 * The hook protocol an app speaks.
 *
 * Each app answers in its own terms. Codex's payload IS Claude Code's shape plus two
 * identity fields, which is exactly why it gets its own arm: the payloads are alike and
 * the ANSWERS are not.
 */
export function hookProtocolOf(agent: AgentSource): HookProtocol {
  switch (agent) {
    case "cursor":
      return "cursor";
    case "claude":
      return "claude";
    case "codex":
      return "codex";
    default:
      return unhandledAgent(agent);
  }
}

/** `value` as an app name, when it is exactly one of `AGENTS`. */
function agentNamed(value: string | undefined): AgentSource | undefined {
  return AGENTS.find((name) => name === value);
}

/**
 * The app named by `--agent <name>` or `--agent=<name>` in `argv`, or `undefined` when
 * the command line names none.
 *
 * Only the exact names in `AGENTS` count, and the first `--agent` decides. No flag, a
 * flag with no value, a value that is another flag, and an unknown name all give
 * `undefined` — a claim the guard could not honour is NOT quietly turned into a
 * different app's claim. `commands/hook.ts` then lets the payload decide.
 *
 * Pure, and never throws.
 *
 * @param argv - the arguments after the script, such as `process.argv.slice(2)`.
 */
export function agentFromArgv(argv: readonly string[]): AgentSource | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--agent") return agentNamed(argv[i + 1]);
    if (arg?.startsWith("--agent=")) return agentNamed(arg.slice("--agent=".length));
  }
  return undefined;
}

/**
 * Cursor's own hook event names, as Cursor spells them.
 *
 * Measured: the first eleven are the names Cursor's own installer and hook log use, read
 * off a live Cursor 3.20 install; `beforeSubmitPrompt` and `stop` are the two
 * conversation-level events from Cursor's hooks documentation.
 *
 * A LIST, not "any name that starts lowercase". The old rule claimed every such payload
 * for Cursor, so a third app whose events happen to be camelCase would have been mapped
 * with Cursor's mapper and answered in Cursor's protocol, under Cursor's name in the
 * decision log — silently, since nothing about that is an error.
 */
const CURSOR_EVENTS: ReadonlySet<string> = new Set([
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "beforeShellExecution",
  "afterShellExecution",
  "beforeMCPExecution",
  "afterMCPExecution",
  "beforeReadFile",
  "beforeTabFileRead",
  "afterFileEdit",
  "subagentStart",
  "beforeSubmitPrompt",
  "stop",
]);

/** A JSON object: not `null`, and not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Did Cursor send this payload?
 *
 * True when `cursor_version` is a string — Cursor puts one on every payload — or when
 * `hook_event_name` is one of Cursor's own event names. Claude Code and Codex both name
 * their events in PascalCase (`PreToolUse`) and send no `cursor_version`.
 *
 * The launching flag cannot answer this on its own: Cursor can also run Claude Code
 * plugin hooks, and hands them Cursor's payload.
 *
 * Pure, and never throws.
 */
export function isCursorPayload(payload: unknown): payload is CursorHookPayload {
  if (!isRecord(payload)) return false;
  const { cursor_version, hook_event_name } = payload as CursorHookPayload;
  if (typeof cursor_version === "string") return true;
  return typeof hook_event_name === "string" && CURSOR_EVENTS.has(hook_event_name);
}

/**
 * Did Codex send this payload?
 *
 * Measured on codex-cli 0.154.0: every Codex hook payload carries a string `turn_id` AND
 * a string `model`, and Claude Code's documented payload has neither. The second tell is
 * the edit tool, `apply_patch`, which no other app here sends.
 *
 * This matters even under `--agent claude`: Codex can import Claude Code hooks and load
 * Claude-style plugins, so guard's Claude Code entry can find itself inside Codex. Both
 * tells are read off the payload, so that copy still recognises where it is.
 *
 * Pure, and never throws.
 */
export function isCodexPayload(payload: unknown): payload is CodexHookPayload {
  if (!isRecord(payload)) return false;
  const { turn_id, model, tool_name } = payload as CodexHookPayload;
  if (typeof turn_id === "string" && typeof model === "string") return true;
  return tool_name === "apply_patch";
}

/**
 * Did Claude Code send this payload?
 *
 * Claude Code is the one app here with no field of its own to look for, so this is the
 * residual and MUST be asked last: a Codex payload satisfies it too. What it asks is
 * that the payload look like a `PreToolUse` at all — a PascalCase `hook_event_name`, or
 * failing that the `tool_name`/`tool_input` pair the mapper reads.
 *
 * It exists so that "no app claims this payload" is a real answer rather than the
 * fallback: without it, every unrecognizable object would be read as Claude Code's and
 * nothing would ever be recorded as unknown.
 *
 * Pure, and never throws.
 */
export function isClaudeCodePayload(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  const event = payload.hook_event_name;
  if (typeof event === "string") return /^[A-Z]/.test(event);
  return typeof payload.tool_name === "string" || isRecord(payload.tool_input);
}

/**
 * The app that SENT this payload, or `undefined` when none of them claims it.
 *
 * Order is load-bearing. Cursor first, because its payload is the only one with a field
 * of its own. Codex next, because its payload is Claude Code's shape plus two extra
 * fields, so asking Claude Code first would swallow it. Claude Code last, as the residual.
 *
 * Pure, and never throws.
 */
export function detectAgent(payload: unknown): AgentSource | undefined {
  if (isCursorPayload(payload)) return "cursor";
  if (isCodexPayload(payload)) return "codex";
  if (isClaudeCodePayload(payload)) return "claude";
  return undefined;
}
