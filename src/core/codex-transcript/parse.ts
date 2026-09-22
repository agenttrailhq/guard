/**
 * One Codex CLI session file, read line by line into the turns `scan` evaluates.
 *
 * Measured on codex-cli 0.154.0. Every line is one record, `{timestamp, type, payload}`:
 *
 *   {"timestamp":"…","type":"session_meta","payload":{"session_id":"…","cwd":"…","cli_version":"…"}}
 *   {"timestamp":"…","type":"response_item","payload":{"type":"message","role":"user","content":[…]}}
 *   {"timestamp":"…","type":"response_item","payload":{"type":"custom_tool_call","name":"exec","input":"…"}}
 *   {"timestamp":"…","type":"token_usage_record","payload":{"usage":{…},"turn_token_usage":{…}}}
 *   {"timestamp":"…","type":"event_msg","payload":{"type":"item_completed","item":{…}}}
 *
 * ── The ATTEMPT is read; the completed item is not ───────────────────────────
 * `event_msg`/`item_completed` carries a `CommandExecution` whose command is already
 * split into argv, and a `FileChange` whose paths are already parsed. Either looks like a
 * far easier source than the JavaScript inside a `custom_tool_call`. Both are the wrong
 * source, twice over.
 *
 * Measured: a call a pre-tool hook blocked writes a `custom_tool_call` and NO
 * `item_completed` — six of the twenty-one calls in the recorded sessions, every one of
 * them a block. A reader built on completed items would drop precisely the calls a guard
 * exists to show, and would report a quiet history for the machine where guard was doing
 * the most work. The two records also describe ONE action, so reading both would count it
 * twice. Only `custom_tool_call` is read here; `item_completed` is recognised and ignored.
 *
 * ── Tokens are REAL here, unlike Cursor's files ──────────────────────────────
 * `token_usage_record` reports the usage of ONE response in `usage`, and running totals
 * beside it in `turn_token_usage` and `thread_token_usage`. Only `usage` is summed: the
 * other two are cumulative, and summing either would multiply the total by the number of
 * responses. Its `input_tokens` INCLUDES the cached prefix, while `tokens.ts` adds its
 * four categories as disjoint amounts, so the cached count is subtracted out here — see
 * `codexUsage`. `reasoning_output_tokens` is already inside `output_tokens` (measured:
 * `input_tokens + output_tokens === total_tokens` with reasoning non-zero), so it is not
 * added either.
 *
 * ── Only tool calls are kept ─────────────────────────────────────────────────
 * `scan` evaluates tool calls and nothing else, so no message text is kept: a turn's
 * `text` and a prompt's `text` are empty. A prompt is still recorded, so a file holding
 * only prompts counts as a session. A `message` is a prompt only when its `role` is
 * `user`: the `developer` messages are the harness's own instructions, not the person's.
 *
 * ── A bad line never fails the file ──────────────────────────────────────────
 * Each line is parsed on its own, and what cannot be used is counted by kind:
 * - a line that is not JSON;
 * - the file's LAST line when it is not JSON, counted apart, because a file Codex is
 *   still writing ends in a cut-off line;
 * - a line that is JSON but no record above.
 * Only a failure of the line source itself (a file that cannot be opened or read to the
 * end) reaches the caller.
 */

import type { LineSource } from "../transcript/parse.js";
import type { ToolUse, Turn, Usage, UserPrompt } from "../transcript/transcript-types.js";

/** What one or more session files held that could not be used, by kind. */
export interface CodexLineCounts {
  /** Lines that are not JSON, other than a file's last line. */
  readonly unparseableLines: number;
  /** Files whose last line is not JSON, as a file still being written ends. */
  readonly truncatedLastLines: number;
  /** Lines that are JSON but not a record this reader knows. */
  readonly unknownRecords: number;
  /**
   * Always 0. Codex writes no end-of-turn record carrying a failure, so there is nothing
   * to count; the field exists because the report shares one shape across readers, and a
   * fabricated number would be worse than a stated zero.
   */
  readonly turnsEndedWithError: number;
}

/** No lines counted. */
export const NO_LINE_COUNTS: CodexLineCounts = {
  unparseableLines: 0,
  truncatedLastLines: 0,
  unknownRecords: 0,
  turnsEndedWithError: 0,
};

/** The sum of two counts. */
export function addLineCounts(a: CodexLineCounts, b: CodexLineCounts): CodexLineCounts {
  return {
    unparseableLines: a.unparseableLines + b.unparseableLines,
    truncatedLastLines: a.truncatedLastLines + b.truncatedLastLines,
    unknownRecords: a.unknownRecords + b.unknownRecords,
    turnsEndedWithError: a.turnsEndedWithError + b.turnsEndedWithError,
  };
}

/** What one session file held. */
export interface CodexFileRecords {
  /** `session_meta`'s session id, or `null` when the file carries none. */
  readonly sessionId: string | null;
  /** `session_meta`'s `cli_version`, or `null`. */
  readonly version: string | null;
  /** `session_meta`'s working directory, or `null`. A COUNT of these is all that is reported. */
  readonly cwd: string | null;
  /** The first and last record timestamps, or `""` when no record carried one. */
  readonly firstTimestamp: string;
  readonly lastTimestamp: string;
  /** One turn per response that reported usage, holding the tool calls it made. */
  readonly turns: readonly Turn[];
  /** One entry per `user` message. */
  readonly userPrompts: readonly UserPrompt[];
  readonly counts: CodexLineCounts;
}

/** How to stamp what one file holds. */
export interface CodexFileOptions {
  /** Used for a record that carries no time of its own — the file's modification time. */
  readonly timestamp: string;
  /** Starts every tool-use id made up here, since a call's own id is not one. */
  readonly idPrefix: string;
}

/** The record type whose payload holds a model response. */
const RESPONSE_ITEM = "response_item";

/** Payload types inside a `response_item` that this reader knows. */
const KNOWN_RESPONSE_ITEMS: ReadonlySet<string> = new Set([
  "message",
  "reasoning",
  "custom_tool_call",
  "custom_tool_call_output",
]);

/**
 * Record types this reader knows but does not use.
 *
 * Listed rather than lumped in with the unknown, so the "records this reader does not
 * know" count means a format change and not a record that was never wanted.
 */
const IGNORED_RECORDS: ReadonlySet<string> = new Set([
  "event_msg",
  "turn_context",
  "world_state",
  "compacted",
]);

/** A JSON object that is not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The value when it is a non-empty string, otherwise `undefined`. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A non-negative integer from an untrusted field. Anything else is 0. */
function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * One Codex usage record as the shared `Usage` shape.
 *
 * `tokens.ts` adds its four categories as DISJOINT amounts, and Codex reports them
 * nested, so the nesting is undone here. What decides the arithmetic is Codex's own:
 * across every recorded response, `total_tokens === input_tokens + output_tokens`
 * exactly, and `cached_input_tokens` never exceeds `input_tokens`. So the cached and
 * cache-write counts are BREAKDOWNS of `input_tokens`, not amounts beside it, and both
 * are subtracted to leave the uncached remainder. That also makes this reader's total
 * equal the total Codex itself reported, which is the number of record.
 *
 * `reasoning_output_tokens` is likewise already inside `output_tokens` — measured with a
 * non-zero reasoning count and the identity above still holding — so it is dropped rather
 * than added. Codex reports no 5-minute / 1-hour cache-write split, so none is set and the
 * report withholds that row instead of printing a zero.
 *
 * The residual, stated: `cache_write_input_tokens` was 0 in every recorded response, so
 * its nesting is inferred from the identity rather than observed directly. If it turns out
 * to sit beside `input_tokens` rather than inside it, this under-states uncached input by
 * that amount — and still reports the total Codex reported.
 */
export function codexUsage(usage: unknown): Usage {
  if (!isRecord(usage)) return {};
  const cached = count(usage.cached_input_tokens);
  const written = count(usage.cache_write_input_tokens);
  return {
    input_tokens: Math.max(0, count(usage.input_tokens) - cached - written),
    output_tokens: count(usage.output_tokens),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: written,
  };
}

/**
 * Read one Codex session file.
 *
 * @throws whatever the line source throws, when the file cannot be opened or read to the end.
 */
export async function readCodexFile(
  path: string,
  source: LineSource,
  options: CodexFileOptions,
): Promise<CodexFileRecords> {
  const turns: Turn[] = [];
  const userPrompts: UserPrompt[] = [];
  let sessionId: string | null = null;
  let version: string | null = null;
  let cwd: string | null = null;
  let firstTimestamp = "";
  let lastTimestamp = "";
  let model = "";
  let unparseableLines = 0;
  let unknownRecords = 0;
  // A line that did not parse is counted once the next line arrives. If none does, it was
  // the file's last line.
  let pendingUnparseable = false;
  let lineNumber = 0;
  // Tool calls seen since the last usage record. A response's usage arrives AFTER the call
  // it made, so the calls are held until the record that closes their turn.
  let pending: ToolUse[] = [];
  let pendingStamp = "";

  /** Close one turn: the calls held so far, under this response's usage. */
  const closeTurn = (timestamp: string, usage: Usage): void => {
    turns.push({
      messageUuid: "",
      timestamp,
      model,
      usage,
      text: "",
      toolUses: pending,
      isSidechain: false,
      promptUuid: "",
    });
    pending = [];
  };

  for await (const raw of source.readLines(path)) {
    lineNumber++;
    const line = raw.trim();
    if (line.length === 0) continue;

    if (pendingUnparseable) {
      unparseableLines++;
      pendingUnparseable = false;
    }

    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      pendingUnparseable = true;
      continue;
    }
    if (!isRecord(record) || typeof record.type !== "string") {
      unknownRecords++;
      continue;
    }

    const timestamp = nonEmptyString(record.timestamp) ?? options.timestamp;
    if (firstTimestamp === "") firstTimestamp = timestamp;
    lastTimestamp = timestamp;
    const payload = isRecord(record.payload) ? record.payload : {};

    if (record.type === "session_meta") {
      // The first one wins: a file holds one session, and a second header would be a
      // different session's, which is not something to merge silently.
      sessionId ??= nonEmptyString(payload.session_id) ?? null;
      version ??= nonEmptyString(payload.cli_version) ?? null;
      cwd ??= nonEmptyString(payload.cwd) ?? null;
      continue;
    }

    if (record.type === "token_usage_record") {
      closeTurn(timestamp, codexUsage(payload.usage));
      continue;
    }

    if (record.type === "turn_context") {
      // Carried for completeness; nothing in a report is derived from it.
      model = nonEmptyString(payload.model) ?? model;
      continue;
    }

    if (IGNORED_RECORDS.has(record.type)) continue;

    if (record.type !== RESPONSE_ITEM || typeof payload.type !== "string") {
      unknownRecords++;
      continue;
    }

    if (payload.type === "custom_tool_call") {
      pendingStamp = timestamp;
      pending.push({
        toolUseId: `${options.idPrefix}:${lineNumber}`,
        // A call with no name is kept under `""`, so `scan` counts it as unrecognized
        // rather than dropping it.
        name: typeof payload.name === "string" ? payload.name : "",
        // The shim's JavaScript, verbatim. `codex-transcript/scan.ts` recovers the command
        // from it; nothing here interprets it.
        input: { input: payload.input },
      });
      continue;
    }

    if (payload.type === "message" && payload.role === "user") {
      userPrompts.push({
        messageUuid: "",
        timestamp,
        text: "",
        isSidechain: false,
      });
      continue;
    }

    if (!KNOWN_RESPONSE_ITEMS.has(payload.type)) unknownRecords++;
  }

  // A file cut off before its usage record still holds the calls it recorded.
  if (pending.length > 0) closeTurn(pendingStamp === "" ? options.timestamp : pendingStamp, {});

  return {
    sessionId,
    version,
    cwd,
    firstTimestamp,
    lastTimestamp,
    turns,
    userPrompts,
    counts: {
      unparseableLines,
      truncatedLastLines: pendingUnparseable ? 1 : 0,
      unknownRecords,
      turnsEndedWithError: 0,
    },
  };
}
