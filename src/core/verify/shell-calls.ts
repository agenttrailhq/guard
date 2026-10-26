// cspell:words pushd
/**
 * The tool calls the git-backed checks read: every shell command in a corpus, with its result
 * and the folder it ran in, and every file the agent wrote.
 *
 * Calls are read exactly as `aggregateScan` reads them, through the same per-app mapping
 * (`toolUseCalls`), and a Claude Code tool-use id seen twice in one session counts once.
 *
 * ── Ran, or only mentioned ───────────────────────────────────────────────────
 * Each check finds what it looks for with its own reader of the command (`Detector`), run on
 * the command with its data regions blanked (`executedView`). What it finds there is judged by
 * the call's result through the classifier (`runVerdict`). What it finds only inside a blanked
 * region — the command written out in printed text, a search pattern, a heredoc or a comment —
 * is a mention. Only what a check finds in a call that RAN is counted as something that
 * happened.
 *
 * ── The folder a command ran in ──────────────────────────────────────────────
 * The session's working directory, then each `cd` or `pushd` in the same command, with a
 * subshell's `cd` undone at its `)`. A `cd` in an earlier call is not followed. A relative
 * path with no known folder is left unresolved, and the check that needs it says it could
 * not check.
 *
 * Pure. No I/O.
 */

import { isAbsolute, join, resolve } from "node:path";
import { type ScanCorpus, toolUseCalls } from "../scan-report.js";
import type { ToolResult } from "../transcript/transcript-types.js";
import type { AgentSource, MappedCall } from "../types.js";
import { executedView, runVerdict } from "./ran.js";
import { directoryChange, type ShellCommand, type ShellWord, shellItems } from "./shell-words.js";
import type { RunTally, RunVerdict } from "./types.js";

/** One shell command from a corpus. */
export interface ShellCall {
  /** Its position across the corpus, in reading order. */
  readonly id: number;
  /** The index of its session in the corpus. */
  readonly session: number;
  /** The call as the guardrails see it: a `Bash` call with its command. */
  readonly mapped: MappedCall;
  readonly command: string;
  /** The command with every region that is only data blanked out. */
  readonly view: string;
  readonly result: ToolResult | undefined;
  /** The session's working directory, when it names an absolute one. */
  readonly cwd: string | undefined;
}

/** One file the agent wrote, with an edit tool or a shell redirection. */
export interface FileWrite {
  readonly id: number;
  readonly session: number;
  /** The absolute path, resolved against the folder the call ran in. */
  readonly path: string;
  /**
   * What the call wrote, when the app records it: the strings of an edit tool's input, the
   * old text of a replacement left out. Empty for a shell redirection.
   */
  readonly texts: readonly string[];
}

/** What the git-backed checks read from a corpus. */
export interface CallLog {
  readonly agent: AgentSource;
  /** The home folder, for `~`. */
  readonly home: string;
  readonly shell: readonly ShellCall[];
  /** Files the agent wrote in calls that ran. */
  readonly writes: readonly FileWrite[];
  /** How many sessions the corpus holds. */
  readonly sessions: number;
  /** The sessions' working directories, each once, in the order first seen. */
  readonly folders: readonly string[];
}

/** Tools that write a file. */
const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Input keys that name the file, or hold the text an edit replaces, rather than what it wrote. */
const NOT_WRITTEN_KEYS: ReadonlySet<string> = new Set([
  "file_path",
  "path",
  "notebook_path",
  "old_string",
  "old_str",
  "target_file",
]);

/** Deepest nesting `writtenTexts` reads. */
const MAX_DEPTH = 8;

/** The strings an edit tool's input wrote. */
function writtenTexts(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > MAX_DEPTH) return out;
  if (typeof value === "string") {
    if (value !== "") out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) writtenTexts(item, out, depth + 1);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (!NOT_WRITTEN_KEYS.has(key)) writtenTexts(item, out, depth + 1);
    }
  }
  return out;
}

/**
 * An absolute path for `path`, read from `folder`, or `undefined` when it cannot be told: a
 * relative path with no known folder, or `~user`.
 */
export function resolvePath(
  folder: string | undefined,
  path: string,
  home: string,
): string | undefined {
  if (path === "") return undefined;
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  if (path.startsWith("~")) return undefined;
  if (isAbsolute(path)) return resolve(path);
  if (folder === undefined) return undefined;
  return resolve(folder, path);
}

/**
 * Visit each simple command of `text` with the folder it runs in. See "The folder a command
 * ran in".
 */
export function walkCommands(
  text: string,
  cwd: string | undefined,
  home: string,
  visit: (command: ShellCommand, folder: string | undefined) => void,
): void {
  let folder = cwd;
  const saved: (string | undefined)[] = [];
  for (const item of shellItems(text)) {
    if (item.kind === "open") {
      saved.push(folder);
      continue;
    }
    if (item.kind === "close") {
      if (saved.length > 0) folder = saved.pop();
      continue;
    }
    visit(item, folder);
    const change = directoryChange(item.words);
    if (change.kind === "to") folder = resolvePath(folder, change.path, home);
    else if (change.kind === "home") folder = home;
    else if (change.kind === "unknown") folder = undefined;
  }
}

/** The folder a `git` command runs on, after its `-C` options. */
export function gitFolder(
  folder: string | undefined,
  options: readonly ShellWord[],
  home: string,
): string | undefined {
  let at = folder;
  for (const option of options) {
    if (option.expands) return undefined;
    at = resolvePath(at, option.value, home);
  }
  return at;
}

/** A session's working directory, when it is an absolute path. */
function sessionFolder(cwd: string | null): string | undefined {
  return cwd !== null && cwd !== "" && isAbsolute(cwd) ? resolve(cwd) : undefined;
}

/** Every shell command and every file write in a corpus. */
export function readCalls(corpus: ScanCorpus, home: string): CallLog {
  const agent: AgentSource = corpus.agent ?? "claude";
  const shell: ShellCall[] = [];
  const writes: FileWrite[] = [];
  const folders = new Set<string>();
  let id = 0;

  corpus.sessions.forEach((session, index) => {
    const cwd = sessionFolder(session.cwd);
    if (cwd !== undefined) folders.add(cwd);
    const seen = new Set<string>();
    for (const turn of session.turns) {
      for (const use of turn.toolUses) {
        if (agent === "claude" && use.toolUseId !== "") {
          if (seen.has(use.toolUseId)) continue;
          seen.add(use.toolUseId);
        }
        const result = session.toolResults.get(use.toolUseId);
        for (const call of toolUseCalls(agent, use)) {
          if (call.kind !== "action") continue;
          for (const mapped of call.candidates) {
            id += 1;
            const command = mapped.args.full_command;
            if (mapped.tool === "Bash" && command !== undefined) {
              const view = executedView(command).text;
              const entry: ShellCall = {
                id,
                session: index,
                mapped,
                command,
                view,
                result,
                cwd,
              };
              shell.push(entry);
              for (const path of redirectWrites(agent, entry, home)) {
                writes.push({ id, session: index, path, texts: [] });
              }
              continue;
            }
            const file = mapped.args.file_path;
            if (!EDIT_TOOLS.has(mapped.tool) || file === undefined) continue;
            const path = resolvePath(cwd, file, home);
            if (path === undefined) continue;
            if (runVerdict(agent, mapped, result, () => true).state !== "ran") continue;
            // Codex's patch text is one shim string for every file it touches, so what it wrote
            // to one file is not told apart; its writes carry no text.
            const texts = agent === "codex" ? [] : writtenTexts(use.input);
            writes.push({ id, session: index, path, texts });
          }
        }
      }
    }
  });
  return {
    agent,
    home,
    shell,
    writes,
    sessions: corpus.sessions.length,
    folders: [...folders],
  };
}

/** The files a shell call that ran wrote through a redirection, as absolute paths. */
function redirectWrites(agent: AgentSource, call: ShellCall, home: string): string[] {
  if (!/>/.test(call.view)) return [];
  const find = (text: string): string[] => {
    const out: string[] = [];
    walkCommands(text, call.cwd, home, (command, folder) => {
      for (const target of command.writes) {
        if (target.expands) continue;
        const path = resolvePath(folder, target.value, home);
        if (path !== undefined && !path.startsWith("/dev/")) out.push(path);
      }
    });
    return out;
  };
  const verdict = runVerdict(
    agent,
    call.mapped,
    call.result,
    (m) => find(m.args.full_command ?? "").length > 0,
  );
  return verdict.state === "ran" ? find(call.view) : [];
}

/** A call one check found something in, and whether it ran. */
export interface Judged<F> {
  readonly call: ShellCall;
  readonly verdict: RunVerdict;
  /** What the check found in the text that ran. Empty unless the call ran. */
  readonly found: readonly F[];
}

/** Reads one kind of thing out of a command's text. */
export type Detector<F> = (text: string, cwd: string | undefined, home: string) => F[];

/** Most words of one blanked region read again as a command of their own. */
const MAX_MENTION_WORDS = 64;

/**
 * The regions of a command its executed view blanked out — printed text, a search pattern, a
 * message, a heredoc fed to a file, a comment — as the text they held.
 */
export function blankedRegions(command: string, view: string): string[] {
  const out: string[] = [];
  let start = -1;
  let last = -1;
  for (let i = 0; i <= command.length; i++) {
    const blanked = i < command.length && view[i] !== command[i];
    if (blanked) {
      if (start < 0) start = i;
      last = i;
    } else if (start >= 0 && (i >= command.length || !/\s/.test(command[i] as string))) {
      out.push(command.slice(start, last + 1));
      start = -1;
    }
  }
  return out;
}

/**
 * Does a blanked region of the call hold what `detect` looks for, written out as a command?
 * The region is read as shell text, and each of its words again on its own, so a command
 * quoted inside `echo "…"` or a search pattern is found.
 */
function mentionedIn<F>(call: ShellCall, detect: Detector<F>, home: string): boolean {
  for (const blanked of blankedRegions(call.command, call.view)) {
    // A comment's text, without the `#` that makes it one.
    const region = blanked.replace(/^#+/, "");
    if (detect(region, call.cwd, home).length > 0) return true;
    const words = shellItems(region).flatMap((item) =>
      item.kind === "command" ? item.words.map((w) => w.value) : [],
    );
    for (const word of words.slice(0, MAX_MENTION_WORDS)) {
      if (word.includes(" ") && detect(word, call.cwd, home).length > 0) return true;
    }
  }
  return false;
}

/**
 * Judge one call for one check. `undefined` when the check finds nothing in the call;
 * otherwise the verdict, and what was found in the part that ran.
 *
 * What the check finds in the text that ran is judged by the call's result (`runVerdict`).
 * What it finds only inside a region the executed view blanked out — the command written in
 * printed text, a search pattern or a heredoc — is a mention, and `runVerdict` says so with
 * the kind of region.
 *
 * `hint` is a cheap test on the raw command that every match passes, so most calls are never
 * parsed.
 */
export function judge<F>(
  log: CallLog,
  call: ShellCall,
  hint: RegExp,
  detect: Detector<F>,
): Judged<F> | undefined {
  if (!hint.test(call.command)) return undefined;
  const found = detect(call.view, call.cwd, log.home);
  if (found.length === 0) {
    if (!mentionedIn(call, detect, log.home)) return undefined;
    // Nothing is found once the mentions are blanked out, so this is the classifier's mention.
    const verdict = runVerdict(log.agent, call.mapped, call.result, () => false);
    return { call, verdict, found: [] };
  }
  const verdict = runVerdict(
    log.agent,
    call.mapped,
    call.result,
    (m) => detect(m.args.full_command ?? "", call.cwd, log.home).length > 0,
  );
  return { call, verdict, found: verdict.state === "ran" ? found : [] };
}

/** Every call one check finds something in, judged. */
export function judgeAll<F>(log: CallLog, hint: RegExp, detect: Detector<F>): Judged<F>[] {
  const out: Judged<F>[] = [];
  for (const call of log.shell) {
    const judged = judge(log, call, hint, detect);
    if (judged !== undefined) out.push(judged);
  }
  return out;
}

/** Judged calls counted by whether they ran. */
export function tallyOf(judged: readonly Judged<unknown>[]): RunTally {
  const tally = { ran: 0, mentioned: 0, unknown: 0 };
  for (const j of judged) tally[j.verdict.state] += 1;
  return tally;
}

/** The output a call recorded, as text. Empty when none was recorded. */
export function outputOf(call: ShellCall): string {
  return call.result?.content ?? "";
}
