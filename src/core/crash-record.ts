/**
 * The crash record — what a crash report actually contains.
 *
 * Pure. No IO, no network, no clock of its own — everything variable arrives as a
 * parameter so the tests assert on bytes rather than on a snapshot of this machine.
 *
 * ── Stack traces only, and NOT the message ───────────────────────────────────
 * A crash report carries stack traces only. The subtle part is the error MESSAGE,
 * which reads like metadata and is not:
 *
 *     SyntaxError: Unexpected token 'r', "rm -rf /ho"... is not valid JSON
 *
 * That is the most likely crash in this binary — `JSON.parse` on the PreToolUse
 * payload — and its message embeds a literal slice of the command the user just ran.
 * A scrubber tuned for secret SHAPES will not catch it, because a command is not a
 * shape.
 *
 * Cleaning it is possible. It is also another filter that has to be right every
 * time, on data we have never seen, in a tool that promises to send nothing. So the
 * message is dropped entirely and we keep the error's CONSTRUCTOR NAME, which is a
 * closed set we control.
 *
 * **Adding the message later is easy. Un-sending one is not.**
 *
 * ── What is deliberately absent ──────────────────────────────────────────────
 * No message, no `cause` chain text, no `process.env`, no `argv`, no cwd, no command
 * string, no file contents. `command` below is the guard's own subcommand name
 * (`hook`, `scan`) from a fixed set — not anything the user typed.
 */

import { scrubPaths } from "./redact-stack.js";

/** The wire version. Bumped if the shape changes; the receiver switches on it. */
export const CRASH_RECORD_VERSION = 1;

/**
 * The secret scrubber, structurally typed.
 *
 * `core/scrub.ts` exports `scrubText(text: string): ScrubResult`, and a function
 * returning `ScrubResult` is assignable to this. Declaring the shape here rather than
 * importing the type keeps this module compiling and fully testable on its own,
 * **without** a second scrubber anywhere — which is the one thing this arrangement
 * exists to prevent.
 */
export type ScrubSecrets = (text: string) => { readonly text: string };

/** Everything about the run that is not the error itself. */
export interface CrashMeta {
  /** ISO-8601. Passed in so records are deterministic under test. */
  readonly ts: string;
  /** The guard's own version. */
  readonly guardVersion: string;
  /** `process.version`. */
  readonly nodeVersion: string;
  /** `process.platform`. */
  readonly platform: string;
  /** Which guard subcommand was running. A fixed set — never user input. */
  readonly command: "hook" | "scan" | "crash-report" | "unknown";
}

/** One crash, ready to spool and (only on an explicit send) transmit. */
export interface CrashRecord extends CrashMeta {
  readonly v: number;
  /** The error's constructor name, e.g. `TypeError`. Never its message. */
  readonly errorName: string;
  /** Redacted stack frames, one per line. May be empty. */
  readonly frames: string;
}

/** `Error`-ish enough to read a name and a stack off, without `instanceof`. */
function nameOf(err: unknown): string {
  if (err instanceof Error) return err.name;
  // `throw "boom"`, `throw undefined`, `throw {code: 1}` are all legal and all
  // reach here. They get a fixed label rather than any part of the thrown value.
  return "NonError";
}

function stackOf(err: unknown): string {
  if (err instanceof Error && typeof err.stack === "string") return err.stack;
  return "";
}

/**
 * Build the record. Never throws — a crash handler that can itself crash is worse
 * than no crash handler.
 *
 * ── Scrub the FIELD, then serialize. Never the other way round ──────────────
 * This function scrubs the raw stack STRING and returns an object; `crash-store.ts`
 * and `crash-transport.ts` serialize that already-clean object. Inverting it is a
 * LEAK, not a refactor: `JSON.stringify` escapes a quote to `\"`, and the `.env`
 * heuristic in `core/scrub.ts` has a quoted branch needing a literal `"` and an
 * unquoted branch excluding `"` — so neither matches the escaped form and the secret
 * passes through whole. Pinned by the ordering block in `crash-record.test.ts`,
 * negative control included.
 *
 * The scrub order WITHIN the field is `scrubPaths(scrubSecrets(stack))`: secrets first (value shapes,
 * which can appear anywhere in a line including inside a path), then the frame
 * allow-list (structure, which discards whole locations). Running them the other way
 * would hand the secret scrubber a string the allow-list had already reduced to
 * `<external>`, hiding a secret it should have counted — and, more importantly,
 * losing the belt-and-braces property that either pass alone would have caught most
 * of it. `crash-record.test.ts` pins both halves as load-bearing.
 */
export function buildCrashRecord(
  err: unknown,
  meta: CrashMeta,
  scrubSecrets: ScrubSecrets,
): CrashRecord {
  let frames = "";
  try {
    frames = scrubPaths(scrubSecrets(stackOf(err)).text);
  } catch {
    // A throw from either scrubber must not lose the crash. An empty frame list is
    // a usable record; an exception here would be a second, unreported crash.
    frames = "";
  }
  return {
    v: CRASH_RECORD_VERSION,
    ts: meta.ts,
    guardVersion: meta.guardVersion,
    nodeVersion: meta.nodeVersion,
    platform: meta.platform,
    command: meta.command,
    errorName: nameOf(err),
    frames,
  };
}
