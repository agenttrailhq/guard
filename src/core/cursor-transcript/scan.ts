/**
 * `scan --agent cursor`: find Cursor's session files, read them into sessions, and say what
 * each tool call in them is evaluated as.
 *
 * ── Where the files are ──────────────────────────────────────────────────────
 *   <root>/<project>/agent-transcripts/<id>/<id>.jsonl             a session
 *   <root>/<project>/agent-transcripts/<id>/subagents/<name>.jsonl  a sub-agent it started
 *
 * `<root>` is `~/.cursor/projects` unless `--dir` names another. A sub-agent's tool calls
 * ran on the same machine as the session that started it, so its files are read into that
 * session. Any other `.jsonl` file in an `agent-transcripts` folder, including one directly
 * inside it, is not opened, and is counted as not read.
 *
 * ── Nothing here fails the scan ──────────────────────────────────────────────
 * A folder that cannot be listed is skipped. A session file that cannot be opened or read
 * to the end is counted as unreadable, and what it held is left out. A session whose
 * readable files hold no message at all is counted as yielding no session. What the lines
 * held that could not be used is counted by `parse.ts`.
 *
 * ── How a tool call is evaluated ─────────────────────────────────────────────
 * | Session file                                   | Evaluated as               | Channel                         |
 * |------------------------------------------------|----------------------------|---------------------------------|
 * | `Shell{command}`                               | `Bash`                     | `full_command` (end-capped)     |
 * | `Read`, `Write`, `StrReplace`, `Delete{path}`  | `Read`, `Write`, `Edit`, `Delete` | `file_path`              |
 * | `Grep{path?, glob?}`                           | `Grep`                     | `file_path`, one or two paths   |
 * | `Glob{target_directory?, glob_pattern}`        | `Glob`                     | `file_path`, one or two paths   |
 * | `CallMcpTool{server, toolName, arguments}`     | `mcp__<server>__<toolName>`| `full_command` = the arguments  |
 * | `CallDynamicTool{namespace, toolName, arguments}` | `mcp__<namespace>__<toolName>` | `full_command` = the arguments |
 * | `WebSearch{search_term}`                       | `WebSearch`                | `full_command` (end-capped)     |
 *
 * A `Grep` or `Glob` gets the same paths the live hook evaluates a `Grep` on
 * (`grepCandidates` in `core/cursor-mapper.ts`): the folder joined to the glob, and the
 * folder. `scan` evaluates each and keeps the stricter verdict, as the hook does, so one
 * tool call is at most one finding. MCP arguments are serialized and middle-capped the way
 * the hook serializes an MCP tool's input.
 *
 * The live hook names an MCP call `mcp__cursor__<tool>`, because Cursor's hook payload
 * carries no server name; a session file does name it. So a guardrail that names a server
 * can match in `scan` and not in the hook. Any guardrail that does not name one gets the
 * same verdict in both.
 *
 * `GetDynamicTools`, `TodoWrite`, `CreatePlan`, `AskQuestion`, `SwitchMode`, `Await`,
 * `Task`, `ReadLints`, `SemanticSearch` and `WebFetch` are not actions a guardrail checks,
 * and are counted apart. A `Task` starts a sub-agent, whose own tool calls are read from its
 * file. Any other tool name is counted as not recognized.
 */

import { join } from "node:path";
import { type CursorCandidates, grepCandidates } from "../cursor-mapper.js";
import { capEnd, capMiddle, safeStringify } from "../mapper.js";
import type { ReaderSkips, ScanCorpus, SessionToolCall } from "../scan-report.js";
import type { ParsedSession, ToolUse, Turn, UserPrompt } from "../transcript/transcript-types.js";
import type { MappedCall } from "../types.js";
import { addLineCounts, type CursorLineCounts, NO_LINE_COUNTS, readCursorFile } from "./parse.js";

/** The folder inside a Cursor project folder that holds its session files. */
export const TRANSCRIPTS_FOLDER = "agent-transcripts";

/** The folder inside a session's folder that holds its sub-agents' files. */
const SUBAGENTS_FOLDER = "subagents";

/** Deepest folder nesting the not-read tally descends, so a symbolic-link loop ends. */
const MAX_WALK_DEPTH = 8;

/** Cursor's default projects root. */
export function defaultCursorProjectsRoot(home: string): string {
  return join(home, ".cursor", "projects");
}

/** What reading Cursor's session files needs. `readdir` and `stat` throw on failure. */
export interface CursorTranscriptIO {
  readdir(path: string): string[];
  stat(path: string): { readonly mtimeMs: number; isDirectory(): boolean };
  readLines(path: string): AsyncIterable<string>;
}

/** Tools that are not actions a guardrail checks. */
export const CURSOR_NOT_ACTIONS: ReadonlySet<string> = new Set([
  "GetDynamicTools",
  "TodoWrite",
  "CreatePlan",
  "AskQuestion",
  "SwitchMode",
  "Await",
  "Task",
  "ReadLints",
  "SemanticSearch",
  "WebFetch",
]);

/** File tools, by Cursor's name, and the name each is evaluated as. */
const FILE_TOOLS: ReadonlyMap<string, string> = new Map([
  ["Read", "Read"],
  ["Write", "Write"],
  ["StrReplace", "Edit"],
  ["Delete", "Delete"],
]);

/** A JSON object that is not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The value when it is a string, otherwise `""`. */
function stringOr(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A call whose command channel is `value`, end-capped. No channel when it is not a string. */
function commandCall(tool: string, value: unknown): MappedCall {
  return typeof value === "string"
    ? { tool, args: { full_command: capEnd(value) } }
    : { tool, args: {} };
}

/** An MCP call, with its arguments serialized and middle-capped. */
function mcpCall(group: unknown, toolName: unknown, args: unknown): MappedCall {
  // A string is already serialized. Anything that is not an object serializes as `{}`, as a
  // hook payload's non-object input does.
  const raw = typeof args === "string" ? args : safeStringify(isRecord(args) ? args : {});
  return {
    tool: `mcp__${stringOr(group)}__${stringOr(toolName)}`,
    args: { full_command: capMiddle(raw) },
  };
}

/** The candidates for a `Glob`: a `Grep`'s paths, evaluated under the name `Glob`. */
function globCandidates(folder: unknown, glob: unknown): CursorCandidates {
  const [first, ...rest] = grepCandidates(folder, glob);
  const asGlob = (call: MappedCall): MappedCall => ({ tool: "Glob", args: call.args });
  return [asGlob(first), ...rest.map(asGlob)];
}

/**
 * What one tool call from a session file is evaluated as. See the table in the header.
 *
 * Pure, and never throws. A call missing a field it reads is still an action, with that
 * channel empty, so it evaluates to no match.
 */
export function mapCursorSessionTool(use: ToolUse): SessionToolCall {
  const input: Readonly<Record<string, unknown>> = isRecord(use.input) ? use.input : {};
  const action = (candidates: CursorCandidates): SessionToolCall => ({
    kind: "action",
    candidates,
  });

  switch (use.name) {
    case "Shell":
      return action([commandCall("Bash", input.command)]);
    case "WebSearch":
      return action([commandCall("WebSearch", input.search_term)]);
    case "Grep":
      return action(grepCandidates(input.path, input.glob));
    case "Glob":
      return action(globCandidates(input.target_directory, input.glob_pattern));
    case "CallMcpTool":
      return action([mcpCall(input.server, input.toolName, input.arguments)]);
    case "CallDynamicTool":
      return action([mcpCall(input.namespace, input.toolName, input.arguments)]);
  }

  const fileTool = FILE_TOOLS.get(use.name);
  if (fileTool !== undefined) {
    const path = input.path;
    return action([{ tool: fileTool, args: typeof path === "string" ? { file_path: path } : {} }]);
  }
  if (CURSOR_NOT_ACTIONS.has(use.name)) return { kind: "not-action" };
  return { kind: "unmapped", name: use.name };
}

/** Every tool call in a Cursor session, in order, as what it is evaluated as. */
export function* cursorSessionCalls(session: ParsedSession): Iterable<SessionToolCall> {
  for (const turn of session.turns) {
    for (const use of turn.toolUses) yield mapCursorSessionTool(use);
  }
}

/** A folder's entries, sorted, or `undefined` when it cannot be listed. */
function listFolder(io: CursorTranscriptIO, path: string): string[] | undefined {
  try {
    return [...io.readdir(path)].sort();
  } catch {
    return undefined;
  }
}

/** Whether `path` is a folder. `false` when it cannot be read. */
function isFolder(io: CursorTranscriptIO, path: string): boolean {
  try {
    return io.stat(path).isDirectory();
  } catch {
    return false;
  }
}

/** One session file to read. */
interface SessionFile {
  readonly path: string;
  readonly mtimeMs: number;
  readonly isSidechain: boolean;
}

/** One session's files. */
interface FoundSession {
  readonly id: string;
  readonly files: readonly SessionFile[];
}

/** The sessions in one `agent-transcripts` folder, and the session files that could not be read. */
function findSessions(
  io: CursorTranscriptIO,
  folder: string,
): { sessions: FoundSession[]; unreadableFiles: number } {
  const sessions: FoundSession[] = [];
  let unreadableFiles = 0;

  /** A `.jsonl` file to read, or `undefined` for a folder or one that cannot be read. */
  const sessionFile = (path: string, isSidechain: boolean): SessionFile | undefined => {
    try {
      const stat = io.stat(path);
      return stat.isDirectory() ? undefined : { path, mtimeMs: stat.mtimeMs, isSidechain };
    } catch {
      unreadableFiles++;
      return undefined;
    }
  };

  for (const entry of listFolder(io, folder) ?? []) {
    const path = join(folder, entry);
    // Only a session's folder is read. A file directly in `agent-transcripts` is left to the
    // not-read count.
    if (!isFolder(io, path)) continue;

    const files: SessionFile[] = [];
    const inside = listFolder(io, path) ?? [];
    if (inside.includes(`${entry}.jsonl`)) {
      const file = sessionFile(join(path, `${entry}.jsonl`), false);
      if (file !== undefined) files.push(file);
    }
    if (inside.includes(SUBAGENTS_FOLDER)) {
      const subagents = join(path, SUBAGENTS_FOLDER);
      for (const name of listFolder(io, subagents) ?? []) {
        if (!name.endsWith(".jsonl")) continue;
        const file = sessionFile(join(subagents, name), true);
        if (file !== undefined) files.push(file);
      }
    }
    if (files.length > 0) sessions.push({ id: entry, files });
  }

  return { sessions, unreadableFiles };
}

/** Every `.jsonl` file under `path` that can be read, at any depth up to the cap. */
function countSessionFiles(io: CursorTranscriptIO, path: string, depth = 0): number {
  if (depth > MAX_WALK_DEPTH) return 0;
  let total = 0;
  for (const entry of listFolder(io, path) ?? []) {
    const child = join(path, entry);
    try {
      if (io.stat(child).isDirectory()) total += countSessionFiles(io, child, depth + 1);
      else if (entry.endsWith(".jsonl")) total++;
    } catch {
      // Gone or unreadable between the listing and the stat. Not a scan failure.
    }
  }
  return total;
}

/** A file time as an ISO string, or `""` when it is not a valid time. */
function isoTime(ms: number): string {
  try {
    return new Date(ms).toISOString();
  } catch {
    return "";
  }
}

/** One session, read from its files. */
interface SessionRead {
  /** Absent when no file could be read, or the readable files hold no message. */
  readonly session: ParsedSession | undefined;
  /** Whether at least one of its files was read to the end. */
  readonly readable: boolean;
  readonly unreadableFiles: number;
  readonly counts: CursorLineCounts;
}

/** Read one session's files into one session, dated by the files' modification times. */
async function readSession(io: CursorTranscriptIO, found: FoundSession): Promise<SessionRead> {
  const turns: Turn[] = [];
  const userPrompts: UserPrompt[] = [];
  const times: number[] = [];
  let counts = NO_LINE_COUNTS;
  let unreadableFiles = 0;

  for (const [index, file] of found.files.entries()) {
    try {
      const records = await readCursorFile(file.path, io, {
        timestamp: isoTime(file.mtimeMs),
        isSidechain: file.isSidechain,
        idPrefix: `${found.id}:${index}`,
      });
      // One at a time: a spread of a very long session could exceed the argument limit.
      for (const turn of records.turns) turns.push(turn);
      for (const prompt of records.userPrompts) userPrompts.push(prompt);
      counts = addLineCounts(counts, records.counts);
      times.push(file.mtimeMs);
    } catch {
      // What a file held is used only when it was read to the end.
      unreadableFiles++;
    }
  }

  const readable = times.length > 0;
  if (!readable || (turns.length === 0 && userPrompts.length === 0)) {
    return { session: undefined, readable, unreadableFiles, counts };
  }

  return {
    session: {
      sessionId: found.id,
      version: null,
      gitBranch: null,
      cwd: null,
      turns,
      userPrompts,
      toolResults: new Map(),
      firstTimestamp: isoTime(Math.min(...times)),
      lastTimestamp: isoTime(Math.max(...times)),
      skippedLines: counts.unparseableLines + counts.truncatedLastLines,
    },
    readable,
    unreadableFiles,
    counts,
  };
}

/**
 * Read every Cursor session under `root` into a corpus for `aggregateScan`.
 *
 * Never throws. A missing `root` is an empty corpus: someone who has not run Cursor.
 */
export async function readCursorCorpus(root: string, io: CursorTranscriptIO): Promise<ScanCorpus> {
  const sessions: ParsedSession[] = [];
  let quarantined = 0;
  let projects = 0;
  let notRead = 0;
  let unreadableFiles = 0;
  let counts = NO_LINE_COUNTS;

  for (const project of listFolder(io, root) ?? []) {
    const folder = join(root, project, TRANSCRIPTS_FOLDER);
    if (!isFolder(io, folder)) continue;

    const found = findSessions(io, folder);
    unreadableFiles += found.unreadableFiles;
    let opened = 0;
    let read = 0;

    for (const item of found.sessions) {
      opened += item.files.length;
      const result = await readSession(io, item);
      unreadableFiles += result.unreadableFiles;
      counts = addLineCounts(counts, result.counts);
      if (result.session !== undefined) {
        sessions.push(result.session);
        read++;
      } else if (result.readable) {
        quarantined++;
      }
    }

    // Never negative: a file that appeared or vanished mid-walk must not print as a
    // negative count.
    notRead += Math.max(0, countSessionFiles(io, folder) - opened);
    if (read > 0) projects++;
  }

  const skipped: ReaderSkips = { ...counts, unreadableFiles };
  return {
    agent: "cursor",
    // No record in a session file carries a token count, so a total would be a zero
    // nobody measured; what the reader could not use is counted and listed instead.
    capabilities: { tokens: false, skips: true },
    sessions,
    quarantined,
    notRead,
    projects,
    skipped,
  };
}
