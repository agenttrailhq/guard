/**
 * The text of one transcript line, sorted by how it got there.
 *
 * The parsed sessions keep what `scan` evaluates: tool calls, and for Claude Code the text
 * around them. Cursor's and Codex's readers keep no message text at all. The secrets check
 * needs all four places a credential can sit, for all three apps, so it reads each transcript
 * file again, one line at a time, and this module says what in a line is what:
 *
 *   pasted-into-prompt   the person's own message
 *   typed-into-command   a tool call's input: a command, a file the agent wrote, MCP arguments
 *   printed-by-command   a tool call's output
 *   in-agent-reply       the agent's reply, including its reasoning text
 *
 * Nothing else in a line is read: ids, timestamps, model names, usage and the harness's own
 * instructions are not one of those four.
 *
 * It also returns the working directories a line names, which the committed-fixture test uses
 * to find the repos the sessions ran in.
 *
 * Codex records are read as the documented rollout format describes them. That reading is
 * tested on synthetic sessions only, so what it finds in a real Codex session is unverified.
 *
 * Pure and total: a line that is not JSON, or not a record this module knows, gives nothing.
 */

import { unhandledAgent } from "../agent.js";
import type { AgentSource } from "../types.js";
import type { SecretProvenance } from "./types.js";

/** One string from a line, and how it got there. */
export interface TextPiece {
  readonly text: string;
  readonly via: SecretProvenance;
}

/** What one line holds. */
export interface LineText {
  readonly pieces: readonly TextPiece[];
  /** Working directories the line names. */
  readonly workingDirs: readonly string[];
}

/** Nothing. */
const EMPTY: LineText = { pieces: [], workingDirs: [] };

/** Deepest nesting `stringLeaves` descends into. */
const MAX_DEPTH = 32;

/** Most strings `stringLeaves` takes from one value. */
const MAX_LEAVES = 10_000;

/** A JSON object that is not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Every string in a value, keys left out, bounded in depth and count. */
function stringLeaves(value: unknown, out: string[] = [], depth = 0): string[] {
  if (out.length >= MAX_LEAVES || depth > MAX_DEPTH) return out;
  if (typeof value === "string") {
    if (value !== "") out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) stringLeaves(item, out, depth + 1);
  } else if (isRecord(value)) {
    for (const item of Object.values(value)) stringLeaves(item, out, depth + 1);
  }
  return out;
}

/** The `text` of each item in a content list, or the content itself when it is a string. */
function contentText(content: unknown): string[] {
  if (typeof content === "string") return content === "" ? [] : [content];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      if (item !== "") out.push(item);
    } else if (isRecord(item) && typeof item.text === "string" && item.text !== "") {
      out.push(item.text);
    }
  }
  return out;
}

/** Collects pieces for one line. */
function collector(): {
  add: (via: SecretProvenance, texts: readonly string[]) => void;
  pieces: TextPiece[];
} {
  const pieces: TextPiece[] = [];
  return {
    add: (via, texts) => {
      for (const text of texts) pieces.push({ text, via });
    },
    pieces,
  };
}

/** A non-empty string as a one-item list, or an empty list. */
function nonEmpty(value: unknown): string[] {
  return typeof value === "string" && value !== "" ? [value] : [];
}

/** One Claude Code transcript line. */
function claudeLine(record: Record<string, unknown>): LineText {
  const { add, pieces } = collector();
  const message = isRecord(record.message) ? record.message : undefined;
  const content = message?.content;

  if (record.type === "user") {
    if (typeof content === "string") add("pasted-into-prompt", contentText(content));
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (!isRecord(block)) continue;
        if (block.type === "text" && typeof block.text === "string") {
          add("pasted-into-prompt", [block.text]);
        } else if (block.type === "tool_result") {
          add("printed-by-command", contentText(block.content));
        }
      }
    }
    // The structured copy of a tool's output that Claude Code keeps beside the result.
    if (record.toolUseResult !== undefined) {
      add("printed-by-command", stringLeaves(record.toolUseResult));
    }
  } else if (record.type === "assistant" && Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
        add("in-agent-reply", [block.text]);
      } else if (block.type === "thinking" && typeof block.thinking === "string") {
        add("in-agent-reply", [block.thinking]);
      } else if (block.type === "tool_use") {
        add("typed-into-command", stringLeaves(block.input));
      }
    }
  }
  return { pieces, workingDirs: nonEmpty(record.cwd) };
}

/** One Codex CLI session line. */
function codexLine(record: Record<string, unknown>): LineText {
  const payload = isRecord(record.payload) ? record.payload : {};
  if (record.type === "session_meta" || record.type === "turn_context") {
    return { pieces: [], workingDirs: nonEmpty(payload.cwd) };
  }

  const { add, pieces } = collector();
  if (record.type === "response_item") {
    switch (payload.type) {
      case "message":
        // A `developer` message is the harness's own instructions, not the person's.
        if (payload.role === "user") add("pasted-into-prompt", contentText(payload.content));
        else if (payload.role === "assistant") add("in-agent-reply", contentText(payload.content));
        break;
      case "reasoning":
        add("in-agent-reply", [...contentText(payload.summary), ...contentText(payload.content)]);
        break;
      case "custom_tool_call":
        add("typed-into-command", stringLeaves(payload.input));
        break;
      case "function_call":
        add("typed-into-command", stringLeaves(payload.arguments));
        break;
      case "custom_tool_call_output":
      case "function_call_output":
        add("printed-by-command", stringLeaves(payload.output));
        break;
    }
  } else if (record.type === "event_msg") {
    switch (payload.type) {
      case "user_message":
        add("pasted-into-prompt", nonEmpty(payload.message));
        break;
      case "agent_message":
        add("in-agent-reply", nonEmpty(payload.message));
        break;
      case "exec_command_end":
        add("printed-by-command", [
          ...nonEmpty(payload.aggregated_output),
          ...nonEmpty(payload.stdout),
          ...nonEmpty(payload.stderr),
        ]);
        break;
      case "item_completed": {
        const item = isRecord(payload.item) ? payload.item : {};
        if (item.type === "CommandExecution") {
          add("printed-by-command", nonEmpty(item.aggregated_output));
        }
        break;
      }
    }
  }
  return { pieces, workingDirs: [] };
}

/** One Cursor session line. */
function cursorLine(record: Record<string, unknown>): LineText {
  const message = isRecord(record.message) ? record.message : undefined;
  if (message === undefined) return EMPTY;
  const { add, pieces } = collector();
  if (record.role === "user") add("pasted-into-prompt", contentText(message.content));
  else if (record.role === "assistant" && Array.isArray(message.content)) {
    for (const item of message.content) {
      if (!isRecord(item)) continue;
      if (item.type === "text" && typeof item.text === "string") {
        add("in-agent-reply", [item.text]);
      } else if (item.type === "tool_use") {
        add("typed-into-command", stringLeaves(item.input));
      }
    }
  }
  return { pieces, workingDirs: [] };
}

/**
 * The text in one raw transcript line, for one app.
 *
 * A checked switch, so a new app's lines are never read as another app's.
 */
export function lineText(agent: AgentSource, line: string): LineText {
  const trimmed = line.trim();
  if (trimmed === "") return EMPTY;
  let record: unknown;
  try {
    record = JSON.parse(trimmed);
  } catch {
    return EMPTY;
  }
  return recordText(agent, record);
}

/**
 * The text in one transcript record already parsed from its line, for one app: what
 * `lineText` gives for the line. The scan's own reader hands its parsed records here, so a
 * line is parsed once.
 */
export function recordText(agent: AgentSource, record: unknown): LineText {
  if (!isRecord(record)) return EMPTY;
  switch (agent) {
    case "claude":
      return claudeLine(record);
    case "codex":
      return codexLine(record);
    case "cursor":
      return cursorLine(record);
    default:
      return unhandledAgent(agent);
  }
}
