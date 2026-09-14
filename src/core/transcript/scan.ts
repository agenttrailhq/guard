/**
 * Transcript discovery / inventory.
 *
 * Enumerates `~/.claude/projects/<project>/<session>.jsonl` via `readdir` +
 * `stat` and a BOUNDED, STREAMING forward-sniff — never a full-content parse
 * and never a whole-file buffer, so the inventory stays immune to
 * transcript-format drift and memory-safe on huge sessions. Line 1 of a
 * transcript is a `summary`/`custom-title` record that carries only
 * `sessionId` (no `cwd`/`gitBranch`/`version`), so identity is sniffed FORWARD
 * to the first `system`/`user`/`assistant` record. Message count is a cheap
 * line tally; the session date is the file mtime. Uploads nothing.
 */

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import { fileLineSource, type LineSource } from "./parse.js";

/** Default projects root — Claude Code writes per-session JSONL here. */
export function defaultProjectsRoot(home: string = homedir()): string {
  return join(home, ".claude", "projects");
}

/** One session in the inventory. */
export interface SessionInventoryItem {
  readonly sessionId: string;
  readonly file: string;
  readonly project: string;
  readonly cwd: string | null;
  readonly gitBranch: string | null;
  readonly version: string | null;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
  readonly messageCount: number;
}

/** The grouped scan result. */
export interface ScanInventory {
  readonly projectsRoot: string;
  readonly projects: readonly {
    readonly project: string;
    readonly sessions: readonly SessionInventoryItem[];
  }[];
  readonly totalSessions: number;
  /**
   * COUNT (never a name/path) of sessions on this machine that belong to OTHER
   * projects and were dropped by the current-project scope. Present
   * only when `scanTranscripts` is called with a `projectRoot` (scoped); absent
   * when unscoped (so `undefined` ⇒ "scoping was off", distinct from `0`).
   */
  readonly excludedOtherProject?: number;
  /**
   * COUNT of sessions dropped because their working directory could NOT be
   * recovered from the transcript (`cwd: null` → fail-closed). Surfaced
   * SEPARATELY from `excludedOtherProject` because this is OUR parse gap, not
   * the user's setup. Present only when scoped.
   */
  readonly excludedUnknownCwd?: number;
}

/** Injectable directory/stat surface (defaults to real `node:fs`) — tests touch no disk. */
export interface ScanIO {
  readdir?: (p: string) => string[];
  stat?: (p: string) => { size: number; mtimeMs: number; isDirectory: () => boolean };
  /** Line source for the bounded sniff + tally (defaults to a streaming file reader). */
  lineSource?: LineSource;
}

/** Max lines JSON-parsed during the identity forward-sniff (bounded — not a full parse). */
const SNIFF_LINE_CAP = 40;

interface Identity {
  cwd: string | null;
  gitBranch: string | null;
  version: string | null;
  sessionId: string | null;
}

/**
 * Stream a transcript: JSON.parse at most {@link SNIFF_LINE_CAP} lines to
 * recover identity, then only tally the remaining lines (no parse, no buffer).
 */
async function sniff(
  path: string,
  source: LineSource,
): Promise<Identity & { messageCount: number }> {
  const id: Identity = { cwd: null, gitBranch: null, version: null, sessionId: null };
  let messageCount = 0;
  let sniffed = 0;
  for await (const line of source.readLines(path)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    messageCount++;
    const complete = id.cwd && id.gitBranch && id.version && id.sessionId;
    if (sniffed < SNIFF_LINE_CAP && !complete) {
      sniffed++;
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>;
        id.sessionId ??= typeof obj.sessionId === "string" ? obj.sessionId : null;
        id.cwd ??= typeof obj.cwd === "string" ? obj.cwd : null;
        id.gitBranch ??= typeof obj.gitBranch === "string" ? obj.gitBranch : null;
        id.version ??= typeof obj.version === "string" ? obj.version : null;
      } catch {
        // Malformed line during sniff → skip, keep going.
      }
    }
  }
  return { ...id, messageCount };
}

/**
 * Is a session (identified by its recorded `cwd`) inside `projectRoot`?
 *
 * FAIL-CLOSED: a `null` cwd (unparseable / malformed session) is
 * NEVER in scope — unknown provenance must not leak across the project boundary.
 * Otherwise in-scope iff `cwd` is AT or UNDER `projectRoot`, tested with a real
 * path boundary via `path.relative` (NOT `startsWith`): a sibling `/w/repo-ab`
 * is not under `/w/repo-a`. Ambiguity resolves to EXCLUDED — for a privacy
 * filter, under-inclusion is safe and over-inclusion is a leak.
 */
export function isSessionInProject(cwd: string | null, projectRoot: string): boolean {
  if (cwd === null) return false;
  const rel = relative(projectRoot, cwd);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Scan the projects root into a grouped inventory.
 *
 * @param projectsRoot Defaults to `~/.claude/projects`.
 * @param projectRoot When set, scope the inventory to sessions whose recorded
 *   `cwd` is at/under this root. Scoping happens here so no caller can forget
 *   the filter. `undefined` ⇒ unscoped (all projects),
 *   which keeps the function generically unit-testable.
 */
export async function scanTranscripts(
  projectsRoot: string = defaultProjectsRoot(),
  projectRoot?: string,
  io: ScanIO = {},
): Promise<ScanInventory> {
  const readdir = io.readdir ?? ((p: string) => readdirSync(p));
  const stat = io.stat ?? ((p: string) => statSync(p));
  const source = io.lineSource ?? fileLineSource;
  const scoped = projectRoot !== undefined;

  // Exclusion tallies (COUNTS ONLY, no names/paths) — surfaced on the result when
  // scoped so the user is never handed an unexplained zero. Incremented in
  // the SESSION loop, BEFORE the empty-project drop below, so a project whose
  // sessions are ALL out of scope still contributes to the count.
  let excludedOtherProject = 0;
  let excludedUnknownCwd = 0;

  const finalize = (
    projects: { project: string; sessions: SessionInventoryItem[] }[],
    totalSessions: number,
  ): ScanInventory =>
    scoped
      ? { projectsRoot, projects, totalSessions, excludedOtherProject, excludedUnknownCwd }
      : { projectsRoot, projects, totalSessions };

  let projectDirs: string[];
  try {
    projectDirs = readdir(projectsRoot);
  } catch {
    return finalize([], 0);
  }

  const projects: { project: string; sessions: SessionInventoryItem[] }[] = [];
  let totalSessions = 0;

  for (const project of projectDirs.sort()) {
    const dir = join(projectsRoot, project);
    let entries: string[];
    try {
      if (!stat(dir).isDirectory()) continue;
      entries = readdir(dir);
    } catch {
      continue;
    }

    const sessions: SessionInventoryItem[] = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".jsonl")) continue;
      const file = join(dir, entry);
      let size = 0;
      let mtimeMs = 0;
      try {
        const s = stat(file);
        size = s.size;
        mtimeMs = s.mtimeMs;
      } catch {
        continue;
      }
      let identity: Identity & { messageCount: number };
      try {
        identity = await sniff(file, source);
      } catch {
        identity = { cwd: null, gitBranch: null, version: null, sessionId: null, messageCount: 0 };
      }

      // Current-project scope: drop out-of-scope sessions here, tallying
      // WHY — BEFORE the `sessions.length > 0` drop, so a wholly-out-of-scope repo
      // still counts. `cwd: null` is our parse gap (counted separately); a non-null
      // cwd outside the tree is another project's session.
      if (scoped && !isSessionInProject(identity.cwd, projectRoot)) {
        if (identity.cwd === null) excludedUnknownCwd++;
        else excludedOtherProject++;
        continue;
      }

      sessions.push({
        sessionId: identity.sessionId ?? basename(entry, ".jsonl"),
        file,
        project,
        cwd: identity.cwd,
        gitBranch: identity.gitBranch,
        version: identity.version,
        sizeBytes: size,
        modifiedAt: new Date(mtimeMs).toISOString(),
        messageCount: identity.messageCount,
      });
    }

    if (sessions.length > 0) {
      projects.push({ project, sessions });
      totalSessions += sessions.length;
    }
  }

  return finalize(projects, totalSessions);
}
