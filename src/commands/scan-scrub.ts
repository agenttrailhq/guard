// cspell:words Fingerprinter
/**
 * `agenttrail-guard scan --agent <app> --scrub [--apply]`: replace likely-real credentials in
 * the app's transcripts with `[REDACTED-BY-AGENTTRAIL:<kind>]`.
 *
 * ── What is replaced ─────────────────────────────────────────────────────────
 * Only the values the secrets check classes as likely real (`verify/secrets.ts`). Committed
 * fixtures, placeholders and local dev data are left alone, and there is no pattern pass of
 * its own: a value is replaced because the check found it, wherever it appears in the file.
 *
 * ── Dry run unless `--apply` ─────────────────────────────────────────────────
 * Without `--apply` it reads, and says per file how many values of each kind it would
 * replace. It writes nothing, not even a backup.
 *
 * ── With `--apply` ───────────────────────────────────────────────────────────
 *  1. Two separate checks, each named below, because a running agent appends to its
 *     transcript:
 *     - `agentProcessCheck`: refuse the whole run while a process of that app is running, or
 *       when the process list cannot be read. Names only, never arguments.
 *     - `isRecentlyModified`: skip any file changed in the last five minutes.
 *     There is no flag to override either.
 *  2. Back up every file it will change, before changing any, to a new folder under
 *     `~/.agenttrail/scrub-backups/` (`0700`, files `0600`), with a manifest and the commands
 *     to restore each file. If any backup fails, nothing is changed and the partial backup is
 *     removed.
 *  3. Replace each file atomically, refusing a file that changed since it was read
 *     (`scrub-io.ts`).
 *  4. Read each file back and confirm it holds exactly the checked bytes.
 *
 * ── Never the value ──────────────────────────────────────────────────────────
 * The values are held in memory for the run. They are written only into the rewritten
 * transcript (as the replacement) and the backup (as the original bytes). The terminal gets
 * paths, counts and kinds.
 *
 * ── What it does not scrub ───────────────────────────────────────────────────
 * Anything outside the app's session files: its prompt history and caches, the shell's own
 * history, and the backup this command makes. The output says so.
 */

import { join, relative } from "node:path";
import { unhandledAgent } from "../core/agent.js";
import { createColors } from "../core/color.js";
import { agentName } from "../core/report.js";
import type { ScanCorpus } from "../core/scan-report.js";
import {
  type FileScrubPlan,
  planFileScrub,
  SCRUB_MARKER,
  sha256,
} from "../core/scrub-transcripts.js";
import { formatCount } from "../core/tokens.js";
import type { AgentSource } from "../core/types.js";
import { createFingerprinter } from "../core/verify/fingerprint.js";
import { findLikelyReal, type LikelyRealValues } from "../core/verify/secrets.js";
import type { SecretKind, VerifyIO, WatchedProcess } from "../core/verify/types.js";
import type { ScanIO } from "../scan-io.js";
import type { ScrubIO, ScrubStat } from "../scrub-io.js";

/** A file changed this recently may belong to a session still in use, and is skipped. */
export const RECENT_WRITE_WINDOW_MS = 5 * 60 * 1000;

/** Most likely-real values held for one run. Past it a value is reported, not replaced. */
export const MAX_SCRUB_VALUES = 50_000;

/** Restore commands printed. All of them are in the backup folder's `restore.txt`. */
const MAX_RESTORE_LINES_SHOWN = 10;

/** Where backups go: `~/.agenttrail/scrub-backups/`. */
export function scrubBackupsRoot(home: string): string {
  return join(home, ".agenttrail", "scrub-backups");
}

/** The name of one run's backup folder: its UTC time, safe on every file system. */
export function backupFolderName(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/** What `agentProcessCheck` found. */
export type AgentProcessState =
  | { readonly state: "running" }
  | { readonly state: "not-running" }
  | { readonly state: "could-not-check" };

/**
 * The process-list id of the app being scrubbed. Every app is a watched process; this stops
 * compiling if one is added that is not.
 */
function watchedIdOf(agent: AgentSource): WatchedProcess {
  return agent;
}

/**
 * Check one: is `agent` itself running? Reads the running watched processes, by id, through
 * the same read-only seam verification uses, which matches process names only. A list that
 * cannot be read, or was too long to read in full, is `could-not-check`, which `--apply` treats
 * as a refusal. Only the app's own id refuses: another app, or any other watched process,
 * does not.
 *
 * It sees an app only under its own name. One started as `node` or under a version-numbered
 * file name is not recognized; `isRecentlyModified` is the second check for that reason.
 */
export async function agentProcessCheck(
  io: VerifyIO,
  agent: AgentSource,
): Promise<AgentProcessState> {
  const listed = await io.processNames();
  if (!listed.ok) return { state: "could-not-check" };
  return listed.running.includes(watchedIdOf(agent))
    ? { state: "running" }
    : { state: "not-running" };
}

/** Check two: was the file changed in the last `RECENT_WRITE_WINDOW_MS`? */
export function isRecentlyModified(mtimeMs: number, nowMs: number): boolean {
  return nowMs - mtimeMs < RECENT_WRITE_WINDOW_MS;
}

/** A path quoted for a POSIX shell. */
function shellQuote(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

/** A path quoted for PowerShell. */
function powershellQuote(path: string): string {
  return `'${path.replaceAll("'", "''")}'`;
}

/** The command that copies a backup over the scrubbed file. */
export function restoreCommand(platform: string, backup: string, original: string): string {
  if (platform === "win32") {
    return `Copy-Item -LiteralPath ${powershellQuote(backup)} -Destination ${powershellQuote(original)} -Force`;
  }
  return `cp -p ${shellQuote(backup)} ${shellQuote(original)}`;
}

/** Why a file was not scrubbed. */
type SkipReason =
  | "unsupported"
  | "unreadable"
  | "too-large"
  | "not-utf8"
  | "recent"
  | "changed"
  | "write-failed"
  | "rename-failed"
  | "verify-failed";

/** The sentence for a skip reason. */
function skipText(reason: SkipReason, code?: string): string {
  switch (reason) {
    case "unsupported":
      return "not a supported transcript format (JSON Lines); left alone";
    case "unreadable":
      return "could not be read; left alone";
    case "too-large":
      return "too large to scrub safely; left alone";
    case "not-utf8":
      return "not UTF-8 text, so it cannot be edited without changing other bytes; left alone";
    case "recent":
      return "changed in the last 5 minutes, so a session may still be writing it; skipped";
    case "changed":
      return "changed since it was read; left as it is";
    case "write-failed":
      return "the scrubbed copy could not be written beside it; left as it is";
    case "rename-failed":
      return `could not be replaced${code === undefined ? "" : ` (${code})`}, which happens when another program holds it open; left as it is`;
    case "verify-failed":
      return "did not read back as written; restore it from the backup";
    default:
      return reason satisfies never;
  }
}

/** One transcript file, once read and planned. */
interface PlannedFile {
  readonly path: string;
  readonly stat: ScrubStat;
  readonly sha256: string;
  readonly plan: Omit<FileScrubPlan, "text">;
}

/** Every file the check read, sorted into those to change, those to skip and the rest. */
interface Planning {
  readonly changes: PlannedFile[];
  readonly skipped: { readonly path: string; readonly reason: SkipReason }[];
  /** Files that hold a value but where no line could be edited. */
  readonly stuck: PlannedFile[];
}

/** `bytes` as UTF-8 text, or `undefined` when they are not valid UTF-8. Keeps a BOM. */
function utf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Read and plan every file. Nothing is written. */
function planFiles(files: readonly string[], found: LikelyRealValues, scrubIO: ScrubIO): Planning {
  const planning: Planning = { changes: [], skipped: [], stuck: [] };
  for (const path of files) {
    if (!path.endsWith(".jsonl")) {
      planning.skipped.push({ path, reason: "unsupported" });
      continue;
    }
    const read = scrubIO.read(path);
    if (!read.ok) {
      planning.skipped.push({
        path,
        reason:
          read.reason === "too-large"
            ? "too-large"
            : read.reason === "changed"
              ? "changed"
              : "unreadable",
      });
      continue;
    }
    const text = utf8(read.bytes);
    if (text === undefined) {
      planning.skipped.push({ path, reason: "not-utf8" });
      continue;
    }
    const { text: _text, ...plan } = planFileScrub(text, found.values);
    const entry: PlannedFile = { path, stat: read.stat, sha256: sha256(read.bytes), plan };
    if (plan.changed) planning.changes.push(entry);
    else if (plan.linesLeft > 0) planning.stuck.push(entry);
  }
  return planning;
}

/** "3 replacements: 2 github-token, 1 aws-access-key". */
function replacementText(plan: Pick<FileScrubPlan, "replaced" | "total">): string {
  const kinds = Object.entries(plan.replaced) as [SecretKind, number][];
  const parts = kinds.map(([kind, n]) => `${formatCount(n)} ${kind}`).join(", ");
  return `${formatCount(plan.total)} ${plan.total === 1 ? "replacement" : "replacements"}: ${parts}`;
}

/** What a run needs. */
export interface ScrubRunInput {
  readonly agent: AgentSource;
  /** The folder the sessions were read from. Paths are shown relative to it. */
  readonly root: string;
  readonly corpus: ScanCorpus;
  readonly apply: boolean;
  readonly io: ScanIO;
  /** The read-only seam: the repos for the fixture test, and the process names. */
  readonly verifyIO: VerifyIO;
  readonly scrubIO: ScrubIO;
  readonly now: Date;
  readonly platform: string;
  readonly colors: boolean;
}

/** `n` and a noun, with the plural when `n` is not 1. */
function counted(n: number, singular: string, plural = `${singular}s`): string {
  return `${formatCount(n)} ${n === 1 ? singular : plural}`;
}

/** The app's session files: what this command can scrub. */
function sessionFilesName(agent: AgentSource): string {
  switch (agent) {
    case "claude":
      return "Claude Code transcripts";
    case "codex":
      return "Codex session files";
    case "cursor":
      return "Cursor agent transcripts";
    default:
      return unhandledAgent(agent);
  }
}

/** Run `scan --scrub`. Returns an exit code; never throws. */
export async function runScrub(input: ScrubRunInput): Promise<number> {
  const { agent, io, scrubIO } = input;
  const c = createColors(input.colors);
  const app = agentName(agent);
  const shown = (path: string): string => {
    const rel = relative(input.root, path);
    return rel === "" || rel.startsWith("..") ? path : rel;
  };
  const lines: string[] = [];
  const flush = (): void => {
    if (lines.length > 0) io.writeStdout(`${lines.join("\n")}\n`);
    lines.length = 0;
  };

  lines.push(
    c.bold(
      `${input.apply ? "Scrub" : "Scrub, dry run"}: ${sessionFilesName(agent)} in ${input.root}`,
    ),
  );
  if (!input.apply) lines.push("Nothing is changed without --apply.");

  const files = [...new Set(input.corpus.files ?? [])];
  const found = await findLikelyReal({
    agent,
    files: files.filter((f) => f.endsWith(".jsonl")),
    readLines: (path) => io.readLines(path),
    io: input.verifyIO,
    fingerprint: createFingerprinter(),
    maxHeldValues: MAX_SCRUB_VALUES,
  });
  const facts = found.check.facts;
  const planning = planFiles(files, found, scrubIO);

  lines.push("");
  const likely = facts.classes["likely-real"];
  lines.push(
    `${counted(likely, "likely-real credential")} in ${counted(facts.filesRead, "transcript file")}.`,
  );
  const leftAlone: string[] = [];
  if (facts.classes["committed-fixture"] > 0) {
    leftAlone.push(counted(facts.classes["committed-fixture"], "committed fixture"));
  }
  if (facts.classes.placeholder > 0) {
    leftAlone.push(
      counted(
        facts.classes.placeholder,
        "placeholder or false positive",
        "placeholders or false positives",
      ),
    );
  }
  if (facts.classes["local-dev"] > 0) {
    leftAlone.push(counted(facts.classes["local-dev"], "local dev value"));
  }
  if (leftAlone.length > 0) lines.push(c.dim(`Left alone: ${leftAlone.join(", ")}.`));

  // What could keep the run from being complete, whatever is applied.
  const gaps: string[] = [];
  const notRead = input.corpus.notRead + input.corpus.quarantined + facts.filesNotRead;
  if (notRead > 0) gaps.push(`${counted(notRead, "transcript file")} could not be read or checked`);
  if (facts.unplaced > 0)
    gaps.push(`${counted(facts.unplaced, "redacted text")} could not be classed`);
  if (found.notHeld > 0) {
    gaps.push(
      `${counted(found.notHeld, "likely-real value")} past the limit of ${formatCount(MAX_SCRUB_VALUES)} cannot be replaced in this run`,
    );
  }
  // Not a gap in the scrub, but a reason it may replace more than it needs to.
  if (facts.reposNotChecked > 0) {
    lines.push(
      c.dim(
        `${counted(facts.reposNotChecked, "repo")} could not be searched for committed fixtures, so a fixture there counts as likely real.`,
      ),
    );
  } else if (likely > 0 && facts.fixtureCheck === "unavailable") {
    lines.push(
      c.dim(
        "No repo was found to search for committed fixtures, so a fixture counts as likely real.",
      ),
    );
  }
  for (const entry of planning.stuck) {
    gaps.push(
      `${shown(entry.path)}: ${counted(entry.plan.linesLeft, "line")} holding a value could not be edited and still parse`,
    );
  }

  if (planning.changes.length === 0) {
    lines.push("");
    lines.push(
      likely === 0
        ? "Nothing to scrub."
        : "Nothing could be replaced: no file holds these values in a form this command can edit.",
    );
    for (const skip of planning.skipped)
      lines.push(`  ${shown(skip.path)}: ${skipText(skip.reason)}`);
    for (const gap of gaps) lines.push(c.yellow(`  ${gap}.`));
    flush();
    return likely === 0 && gaps.length === 0 ? 0 : input.apply ? 1 : 0;
  }

  lines.push("");
  lines.push(input.apply ? "To scrub:" : "Would scrub:");
  for (const entry of planning.changes) {
    lines.push(`  ${shown(entry.path)}  ${replacementText(entry.plan)}`);
  }
  for (const skip of planning.skipped)
    lines.push(`  ${shown(skip.path)}: ${skipText(skip.reason)}`);
  for (const gap of gaps) lines.push(c.yellow(`  ${gap}.`));
  lines.push(c.dim(`Each value becomes [${SCRUB_MARKER}:<kind>].`));

  const advice = (): void => {
    lines.push("");
    lines.push(c.bold("Before you scrub"));
    lines.push(
      "  1. Rotate each credential first. Taking it out of the transcripts does not undo the exposure.",
    );
    lines.push(
      `  2. Close every ${app} session. A running session keeps appending to its transcript.`,
    );
    lines.push(
      c.dim(
        `Not scrubbed by this command: anything ${app} keeps outside these session files (such as its prompt history and caches), your shell history, and the backup --apply makes.`,
      ),
    );
  };

  const running = await agentProcessCheck(input.verifyIO, agent);
  const nowMs = input.now.getTime();
  const recent = planning.changes.filter((f) => isRecentlyModified(f.stat.mtimeMs, nowMs));

  if (!input.apply) {
    lines.push("");
    lines.push("With --apply:");
    lines.push(
      `  every file above is first copied to a new private folder under ${scrubBackupsRoot(io.homedir())},`,
    );
    lines.push("  and then each one is replaced in a single step.");
    if (running.state === "running") {
      lines.push(c.yellow(`  It would refuse to run now: ${app} is running.`));
    } else if (running.state === "could-not-check") {
      lines.push(
        c.yellow("  It would refuse to run now: the list of running programs could not be read."),
      );
    }
    for (const entry of recent) {
      lines.push(c.yellow(`  It would skip ${shown(entry.path)}: ${skipText("recent")}.`));
    }
    advice();
    flush();
    return 0;
  }

  // ── --apply ────────────────────────────────────────────────────────────────
  if (running.state !== "not-running") {
    lines.push("");
    lines.push(
      c.yellow(
        running.state === "running"
          ? `Refused: ${app} is running. Nothing was changed.`
          : "Refused: the list of running programs could not be read, so a running session cannot be ruled out. Nothing was changed.",
      ),
    );
    lines.push(`Close every ${app} session, then run this again.`);
    advice();
    flush();
    return 1;
  }

  const outcomes: { readonly path: string; readonly reason: SkipReason; readonly code?: string }[] =
    recent.map((f) => ({ path: f.path, reason: "recent" }));
  const targets = planning.changes.filter((f) => !isRecentlyModified(f.stat.mtimeMs, nowMs));

  if (targets.length === 0) {
    lines.push("");
    for (const o of outcomes) lines.push(c.yellow(`  ${shown(o.path)}: ${skipText(o.reason)}.`));
    lines.push("Nothing was changed.");
    advice();
    flush();
    return 1;
  }

  // Back up every target before changing any.
  const backupDir = scrubIO.createBackupDir(
    scrubBackupsRoot(io.homedir()),
    backupFolderName(input.now),
  );
  if (backupDir === undefined) {
    lines.push("");
    lines.push(
      c.yellow(
        `Refused: a private backup folder could not be made under ${scrubBackupsRoot(io.homedir())}. Nothing was changed.`,
      ),
    );
    flush();
    return 1;
  }

  /** A file once backed up: what replaces it, and the hash that bytes read back must have. */
  interface BackedUp {
    readonly file: PlannedFile;
    readonly backup: string;
    readonly after: Uint8Array;
    readonly afterSha: string;
  }
  const backedUp: BackedUp[] = [];
  const written: string[] = [];
  const width = String(targets.length).length;
  let backupFailed = false;
  for (const [i, file] of targets.entries()) {
    const read = scrubIO.read(file.path);
    if (!read.ok || sha256(read.bytes) !== file.sha256) {
      outcomes.push({ path: file.path, reason: "changed" });
      continue;
    }
    // The same bytes as were planned, which decoded as UTF-8 then.
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(read.bytes);
    const name = `${String(i + 1).padStart(width, "0")}-${file.path.split(/[\\/]/).pop() ?? "file"}`;
    const backup = join(backupDir, name);
    if (!scrubIO.writeBackupFile(backup, read.bytes)) {
      backupFailed = true;
      break;
    }
    written.push(backup);
    const after = new TextEncoder().encode(planFileScrub(text, found.values).text);
    backedUp.push({
      file: { ...file, stat: read.stat },
      backup,
      after,
      afterSha: sha256(after),
    });
  }

  const manifest = {
    format: 1,
    createdAt: input.now.toISOString(),
    agent,
    note: "These files still hold the credentials that were scrubbed. Delete this folder once you have checked the scrubbed files. sha256After is the hash each file has once scrubbed.",
    files: backedUp.map((b) => ({
      original: b.file.path,
      backup: b.backup,
      size: b.file.stat.size,
      mtimeMs: b.file.stat.mtimeMs,
      sha256Before: b.file.sha256,
      sha256After: b.afterSha,
    })),
  };
  const restoreLines = backedUp.map((b) => restoreCommand(input.platform, b.backup, b.file.path));
  const encoder = new TextEncoder();
  const manifestPath = join(backupDir, "manifest.json");
  const restorePath = join(backupDir, "restore.txt");
  if (!backupFailed && backedUp.length > 0) {
    if (
      scrubIO.writeBackupFile(
        manifestPath,
        encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`),
      )
    ) {
      written.push(manifestPath);
    } else backupFailed = true;
  }
  if (!backupFailed && backedUp.length > 0) {
    if (scrubIO.writeBackupFile(restorePath, encoder.encode(`${restoreLines.join("\n")}\n`))) {
      written.push(restorePath);
    } else backupFailed = true;
  }

  if (backupFailed || backedUp.length === 0) {
    scrubIO.discardBackup(backupDir, written);
    lines.push("");
    for (const o of outcomes) lines.push(c.yellow(`  ${shown(o.path)}: ${skipText(o.reason)}.`));
    lines.push(
      c.yellow(
        backupFailed
          ? "Refused: the backup could not be written in full. Nothing was changed, and the partial backup was removed."
          : "Nothing was changed.",
      ),
    );
    flush();
    return 1;
  }

  lines.push("");
  lines.push(
    `Backed up ${counted(backedUp.length, "file")} to ${backupDir} (readable only by you).`,
  );
  lines.push(
    c.yellow(
      "That backup still holds the credentials. Delete it once you have checked the scrubbed files.",
    ),
  );
  flush();

  // Replace each file, then read it back.
  const scrubbed: BackedUp[] = [];
  for (const b of backedUp) {
    const replaced = scrubIO.replaceFile(b.file.path, b.after, {
      stat: b.file.stat,
      sha256: b.file.sha256,
    });
    if (!replaced.ok) {
      outcomes.push({ path: b.file.path, reason: replaced.reason, code: replaced.code });
      continue;
    }
    const back = scrubIO.read(b.file.path);
    if (!back.ok || sha256(back.bytes) !== b.afterSha) {
      outcomes.push({ path: b.file.path, reason: "verify-failed" });
      continue;
    }
    scrubbed.push(b);
  }

  lines.push("");
  if (scrubbed.length > 0) {
    lines.push("Scrubbed:");
    for (const b of scrubbed) {
      lines.push(`  ${shown(b.file.path)}  ${replacementText(b.file.plan)}`);
      if (b.file.plan.linesIncomplete > 0) {
        lines.push(
          c.yellow(
            `    ${counted(b.file.plan.linesIncomplete, "line")} still ${b.file.plan.linesIncomplete === 1 ? "holds" : "hold"} a value written in a form this command does not edit`,
          ),
        );
      }
      if (b.file.plan.linesLeft > 0) {
        lines.push(
          c.yellow(
            `    ${counted(b.file.plan.linesLeft, "line")} holding a value could not be edited and still parse, and ${b.file.plan.linesLeft === 1 ? "was" : "were"} left as ${b.file.plan.linesLeft === 1 ? "it was" : "they were"}`,
          ),
        );
      }
    }
  }
  if (outcomes.length > 0) {
    lines.push("Not scrubbed:");
    for (const o of outcomes)
      lines.push(c.yellow(`  ${shown(o.path)}: ${skipText(o.reason, o.code)}.`));
  }

  lines.push("");
  lines.push("To put a file back as it was:");
  for (const line of restoreLines.slice(0, MAX_RESTORE_LINES_SHOWN)) lines.push(`  ${line}`);
  if (restoreLines.length > MAX_RESTORE_LINES_SHOWN) {
    lines.push(c.dim(`  and ${formatCount(restoreLines.length - MAX_RESTORE_LINES_SHOWN)} more`));
  }
  lines.push(c.dim(`Every restore command is in ${restorePath}.`));
  lines.push("");
  lines.push("Rotate each credential if you have not: scrubbing does not undo the exposure.");
  lines.push(
    c.dim(
      `Not scrubbed by this command: anything ${app} keeps outside these session files (such as its prompt history and caches), your shell history, and the backup above.`,
    ),
  );
  flush();

  const complete =
    outcomes.length === 0 &&
    gaps.length === 0 &&
    scrubbed.every((b) => b.file.plan.linesLeft === 0 && b.file.plan.linesIncomplete === 0);
  return complete ? 0 : 1;
}
