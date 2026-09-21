/**
 * One Cursor session file, read line by line into the turns `scan` evaluates.
 *
 * Each line of a session file is one record:
 *
 *   {"role":"user","message":{"content":[{"type":"text","text":"…"}]}}
 *   {"role":"assistant","message":{"content":[{"type":"text",…},{"type":"tool_use","name":"Shell","input":{…}}]}}
 *   {"type":"turn_ended","status":"success"}
 *   {"type":"turn_ended","status":"error","error":"…"}
 *
 * No record carries a time, a token count, a model, a tool-use id or a working directory,
 * so the turns built here carry none either: every turn is stamped with the time the
 * caller passes (the file's modification time), and reports no usage.
 *
 * ── Only tool calls are kept ─────────────────────────────────────────────────
 * `scan` evaluates tool calls and nothing else, so the text of a message is not kept: a
 * turn's `text` and a prompt's `text` are empty. A prompt is still recorded, so a file
 * that holds only prompts counts as a session.
 *
 * ── A bad line never fails the file ──────────────────────────────────────────
 * Each line is parsed on its own, and what cannot be used is counted by kind:
 * - a line that is not JSON;
 * - the file's LAST line when it is not JSON, counted apart, because a file Cursor is
 *   still writing ends in a cut-off line;
 * - a line that is JSON but no record above.
 * A `turn_ended` record with an error is counted too; the tool calls before it are read.
 * Only a failure of the line source itself (a file that cannot be opened or read to the
 * end) reaches the caller.
 */

import type { LineSource } from "../transcript/parse.js";
import type { ToolUse, Turn, UserPrompt } from "../transcript/transcript-types.js";

/** What one or more session files held that could not be used, by kind. */
export interface CursorLineCounts {
  /** Lines that are not JSON, other than a file's last line. */
  readonly unparseableLines: number;
  /** Files whose last line is not JSON, as a file still being written ends. */
  readonly truncatedLastLines: number;
  /** Lines that are JSON but not a record this reader knows. */
  readonly unknownRecords: number;
  /** `turn_ended` records reporting an error. */
  readonly turnsEndedWithError: number;
}

/** No lines counted. */
export const NO_LINE_COUNTS: CursorLineCounts = {
  unparseableLines: 0,
  truncatedLastLines: 0,
  unknownRecords: 0,
  turnsEndedWithError: 0,
};

/** The sum of two counts. */
export function addLineCounts(a: CursorLineCounts, b: CursorLineCounts): CursorLineCounts {
  return {
    unparseableLines: a.unparseableLines + b.unparseableLines,
    truncatedLastLines: a.truncatedLastLines + b.truncatedLastLines,
    unknownRecords: a.unknownRecords + b.unknownRecords,
    turnsEndedWithError: a.turnsEndedWithError + b.turnsEndedWithError,
  };
}

/** What one session file held. */
export interface CursorFileRecords {
  /** One turn per assistant record, holding its tool calls in order. */
  readonly turns: readonly Turn[];
  /** One entry per user record. */
  readonly userPrompts: readonly UserPrompt[];
  readonly counts: CursorLineCounts;
}

/** How to stamp what one file holds. */
export interface CursorFileOptions {
  /** Set on every turn and prompt, since no record carries a time. */
  readonly timestamp: string;
  /** A sub-agent's file: its turns are marked as a sidechain. */
  readonly isSidechain: boolean;
  /** Starts every tool-use id made up here, since Cursor's records carry none. */
  readonly idPrefix: string;
}

/** A JSON object that is not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A message's content as a list of items. A bare string is one text item. */
function contentItems(content: unknown): readonly unknown[] {
  if (Array.isArray(content)) return content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return [];
}

/**
 * Read one Cursor session file.
 *
 * @throws whatever the line source throws, when the file cannot be opened or read to the end.
 */
export async function readCursorFile(
  path: string,
  source: LineSource,
  options: CursorFileOptions,
): Promise<CursorFileRecords> {
  const turns: Turn[] = [];
  const userPrompts: UserPrompt[] = [];
  let unparseableLines = 0;
  let unknownRecords = 0;
  let turnsEndedWithError = 0;
  // A line that did not parse is counted once the next line arrives. If none does, it was
  // the file's last line.
  let pendingUnparseable = false;
  let lineNumber = 0;

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
    if (!isRecord(record)) {
      unknownRecords++;
      continue;
    }

    if (record.type === "turn_ended") {
      if (record.status === "error" || record.error !== undefined) turnsEndedWithError++;
      continue;
    }

    const message = record.message;
    if ((record.role !== "user" && record.role !== "assistant") || !isRecord(message)) {
      unknownRecords++;
      continue;
    }

    if (record.role === "user") {
      userPrompts.push({
        messageUuid: "",
        timestamp: options.timestamp,
        text: "",
        isSidechain: options.isSidechain,
      });
      continue;
    }

    const toolUses: ToolUse[] = [];
    contentItems(message.content).forEach((item, index) => {
      if (!isRecord(item) || item.type !== "tool_use") return;
      toolUses.push({
        toolUseId: `${options.idPrefix}:${lineNumber}:${index}`,
        // A tool call with no name is kept under `""`, so `scan` counts it as unrecognized
        // rather than dropping it.
        name: typeof item.name === "string" ? item.name : "",
        input: isRecord(item.input) ? item.input : {},
      });
    });
    turns.push({
      messageUuid: "",
      timestamp: options.timestamp,
      model: "",
      usage: {},
      text: "",
      toolUses,
      isSidechain: options.isSidechain,
      promptUuid: "",
    });
  }

  return {
    turns,
    userPrompts,
    counts: {
      unparseableLines,
      truncatedLastLines: pendingUnparseable ? 1 : 0,
      unknownRecords,
      turnsEndedWithError,
    },
  };
}
