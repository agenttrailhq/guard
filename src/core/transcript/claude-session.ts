/**
 * Reading one Claude Code session: its main transcript with its sub-agents' transcripts folded
 * in. The scan reads every session through this, on the main thread or on a worker thread
 * (`scan-workers.ts`), so both read a session the same way.
 */

import { basename, dirname, join } from "node:path";
import type { ScanIO } from "../../scan-io.js";
import type { SecretsCollector } from "../verify/secrets.js";
import { parseSession } from "./parse.js";
import type { ParsedSession } from "./transcript-types.js";

/** What reading a session needs from the scan's seam. */
export type SessionReadIO = Pick<ScanIO, "readLines" | "readdir" | "stat">;

/** One session's reading. See `readClaudeSession`. */
export interface ClaudeSessionRead {
  readonly session?: ParsedSession;
  readonly opened: number;
  readonly files: readonly string[];
}

/**
 * Read one session file and fold in its sub-agents' transcripts.
 *
 * A sub-agent's tool calls ran on this machine inside this session, written to
 * `<project>/<session>/subagents/*.jsonl`, so they are read into the same session — exactly
 * as the Cursor reader folds a session's sub-agents. `opened` counts every file this
 * actually read (the main file plus each sub-agent file), so the coverage tally is honest.
 * `session` is absent when the main file could not be folded into a session (quarantined);
 * its sub-agents are then left to the not-read count. `files` lists the files that were folded
 * into the session.
 */
export async function readClaudeSession(
  io: SessionReadIO,
  item: { readonly file: string; readonly sessionId: string },
  collector?: SecretsCollector,
): Promise<ClaudeSessionRead> {
  const source = { readLines: (p: string) => io.readLines(p) };
  /** Parse one file, handing its records to the secrets collector when there is one. */
  const parse = async (path: string, id: string): Promise<ParsedSession> => {
    if (collector === undefined) return await parseSession(path, id, source);
    const index = collector.file(path);
    const parsed = await parseSession(path, id, source, (record) =>
      collector.record(index, record),
    );
    collector.read(index);
    return parsed;
  };

  let session: ParsedSession;
  try {
    session = await parse(item.file, item.sessionId);
  } catch {
    // QuarantineError or any other read failure: the main file was attempted and yielded
    // no session. Count the one file; leave its sub-agents to the not-read count.
    return { opened: 1, files: [] };
  }
  let opened = 1;
  const files = [item.file];

  const subDir = subagentsDir(item.file);
  let names: readonly string[];
  try {
    names = io.readdir(subDir);
  } catch {
    // No sub-agents folder (the common case) is not a failure.
    names = [];
  }

  const turns = [...session.turns];
  const userPrompts = [...session.userPrompts];
  const seenTurns = new Set(turns.map((t) => t.messageUuid).filter((u) => u !== ""));
  const seenPrompts = new Set(userPrompts.map((p) => p.messageUuid).filter((u) => u !== ""));
  // A sub-agent's calls have their results in its own file. They are folded in by tool-use id,
  // so a call made inside a sub-agent is judged by its recorded result. The main file is read
  // first and keeps its result for an id that appears twice; so does the earlier of two
  // sub-agent files, in name order.
  const toolResults = new Map(session.toolResults);
  let skippedLines = session.skippedLines;

  for (const name of [...names].sort()) {
    if (!name.endsWith(".jsonl")) continue;
    const subPath = join(subDir, name);
    try {
      if (io.stat(subPath).isDirectory()) continue;
    } catch {
      continue; // vanished or unreadable between listing and stat
    }
    opened += 1;
    let sub: ParsedSession;
    try {
      sub = await parse(subPath, name);
    } catch {
      continue; // a sub-agent file that yields no session adds nothing; it was still opened
    }
    files.push(subPath);
    skippedLines += sub.skippedLines;
    // De-dup by message uuid so one turn's tokens and tool calls count once even if a main
    // transcript inlined the sub-agent, or a file is somehow read twice. A turn with no
    // uuid is always kept — there is no id to fold on.
    for (const turn of sub.turns) {
      if (turn.messageUuid !== "" && seenTurns.has(turn.messageUuid)) continue;
      if (turn.messageUuid !== "") seenTurns.add(turn.messageUuid);
      turns.push(turn);
    }
    for (const prompt of sub.userPrompts) {
      if (prompt.messageUuid !== "" && seenPrompts.has(prompt.messageUuid)) continue;
      if (prompt.messageUuid !== "") seenPrompts.add(prompt.messageUuid);
      userPrompts.push(prompt);
    }
    for (const [id, result] of sub.toolResults) {
      if (!toolResults.has(id)) toolResults.set(id, result);
    }
  }

  return {
    session: { ...session, turns, userPrompts, toolResults, skippedLines },
    opened,
    files,
  };
}

/** Where a session's sub-agents' transcripts are: `<project>/<session>/subagents`. */
function subagentsDir(file: string): string {
  return join(dirname(file), basename(file, ".jsonl"), "subagents");
}

/**
 * About how much there is to read in a session: the bytes of its main transcript and its
 * sub-agents' transcripts. What cannot be read counts as nothing. For sharing sessions out
 * between threads only.
 */
export function sessionBytes(io: Pick<ScanIO, "readdir" | "stat">, file: string): number {
  const size = (path: string): number => {
    try {
      return io.stat(path).size;
    } catch {
      return 0;
    }
  };
  let bytes = size(file);
  let names: readonly string[] = [];
  try {
    names = io.readdir(subagentsDir(file));
  } catch {
    // No sub-agents folder.
  }
  for (const name of names)
    if (name.endsWith(".jsonl")) bytes += size(join(subagentsDir(file), name));
  return bytes;
}
