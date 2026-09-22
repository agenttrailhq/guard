/**
 * `scan --agent codex`: find Codex CLI's session files, read them into sessions, and say
 * what each tool call in them is evaluated as.
 *
 * ── Where the files are ──────────────────────────────────────────────────────
 *   <root>/<year>/<month>/<day>/rollout-<timestamp>-<thread id>.jsonl
 *
 * `<root>` is `~/.codex/sessions` unless `--dir` names another, and it does not exist
 * until Codex has run once. One file is one session: Codex starts no sub-agent with a
 * file of its own. The walk descends exactly three folders and opens the `.jsonl` files
 * there; a `.jsonl` anywhere else under the root is not opened, and is counted as not
 * read, so a re-shaped tree shows up as a stated coverage gap rather than as a quiet
 * empty report.
 *
 * ── Nothing here fails the scan ──────────────────────────────────────────────
 * A folder that cannot be listed is skipped. A session file that cannot be opened or read
 * to the end is counted as unreadable, and what it held is left out. A readable file that
 * holds no message at all is counted as yielding no session. What the lines held that
 * could not be used is counted by `parse.ts`.
 *
 * ── A shell command is not stored as a command ───────────────────────────────
 * This is the whole difficulty of reading Codex's history, and the reason the extractor
 * below exists. Measured on codex-cli 0.154.0, a shell call is a `custom_tool_call` named
 * `exec` whose `input` is a fragment of JavaScript:
 *
 *   const r = await tools.exec_command({cmd:"rm -rf build",workdir:"/w",yield_time_ms:10000}); text(r.output);
 *   const r = await tools.apply_patch("*** Begin Patch\n*** Add File: /w/a.txt\n+hi\n*** End Patch");
 *
 * The live hook is handed the same action already normalized (`tool_name: "Bash"`, the
 * raw command in `tool_input.command`), so only this reader has to recover it.
 *
 * ── The extractor runs NO JavaScript, and that is not negotiable ─────────────
 * Guard has no runtime dependencies and reads files it did not write, off a disk that a
 * person other than the reader may have written to. `eval`, `new Function` and `node:vm`
 * would each turn "read my history" into "run whatever is in my history" — arbitrary code
 * execution with the reader's own privileges, triggered by a file. So the input is
 * SCANNED, never evaluated: a single forward pass that skips string literals and comments,
 * finds `tools.<fn>(` at a token boundary, and reads one object literal or one quoted
 * string as the argument.
 *
 * ── …and it FAILS CLOSED, which is the other half ────────────────────────────
 * The shim is OpenAI's, it is undocumented, and it will change. Every form the scanner
 * cannot place — an unterminated string, a template literal, an argument that is a
 * variable, a `cmd` that is not a string literal, a source past the length cap — makes the
 * call UNMAPPED. An unmapped call is counted and NAMED in the report's "what was not
 * evaluated" list, so a shim change shows up as a visible gap. It never becomes a guessed
 * command: a wrong command in a report is worse than an absent one, because it reads as
 * measured fact.
 *
 * ── How a tool call is evaluated ─────────────────────────────────────────────
 * | Session file                                  | Evaluated as | Channel                     |
 * |-----------------------------------------------|--------------|-----------------------------|
 * | `exec` → `tools.exec_command({cmd})`          | `Bash`       | `full_command` (end-capped) |
 * | `exec` → `tools.apply_patch("…")`             | `apply_patch`| none — see below            |
 * | `exec` → any other `tools.<fn>`               | not recognized, counted under `<fn>`       |
 * | `exec` whose JavaScript cannot be read        | not recognized, counted under `exec`       |
 * | any other `custom_tool_call` name             | not recognized, counted under that name    |
 *
 * One `exec` call can hold more than one `tools.<fn>` call, and each is evaluated
 * separately, so a second command in the same shim fragment is not lost.
 *
 * ── Two gaps, stated rather than hidden ──────────────────────────────────────
 * An `apply_patch` is recorded as an action with no channel, so it is counted among the
 * tool calls and matches nothing. The live hook expands a patch into one candidate per
 * path it names and evaluates each, so a guardrail written against a file path matches an
 * edit in the hook and not in a scan. The patch's paths are parsed in one place, for the
 * hook, and this reader will call that same code rather than grow a second copy of it.
 *
 * An MCP call was not exercised on the machine these sessions were recorded on, so no
 * shape for one is assumed here: it would arrive as a name this reader does not
 * recognize, which the report lists by name.
 */

import { join } from "node:path";
import { patchCandidates } from "../codex-mapper.js";
import { capEnd } from "../mapper.js";
import type { ReaderSkips, ScanCorpus, SessionToolCall } from "../scan-report.js";
import type { ParsedSession, ToolUse, Turn, UserPrompt } from "../transcript/transcript-types.js";
import { addLineCounts, type CodexFileRecords, NO_LINE_COUNTS, readCodexFile } from "./parse.js";

/** Codex's default sessions root. */
export function defaultCodexSessionsRoot(home: string): string {
  return join(home, ".codex", "sessions");
}

/** What reading Codex's session files needs. `readdir` and `stat` throw on failure. */
export interface CodexTranscriptIO {
  readdir(path: string): string[];
  stat(path: string): { readonly mtimeMs: number; isDirectory(): boolean };
  readLines(path: string): AsyncIterable<string>;
}

/** The `custom_tool_call` name Codex gives the shim that runs every tool. */
export const CODEX_SHIM_TOOL = "exec";

/** The shim function that runs a shell command. */
const EXEC_COMMAND = "exec_command";

/** The shim function that applies a patch. */
const APPLY_PATCH = "apply_patch";

/** The property of `exec_command`'s argument that holds the command. */
const CMD_KEY = "cmd";

/** What a `tools.<fn>` call is written as, including the dot. */
const TOOLS_PREFIX = "tools.";

/**
 * Longest shim fragment the scanner reads.
 *
 * The recorded fragments are a few hundred bytes. The cap is far above that and exists so
 * the work this reader does on one line is bounded by a constant rather than by whatever
 * is on disk; a longer fragment is unmapped, which is visible, rather than slow.
 */
const MAX_SHIM_SOURCE = 128 * 1024;

/** Deepest folder nesting the not-read tally descends, so a symbolic-link loop ends. */
const MAX_WALK_DEPTH = 8;

/** Folders between the root and a session file: year, month, day. */
const SESSION_DEPTH = 3;

/** One `tools.<fn>(…)` call recovered from a shim fragment. */
export interface ShimCall {
  /** The function named after `tools.`, for example `exec_command`. */
  readonly fn: string;
  /** The `cmd` property of an object argument, unescaped. Absent when there is none. */
  readonly cmd?: string;
  /**
   * The single string argument, unescaped, for the form that takes one — `apply_patch`
   * carries the whole patch this way. Absent when the argument is an object or missing.
   *
   * It is kept because the paths a patch names live only in its text: without them a scan
   * would report an edit with nothing to match, and a guardrail written against a file
   * path would fire in the live hook and stay silent in the report of the same session.
   */
  readonly text?: string;
}

/** Is this character part of a JavaScript identifier? */
function isIdentPart(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    code === 36
  );
}

/** Can this character START a JavaScript identifier? */
function isIdentStart(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36;
}

/** One escape sequence, unescaped, and where it ends. `undefined` when it is malformed. */
function readEscape(source: string, at: number): { text: string; end: number } | undefined {
  const ch = source[at + 1];
  if (ch === undefined) return undefined;
  switch (ch) {
    case "n":
      return { text: "\n", end: at + 2 };
    case "t":
      return { text: "\t", end: at + 2 };
    case "r":
      return { text: "\r", end: at + 2 };
    case "b":
      return { text: "\b", end: at + 2 };
    case "f":
      return { text: "\f", end: at + 2 };
    case "v":
      return { text: "\v", end: at + 2 };
    case "0":
      return { text: "\0", end: at + 2 };
    case "x": {
      const hex = source.slice(at + 2, at + 4);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) return undefined;
      return { text: String.fromCharCode(Number.parseInt(hex, 16)), end: at + 4 };
    }
    case "u":
      return readUnicodeEscape(source, at);
    default:
      // `\"`, `\\`, `\/` and every other escape stands for the character itself. A
      // surrogate pair written as two `\uXXXX` escapes rejoins here by concatenation.
      return { text: ch, end: at + 2 };
  }
}

/** `\uXXXX` or `\u{X…}`, unescaped. `undefined` when it is malformed or out of range. */
function readUnicodeEscape(source: string, at: number): { text: string; end: number } | undefined {
  if (source[at + 2] === "{") {
    const close = source.indexOf("}", at + 3);
    if (close === -1) return undefined;
    const digits = source.slice(at + 3, close);
    if (!/^[0-9a-fA-F]{1,6}$/.test(digits)) return undefined;
    const code = Number.parseInt(digits, 16);
    if (code > 0x10ffff) return undefined;
    return { text: String.fromCodePoint(code), end: close + 1 };
  }
  const hex = source.slice(at + 2, at + 6);
  if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined;
  return { text: String.fromCharCode(Number.parseInt(hex, 16)), end: at + 6 };
}

/** One quoted string literal, unescaped, and where it ends. `undefined` when unterminated. */
function readQuoted(source: string, open: number): { value: string; end: number } | undefined {
  const quote = source[open];
  if (quote !== '"' && quote !== "'") return undefined;
  let value = "";
  let i = open + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      const decoded = readEscape(source, i);
      if (decoded === undefined) return undefined;
      value += decoded.text;
      i = decoded.end;
      continue;
    }
    if (ch === quote) return { value, end: i + 1 };
    value += ch;
    i += 1;
  }
  return undefined;
}

/** Past whitespace and comments. Never fails: an unterminated comment runs to the end. */
function skipTrivia(source: string, at: number): number {
  let i = at;
  while (i < source.length) {
    const ch = source[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      const newline = source.indexOf("\n", i + 2);
      i = newline === -1 ? source.length : newline + 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      i = close === -1 ? source.length : close + 2;
      continue;
    }
    return i;
  }
  return i;
}

/**
 * Past one value that is not a quoted string — a number, a nested object, an array.
 *
 * Returns the index of the `,` or `}` that ends it, so the caller stays in step. Strings
 * inside it are read properly, which is what keeps a `}` inside a value from ending the
 * literal early. A template literal returns `undefined`: it can interpolate a value this
 * reader cannot know.
 */
function skipValue(source: string, at: number): number | undefined {
  let depth = 0;
  let i = at;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'") {
      const quoted = readQuoted(source, i);
      if (quoted === undefined) return undefined;
      i = quoted.end;
      continue;
    }
    if (ch === "`") return undefined;
    if (ch === "{" || ch === "[" || ch === "(") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === "}" || ch === "]" || ch === ")") {
      if (depth === 0) return ch === "}" ? i : undefined;
      depth -= 1;
      i += 1;
      continue;
    }
    if (ch === "," && depth === 0) return i;
    i += 1;
  }
  return undefined;
}

/** One property name — bare or quoted — and where it ends. */
function readKey(source: string, at: number): { name: string; end: number } | undefined {
  const ch = source[at];
  if (ch === '"' || ch === "'") {
    const quoted = readQuoted(source, at);
    if (quoted === undefined) return undefined;
    return { name: quoted.value, end: quoted.end };
  }
  if (!isIdentStart(source.charCodeAt(at))) return undefined;
  let i = at + 1;
  while (i < source.length && isIdentPart(source.charCodeAt(i))) i += 1;
  return { name: source.slice(at, i), end: i };
}

/**
 * Read one object literal, keeping the string value of `key`.
 *
 * Strict by design: any shape it cannot place — a computed key, a spread, a missing colon,
 * an unterminated string, `key` given twice, `key` given a value that is not a string
 * literal — returns `undefined`, which makes the whole call unmapped. Loosening any of
 * these would mean reporting a command nobody ran.
 */
function readObjectLiteral(
  source: string,
  open: number,
  key: string,
): { value?: string; end: number } | undefined {
  if (source[open] !== "{") return undefined;
  let value: string | undefined;
  let i = skipTrivia(source, open + 1);

  if (source[i] === "}") return { value, end: i + 1 };

  for (;;) {
    const found = readKey(source, i);
    if (found === undefined) return undefined;
    i = skipTrivia(source, found.end);
    if (source[i] !== ":") return undefined;
    i = skipTrivia(source, i + 1);

    const ch = source[i];
    if (ch === '"' || ch === "'") {
      const quoted = readQuoted(source, i);
      if (quoted === undefined) return undefined;
      if (found.name === key) {
        if (value !== undefined) return undefined;
        value = quoted.value;
      }
      i = quoted.end;
    } else {
      if (found.name === key) return undefined;
      const end = skipValue(source, i);
      if (end === undefined) return undefined;
      i = end;
    }

    i = skipTrivia(source, i);
    if (source[i] === ",") {
      i = skipTrivia(source, i + 1);
      // A trailing comma before the brace is legal JavaScript and is not a missing key.
      if (source[i] === "}") return { value, end: i + 1 };
      continue;
    }
    if (source[i] === "}") return { value, end: i + 1 };
    return undefined;
  }
}

/**
 * Read one `tools.<fn>(…)` at `at`, where `source` starts with `tools.` there.
 *
 * `call` is absent when `tools.<fn>` is not called — a bare property access — so the outer
 * scan carries on rather than treating the whole fragment as unreadable. `undefined` means
 * the fragment cannot be read at all.
 */
function readShimCall(source: string, at: number): { call?: ShimCall; end: number } | undefined {
  const nameStart = at + TOOLS_PREFIX.length;
  if (!isIdentStart(source.charCodeAt(nameStart))) return { end: nameStart };
  let i = nameStart + 1;
  while (i < source.length && isIdentPart(source.charCodeAt(i))) i += 1;
  const fn = source.slice(nameStart, i);

  const paren = skipTrivia(source, i);
  if (source[paren] !== "(") return { end: i };
  const argument = skipTrivia(source, paren + 1);
  const ch = source[argument];

  if (ch === "{") {
    const object = readObjectLiteral(source, argument, CMD_KEY);
    if (object === undefined) return undefined;
    const call: ShimCall = object.value === undefined ? { fn } : { fn, cmd: object.value };
    return { call, end: object.end };
  }
  if (ch === '"' || ch === "'") {
    // `apply_patch` takes the patch as one string, and the paths it touches are only in
    // that text, so it is kept and parsed by the same code the live hook uses.
    const quoted = readQuoted(source, argument);
    if (quoted === undefined) return undefined;
    return { call: { fn, text: quoted.value }, end: quoted.end };
  }
  if (ch === ")") return { call: { fn }, end: argument + 1 };
  return undefined;
}

/**
 * Every `tools.<fn>(…)` call in one shim fragment, in order.
 *
 * `undefined` when the fragment cannot be read — which the caller turns into an unmapped
 * call, never into a guess. An empty array means the fragment was read and called no tool.
 *
 * One forward pass, so the work is linear in the fragment's length with no backtracking.
 * String literals are skipped as literals, which is what stops a command that itself
 * contains the text `tools.exec_command(` from being reported as a second call.
 *
 * Pure, and never throws.
 */
export function readShimCalls(source: string): readonly ShimCall[] | undefined {
  if (source.length > MAX_SHIM_SOURCE) return undefined;
  const calls: ShimCall[] = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'") {
      const quoted = readQuoted(source, i);
      if (quoted === undefined) return undefined;
      i = quoted.end;
      continue;
    }
    if (ch === "`") return undefined;
    if (ch === "/" && source[i + 1] === "/") {
      const newline = source.indexOf("\n", i + 2);
      i = newline === -1 ? source.length : newline + 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      // An unterminated block comment swallows the rest, which is a fragment this reader
      // cannot vouch for.
      if (close === -1) return undefined;
      i = close + 2;
      continue;
    }
    if (
      ch === "t" &&
      source.startsWith(TOOLS_PREFIX, i) &&
      (i === 0 || (!isIdentPart(source.charCodeAt(i - 1)) && source[i - 1] !== "."))
    ) {
      const read = readShimCall(source, i);
      if (read === undefined) return undefined;
      if (read.call !== undefined) calls.push(read.call);
      i = read.end;
      continue;
    }
    i += 1;
  }

  return calls;
}

/** A call the reader could not place, under `name`. */
function unmapped(name: string): SessionToolCall {
  return { kind: "unmapped", name };
}

/** What one recovered shim call is evaluated as. */
function mapShimCall(call: ShimCall): SessionToolCall {
  switch (call.fn) {
    case EXEC_COMMAND:
      // A call whose `cmd` could not be read is unmapped, not a `Bash` with an empty
      // channel: an empty channel matches nothing and would vanish from the report.
      return call.cmd === undefined
        ? unmapped(EXEC_COMMAND)
        : {
            kind: "action",
            candidates: [{ tool: "Bash", args: { full_command: capEnd(call.cmd) } }],
          };
    case APPLY_PATCH: {
      // The same parser the live hook runs, so a guardrail written against a file path
      // gives the same answer in a report as it did when the edit was attempted. A patch
      // whose text could not be read, or that names no path, is unmapped rather than an
      // edit with an empty channel: an empty channel matches nothing and would read as
      // "checked and fine".
      const candidates = call.text === undefined ? [] : patchCandidates(call.text);
      const [first, ...rest] = candidates;
      return first === undefined
        ? unmapped(APPLY_PATCH)
        : { kind: "action", candidates: [first, ...rest] };
    }
    default:
      return unmapped(call.fn);
  }
}

/**
 * What one tool call from a session file is evaluated as. See the table in the header.
 *
 * One or more, because one `exec` call can hold more than one `tools.<fn>` call.
 *
 * Pure, and never throws.
 */
export function mapCodexSessionTool(use: ToolUse): readonly SessionToolCall[] {
  if (use.name !== CODEX_SHIM_TOOL) return [unmapped(use.name)];
  const source = use.input.input;
  if (typeof source !== "string") return [unmapped(CODEX_SHIM_TOOL)];
  const calls = readShimCalls(source);
  if (calls === undefined || calls.length === 0) return [unmapped(CODEX_SHIM_TOOL)];
  return calls.map(mapShimCall);
}

/** Every tool call in a Codex session, in order, as what it is evaluated as. */
export function* codexSessionCalls(session: ParsedSession): Iterable<SessionToolCall> {
  for (const turn of session.turns) {
    for (const use of turn.toolUses) yield* mapCodexSessionTool(use);
  }
}

/** A folder's entries, sorted, or `undefined` when it cannot be listed. */
function listFolder(io: CodexTranscriptIO, path: string): string[] | undefined {
  try {
    return [...io.readdir(path)].sort();
  } catch {
    return undefined;
  }
}

/** Whether `path` is a folder. `false` when it cannot be read. */
function isFolder(io: CodexTranscriptIO, path: string): boolean {
  try {
    return io.stat(path).isDirectory();
  } catch {
    return false;
  }
}

/** One session file to read. */
interface SessionFile {
  readonly path: string;
  /** The file's name without `.jsonl`, used as the session id when the file names none. */
  readonly id: string;
  readonly mtimeMs: number;
}

/**
 * Every session file under `root`, and the files whose details could not be read.
 *
 * Exactly `SESSION_DEPTH` folders down, and no deeper: a file elsewhere is left to the
 * not-read count rather than opened on the guess that it is a session.
 */
function findSessionFiles(
  io: CodexTranscriptIO,
  root: string,
): { files: SessionFile[]; unreadableFiles: number } {
  const files: SessionFile[] = [];
  let unreadableFiles = 0;

  const walk = (folder: string, depth: number): void => {
    for (const entry of listFolder(io, folder) ?? []) {
      const path = join(folder, entry);
      if (depth < SESSION_DEPTH) {
        if (isFolder(io, path)) walk(path, depth + 1);
        continue;
      }
      if (!entry.endsWith(".jsonl")) continue;
      try {
        const stat = io.stat(path);
        if (stat.isDirectory()) continue;
        files.push({ path, id: entry.slice(0, -".jsonl".length), mtimeMs: stat.mtimeMs });
      } catch {
        unreadableFiles++;
      }
    }
  };

  walk(root, 0);
  return { files, unreadableFiles };
}

/** Every `.jsonl` file under `path` that can be read, at any depth up to the cap. */
function countSessionFiles(io: CodexTranscriptIO, path: string, depth = 0): number {
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

/** One file's records as a session, or `undefined` when it held no message at all. */
function toSession(file: SessionFile, records: CodexFileRecords): ParsedSession | undefined {
  const turns: readonly Turn[] = records.turns;
  const userPrompts: readonly UserPrompt[] = records.userPrompts;
  const hasCalls = turns.some((turn) => turn.toolUses.length > 0);
  if (!hasCalls && userPrompts.length === 0) return undefined;

  const stamp = isoTime(file.mtimeMs);
  return {
    sessionId: records.sessionId ?? file.id,
    version: records.version,
    gitBranch: null,
    cwd: records.cwd,
    turns,
    userPrompts,
    toolResults: new Map(),
    firstTimestamp: records.firstTimestamp === "" ? stamp : records.firstTimestamp,
    lastTimestamp: records.lastTimestamp === "" ? stamp : records.lastTimestamp,
    skippedLines: records.counts.unparseableLines + records.counts.truncatedLastLines,
  };
}

/**
 * Read every Codex session under `root` into a corpus for `aggregateScan`.
 *
 * Never throws. A missing `root` is an empty corpus: someone who has not run Codex.
 *
 * `projects` is the number of DISTINCT working directories the sessions came from, since
 * Codex files itself by date rather than by project. A count, never a name — the same
 * promise the other readers make. A session whose file carries no working directory adds
 * nothing to it, so the count is of what is known rather than of what is guessed.
 */
export async function readCodexCorpus(root: string, io: CodexTranscriptIO): Promise<ScanCorpus> {
  const sessions: ParsedSession[] = [];
  const workingDirectories = new Set<string>();
  let quarantined = 0;
  let counts = NO_LINE_COUNTS;

  const found = findSessionFiles(io, root);
  let unreadableFiles = found.unreadableFiles;

  for (const file of found.files) {
    let records: CodexFileRecords;
    try {
      records = await readCodexFile(file.path, io, {
        timestamp: isoTime(file.mtimeMs),
        idPrefix: file.id,
      });
    } catch {
      // What a file held is used only when it was read to the end.
      unreadableFiles++;
      continue;
    }
    counts = addLineCounts(counts, records.counts);
    const session = toSession(file, records);
    if (session === undefined) {
      quarantined++;
      continue;
    }
    sessions.push(session);
    if (session.cwd !== null) workingDirectories.add(session.cwd);
  }

  // Never negative: a file that appeared or vanished mid-walk must not print as a
  // negative count.
  const notRead = Math.max(0, countSessionFiles(io, root) - found.files.length);
  const skipped: ReaderSkips = { ...counts, unreadableFiles };
  return {
    agent: "codex",
    capabilities: { tokens: true, skips: true },
    sessions,
    quarantined,
    notRead,
    projects: workingDirectories.size,
    skipped,
  };
}
