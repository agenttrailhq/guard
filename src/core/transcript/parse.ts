/**
 * Streaming, structure-first transcript parser.
 *
 * Reads a Claude Code session JSONL **line by line** (`readline`), parsing one
 * line at a time — a long session must never be `JSON.parse`d whole (memory).
 * Each line is discriminated on `type` + `message.content` block **structure**,
 * not on the `version` string. A line that does not structurally parse
 * is skipped + counted (per-line isolation); a file that yields no coherent
 * message spine throws {@link QuarantineError}, which the caller records
 * as a quarantined session without aborting the run.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type {
  ContentBlock,
  ParsedSession,
  ToolResult,
  ToolUse,
  TranscriptLine,
  Turn,
  UserPrompt,
} from "./transcript-types.js";

/** Thrown when a transcript file cannot be folded into any coherent session. */
export class QuarantineError extends Error {
  constructor(
    message: string,
    readonly sessionId: string | null,
  ) {
    super(message);
    this.name = "QuarantineError";
  }
}

/** Injectable line source (defaults to a real file stream) so tests touch no disk. */
export interface LineSource {
  /** Yield each raw line of the file at `path`, in order. */
  readLines(path: string): AsyncIterable<string>;
}

/** Real `readline`-over-`createReadStream` line source (never buffers the whole file). */
export const fileLineSource: LineSource = {
  async *readLines(path: string): AsyncIterable<string> {
    const rl = createInterface({
      input: createReadStream(path, { encoding: "utf8" }),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    try {
      for await (const line of rl) yield line;
    } finally {
      rl.close();
    }
  },
};

/** Coerce an unknown to a trimmed non-empty string, or null. */
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Normalize a `message.content` value to a block array (string → one text block). */
function toBlocks(content: string | readonly ContentBlock[] | undefined): readonly ContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content;
  return [];
}

/** Join all `text` blocks into one string (content — emitted only under `--content`). */
function joinText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

/** Stringify a tool_result `content` (string | block array | object) for content emission. */
function resultToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : "",
      )
      .join("\n");
  }
  return content === undefined || content === null ? "" : JSON.stringify(content);
}

/**
 * Parse one transcript file into a {@link ParsedSession}.
 *
 * @throws {QuarantineError} when no coherent message spine is recoverable.
 */
export async function parseSession(
  path: string,
  fallbackSessionId: string,
  source: LineSource = fileLineSource,
): Promise<ParsedSession> {
  let sessionId: string | null = null;
  let version: string | null = null;
  let gitBranch: string | null = null;
  let cwd: string | null = null;
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;
  let skippedLines = 0;

  const turns: Turn[] = [];
  const userPrompts: UserPrompt[] = [];
  const toolResults = new Map<string, ToolResult>();
  // Turn boundary: the most-recent NON-sidechain user prompt. Every
  // assistant message is stamped with this so the tree groups one trace per
  // prompt. `""` until the first prompt → those early assistant messages attach
  // to the first turn (or the fallback trace when a session has no prompt).
  let currentPromptUuid = "";

  for await (const raw of source.readLines(path)) {
    const line = raw.trim();
    if (line.length === 0) continue;

    let obj: TranscriptLine;
    try {
      obj = JSON.parse(line) as TranscriptLine;
    } catch {
      // Malformed / truncated line → skip + count, never fatal (per-line isolation).
      skippedLines++;
      continue;
    }
    if (obj === null || typeof obj !== "object") {
      skippedLines++;
      continue;
    }

    // Session identity + reporting fields, sniffed forward from message lines
    // (line 1 is a `summary`/`custom-title` record lacking cwd/branch/version).
    sessionId ??= str(obj.sessionId);
    version ??= str(obj.version);
    gitBranch ??= str(obj.gitBranch);
    cwd ??= str(obj.cwd);

    const ts = str(obj.timestamp);
    const uuid = str(obj.uuid) ?? "";
    const isSidechain = obj.isSidechain === true;
    const type = obj.type;

    // Message-bearing lines carry a timestamp; track the verbatim span bounds.
    if (ts && (type === "user" || type === "assistant")) {
      firstTimestamp ??= ts;
      lastTimestamp = ts;
    }

    if (type === "assistant" && obj.message) {
      const blocks = toBlocks(obj.message.content);
      const toolUses: ToolUse[] = [];
      for (const b of blocks) {
        if (b.type === "tool_use" && str(b.id) && str(b.name)) {
          toolUses.push({
            toolUseId: b.id as string,
            name: b.name as string,
            input: (b.input ?? {}) as Record<string, unknown>,
          });
        }
      }
      // A model turn is an assistant message carrying `usage`; without usage
      // (rare partial) we still emit a turn so its tool_uses are not lost.
      turns.push({
        messageUuid: uuid,
        timestamp: ts ?? lastTimestamp ?? "",
        model: str(obj.message.model) ?? "",
        usage: obj.message.usage ?? {},
        text: joinText(blocks),
        toolUses,
        isSidechain,
        promptUuid: currentPromptUuid,
      });
    } else if (type === "user" && obj.message) {
      const blocks = toBlocks(obj.message.content);
      // A `user` line is EITHER a human prompt OR a tool_result carrier.
      let sawToolResult = false;
      for (const b of blocks) {
        if (b.type === "tool_result" && str(b.tool_use_id)) {
          sawToolResult = true;
          toolResults.set(b.tool_use_id as string, {
            toolUseId: b.tool_use_id as string,
            isError: b.is_error === true,
            content: resultToString(b.content),
            timestamp: ts ?? lastTimestamp ?? "",
          });
        }
      }
      if (!sawToolResult) {
        const text = joinText(blocks);
        if (text.length > 0) {
          userPrompts.push({ messageUuid: uuid, timestamp: ts ?? "", text, isSidechain });
          // A non-sidechain prompt opens a new turn; assistant messages after it
          // are stamped with its uuid. Sidechain prompts do NOT open a turn (the
          // spawning Task's turn owns the sub-agent work).
          if (!isSidechain) currentPromptUuid = uuid;
        }
      }
    }
    // `summary` / `system` / unknown types → recorded via identity sniff above,
    // otherwise structurally no-op (forward-tolerant).
  }

  const resolvedSessionId = sessionId ?? fallbackSessionId;

  // Quarantine only on a genuinely empty spine: no turns AND no prompts means
  // there is nothing to map (truncated-to-nothing / non-transcript file).
  if (turns.length === 0 && userPrompts.length === 0) {
    throw new QuarantineError(
      `no coherent message spine (${skippedLines} unparseable line(s))`,
      resolvedSessionId,
    );
  }

  const first = firstTimestamp ?? turns[0]?.timestamp ?? userPrompts[0]?.timestamp ?? "";
  const last = lastTimestamp ?? first;

  return {
    sessionId: resolvedSessionId,
    version,
    gitBranch,
    cwd,
    turns,
    userPrompts,
    toolResults,
    firstTimestamp: first,
    lastTimestamp: last,
    skippedLines,
  };
}
