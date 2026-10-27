// cspell:words nohup execdir okdir
/**
 * The tool calls of a corpus, read once for the checks that look at what commands and edits
 * did: the test, cloud, production, unreviewed-code, egress and dependency checks.
 *
 * Each call is read through the same per-app mapping `scan` evaluates (`toolUseCalls`), and
 * keeps what those checks need beside it: the session it came from and its place in that
 * session, the session's working directory, its recorded result, the guardrails it matched,
 * the shell command for a shell call, and what an edit changed for an edit.
 *
 * Whether a call RAN is decided by `ran.ts` (`runVerdict`), never here. `runStateOf` asks it
 * with the check's own test of the command, so a call whose only match sits in a search, a
 * message, a printed string or a heredoc is `mentioned`, and one with no result to judge by
 * is `unknown`. Checks count `ran` only.
 *
 * What an edit changed comes from the call's own input: Claude Code's `Edit`, `MultiEdit`
 * and `Write`, and Codex's `apply_patch`. Cursor records no results, so none of its calls
 * ever counts as ran; its edits are kept by path only, for the unconfirmed counts.
 *
 * Pure. No I/O.
 */

import { readShimCalls } from "../codex-transcript/scan.js";
import type { CompiledAllowlist } from "../evaluate.js";
import type { CompiledRule } from "../rules.js";
import { evaluateAction, type ScanCorpus, toolUseCalls } from "../scan-report.js";
import type { ToolResult, ToolUse } from "../transcript/transcript-types.js";
import type { AgentSource, MappedCall } from "../types.js";
import { gitSubcommandIndex, programNameOf, programStart } from "./prefix-words.js";
import {
  executedView,
  hidingFormsOf,
  isResultBackedRun,
  runVerdict,
  type SimpleCommandView,
  simpleCommandsOf,
} from "./ran.js";
import { HIDING_FORMS, type HidingForm, type RunState } from "./types.js";

/** What an edit changed in one file. */
export interface FileEdit {
  readonly path: string;
  /** The text the edit took out. Empty for a new file, a whole rewrite or a deletion. */
  readonly removed: string;
  /** The text the edit put in. Empty for a deletion. */
  readonly added: string;
  /** The file was written whole, so what it held before is not known. */
  readonly whole: boolean;
  /** The file was deleted. */
  readonly deleted: boolean;
}

/** One tool call, as the checks read it. */
export interface SessionCall {
  /** The session's index in the corpus. */
  readonly session: number;
  /** The call's place in its session, in the order the calls were made. */
  readonly order: number;
  /** The session's working directory, when its transcript names one. */
  readonly cwd: string | null;
  /** The call as the guardrails read it. */
  readonly mapped: MappedCall;
  /** Its recorded result. `undefined` when the transcript records none. */
  readonly result: ToolResult | undefined;
  /** The guardrails that matched it. */
  readonly ruleIds: readonly string[];
  /** The command, for a shell call. */
  readonly command?: string;
  /** What it changed, for an edit. */
  readonly edit?: FileEdit;
  /**
   * The hiding forms the call holds (`ran.ts` `hidingFormsOf`), plus `git-hook` for a git
   * command that runs hooks after an earlier call in the session wrote a hook file or set
   * `core.hooksPath`.
   */
  readonly hidingForms: readonly HidingForm[];
}

/** Every call in a corpus, and whose sessions they are. */
export interface CorpusCalls {
  readonly agent: AgentSource;
  readonly calls: readonly SessionCall[];
}

/** The tools whose command is POSIX shell text, as every reader maps a shell call. */
const SHELL_TOOL = "Bash";

/** A JSON object that is not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `value` when it is a string, otherwise `""`. */
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The edits in one Claude Code tool use: `Edit`, `MultiEdit`, `Write`. */
function claudeEdits(use: ToolUse): FileEdit[] {
  const input = use.input;
  const path = text(input.file_path);
  if (path === "") return [];
  switch (use.name) {
    case "Edit":
      return [
        {
          path,
          removed: text(input.old_string),
          added: text(input.new_string),
          whole: false,
          deleted: false,
        },
      ];
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      const removed: string[] = [];
      const added: string[] = [];
      for (const edit of edits) {
        if (!isRecord(edit)) continue;
        removed.push(text(edit.old_string));
        added.push(text(edit.new_string));
      }
      return [
        {
          path,
          removed: removed.join("\n"),
          added: added.join("\n"),
          whole: false,
          deleted: false,
        },
      ];
    }
    case "Write":
      return [{ path, removed: "", added: text(input.content), whole: true, deleted: false }];
    default:
      return [];
  }
}

/** One file's part of an `apply_patch`, while it is read. */
interface PatchFile {
  readonly path: string;
  readonly mode: "update" | "add" | "delete";
  readonly removed: string[];
  readonly added: string[];
}

/**
 * The edits in one Codex `apply_patch` text.
 *
 * `*** Update File:` sections give their `-` lines as removed and their `+` lines as added;
 * `*** Add File:` is a new file written whole; `*** Delete File:` is a deletion. A marker is
 * read only at the start of a line, so file content cannot spell one.
 */
export function patchEdits(patch: string): FileEdit[] {
  const files: PatchFile[] = [];
  let current: PatchFile | undefined;
  for (const raw of patch.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const marker = /^\*\*\* (Update|Add|Delete) File: (.*)$/.exec(line);
    if (marker !== null) {
      const path = (marker[2] ?? "").trim();
      const mode = marker[1] === "Update" ? "update" : marker[1] === "Add" ? "add" : "delete";
      current = path === "" ? undefined : { path, mode, removed: [], added: [] };
      if (current !== undefined) files.push(current);
      continue;
    }
    if (line.startsWith("***")) {
      // `*** Move to:`, `*** End Patch`, `*** End of File`: no content.
      if (line.startsWith("*** End Patch")) current = undefined;
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith("+")) current.added.push(line.slice(1));
    else if (line.startsWith("-")) current.removed.push(line.slice(1));
  }
  return files.map((file) => ({
    path: file.path,
    removed: file.removed.join("\n"),
    added: file.added.join("\n"),
    whole: file.mode === "add",
    deleted: file.mode === "delete",
  }));
}

/** The path a non-shell call names, as the guardrails read it. */
function mappedPath(mapped: MappedCall): string {
  return mapped.args.file_path ?? "";
}

/** The tools a Cursor session file records as edits, as its reader maps them. */
const CURSOR_EDIT_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "Delete"]);

/**
 * Every tool call in a corpus that the guardrails evaluate as an action: shell calls and
 * edits, with what they matched. A Claude Code tool-use id seen twice in one session (a main
 * transcript and a sub-agent file that both carry it) is read once, as `scan` reads it.
 */
export function readCalls(
  corpus: ScanCorpus,
  catalog: readonly CompiledRule[],
  allowlist: CompiledAllowlist,
): CorpusCalls {
  const agent: AgentSource = corpus.agent ?? "claude";
  const calls: SessionCall[] = [];

  for (const [index, session] of corpus.sessions.entries()) {
    const seen = new Set<string>();
    let order = 0;
    // A hook file written by a call that ran, or may have run, earlier in this session.
    let hookWritten = false;
    const add = (call: SessionCall): void => {
      calls.push(call);
      if (!hookWritten && writesHook(call) && ranOrMayHaveRun(agent, call)) hookWritten = true;
    };
    for (const turn of session.turns) {
      for (const use of turn.toolUses) {
        if (agent === "claude" && use.toolUseId !== "") {
          if (seen.has(use.toolUseId)) continue;
          seen.add(use.toolUseId);
        }
        const result = session.toolResults.get(use.toolUseId);
        const mappedCalls = toolUseCalls(agent, use);
        // Codex: the shim calls line up one for one with what `toolUseCalls` returned.
        const shim =
          agent === "codex" && typeof use.input.input === "string"
            ? readShimCalls(use.input.input)
            : undefined;

        for (const [k, call] of mappedCalls.entries()) {
          if (call.kind !== "action") continue;
          const { mapped, decision } = evaluateAction(catalog, allowlist, call.candidates);
          const base = {
            session: index,
            order: order++,
            cwd: session.cwd,
            mapped,
            result,
            ruleIds: decision.matches.map((m) => m.ruleId),
            hidingForms: hidingFormsOf(mapped),
          };
          if (mapped.tool === SHELL_TOOL && mapped.args.full_command !== undefined) {
            const command = mapped.args.full_command;
            const forms = base.hidingForms;
            const hooked = hookWritten && runsGitHooks(command);
            add({
              ...base,
              command,
              hidingForms: hooked
                ? HIDING_FORMS.filter((f) => f === "git-hook" || forms.includes(f))
                : forms,
            });
            continue;
          }
          let edits: FileEdit[] = [];
          if (agent === "claude") edits = claudeEdits(use);
          else if (agent === "codex") {
            const shimCall = shim?.[k];
            if (shimCall?.fn === "apply_patch" && shimCall.text !== undefined) {
              edits = patchEdits(shimCall.text);
            }
          } else if (CURSOR_EDIT_TOOLS.has(mapped.tool) && mappedPath(mapped) !== "") {
            edits = [
              {
                path: mappedPath(mapped),
                removed: "",
                added: "",
                whole: mapped.tool !== "Delete",
                deleted: mapped.tool === "Delete",
              },
            ];
          }
          if (edits.length === 0) {
            add(base);
            continue;
          }
          // One `apply_patch` can edit several files; each is its own edit, at one place
          // in the session.
          for (const edit of edits) add({ ...base, edit });
        }
      }
    }
  }
  return { agent, calls };
}

/**
 * Whether `call` ran, judged by `ran.ts` with `holds` as the check's own test.
 *
 * For a shell call, `holds` is asked of the command and of the command with every region that
 * is only data blanked out (`executedView`); when it holds only for the first, the call is
 * `mentioned`. An edit has no such regions: it ran when its result says it did.
 *
 * Only a run a recorded result backs is `ran` here (`isResultBackedRun`). A call that ran but
 * whose matched text may only sit in a file it wrote and then ran is `unknown`: it is never
 * counted and never leads.
 */
export function runStateOf(
  agent: AgentSource,
  call: SessionCall,
  holds: (command: string) => boolean,
): RunState {
  const verdict = runVerdict(agent, call.mapped, call.result, (changed) =>
    holds(changed.args.full_command ?? ""),
  );
  return verdict.state === "ran" && !isResultBackedRun(verdict) ? "unknown" : verdict.state;
}

/** The part of a shell command that runs: the command with data regions blanked out. */
export function executedText(command: string): string {
  return executedView(command).text;
}

/**
 * A test of a shell command against some of the guardrails: does any of the rules `keep`
 * selects match `command`, as the call it came from? Evaluated as `scan` evaluates, with the
 * user's allowlist.
 */
export function rulesMatcher(
  catalog: readonly CompiledRule[],
  allowlist: CompiledAllowlist,
  keep: (rule: CompiledRule) => boolean,
): (call: SessionCall, command: string) => boolean {
  const subset = catalog.filter(keep);
  return (call, command) =>
    subset.length > 0 &&
    evaluateAction(subset, allowlist, [
      { ...call.mapped, args: { ...call.mapped.args, full_command: command } },
    ]).decision.matches.length > 0;
}

/**
 * The status a check reaches when it found nothing that ran. See `types.ts`.
 *
 * A call that could not be confirmed either way, or a call that ran, or may have run, and could
 * have run other commands the check does not read, keeps the result from reading as clean.
 */
export function quietStatus(unknown: number, couldHide = 0): "clean" | "could-not-check" {
  return unknown > 0 || couldHide > 0 ? "could-not-check" : "clean";
}

/** Git subcommands that run hooks. */
const HOOKED_GIT: ReadonlySet<string> = new Set([
  "commit",
  "merge",
  "push",
  "rebase",
  "checkout",
  "switch",
  "am",
  "cherry-pick",
  "pull",
  "revert",
]);

/** A hooks folder: git's own, husky's, or a common custom one. */
const HOOKS_PATH = /(?:^|[\\/])(?:\.git[\\/]hooks|\.husky|\.githooks)(?:[\\/]|$)/;

/** Does a shell command run git in a way that runs hooks? */
function runsGitHooks(command: string): boolean {
  return simpleCommands(executedText(command)).some((simple) => {
    const { program, args } = programAndArgs(simple);
    return program === "git" && HOOKED_GIT.has(args[gitSubcommandIndex(args)] ?? "");
  });
}

/** Does a call write a hook file: an edit of one, or a command that names one and writes? */
function writesHook(call: SessionCall): boolean {
  if (call.edit !== undefined) return HOOKS_PATH.test(call.edit.path) && !call.edit.deleted;
  if (call.command === undefined) return false;
  const text = executedText(call.command);
  return (
    (HOOKS_PATH.test(text) && /(?:>|\btee\b|\bcp\b|\bmv\b|\bln\b|\bchmod\b)/.test(text)) ||
    /\bgit\b[^;&|\n]*\bconfig\b[^;&|\n]*\bcore\.hooksPath\b/.test(text)
  );
}

/**
 * Did a call run, or may it have run? Every call did but one that was only mentioned, or one
 * whose recorded result says it was refused or blocked (`error-result`). A call with no
 * recorded result, or from an app that records none (Cursor), may have run. Used where a call
 * that may have run must keep a check from reading clean: hiding forms, and hook files written.
 */
function ranOrMayHaveRun(agent: AgentSource, call: SessionCall): boolean {
  const verdict = runVerdict(agent, call.mapped, call.result, () => true);
  return verdict.state !== "mentioned" && verdict.why !== "error-result";
}

/** What the calls that ran, or may have run, could have hidden, per corpus. */
interface Hidden {
  readonly count: number;
  readonly forms: readonly HidingForm[];
}

/**
 * Calls that ran, or may have run, and could have run other commands the checks do not read,
 * per corpus.
 */
const HIDDEN = new WeakMap<CorpusCalls, Hidden>();

/** The calls that ran, or may have run, holding a hiding form: how many, and which forms. */
function hidden(corpus: CorpusCalls): Hidden {
  const known = HIDDEN.get(corpus);
  if (known !== undefined) return known;
  let count = 0;
  const forms = new Set<HidingForm>();
  for (const call of corpus.calls) {
    if (call.hidingForms.length === 0) continue;
    if (!ranOrMayHaveRun(corpus.agent, call)) continue;
    count += 1;
    for (const form of call.hidingForms) forms.add(form);
  }
  const out = { count, forms: HIDING_FORMS.filter((f) => forms.has(f)) };
  HIDDEN.set(corpus, out);
  return out;
}

/**
 * How many calls ran, or may have run, and hold a hiding form (`SessionCall.hidingForms`).
 * Every command check reports it, and none reads clean while it is above zero. A call with no
 * recorded result counts: only one that was only mentioned, or refused or blocked, does not.
 */
export function couldHideCount(corpus: CorpusCalls): number {
  return hidden(corpus).count;
}

/**
 * The hiding forms held by calls that ran, in `HIDING_FORMS` order: each command check's
 * `hidingForms` fact, the shared key the report reads to say it could not confirm.
 */
export function heldHidingForms(corpus: CorpusCalls): readonly HidingForm[] {
  return hidden(corpus).forms;
}

/** The file name at the end of a path, either separator. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * One simple command of a shell text, as the shared reading splits it (`ran.ts`): its words
 * with quotes and escapes removed, the files its output redirects write, and where its
 * standard input comes from.
 */
export type SimpleCommand = SimpleCommandView;

/**
 * The simple commands of a shell text, split by the same quote-aware reading that decides what
 * ran. A `;`, `&`, `|` or line break inside quotes, a substitution, a heredoc or a comment does
 * not split, so a quoted URL holding `&` stays one word. Every reader here takes a command
 * apart through this one split.
 */
export function simpleCommands(command: string): readonly SimpleCommand[] {
  return simpleCommandsOf(command);
}

/**
 * A simple command's program, lower-cased and without its folder, the words after it, and the
 * variable assignments before it (`HTTPS_PROXY=… curl`, `env X=1 make`). The prefix words and
 * their options are the shared table's (`prefix-words.ts`).
 */
export function programAndArgs(simple: SimpleCommand): {
  program: string;
  args: string[];
  assignments: string[];
} {
  const list = simple.words;
  const { index: k, assignments } = programStart(list);
  return {
    program: programNameOf(list[k] ?? ""),
    args: list.slice(k + 1),
    assignments: assignments.map((i) => list[i] as string),
  };
}

/** Is it an edit? */
export function isEdit(call: SessionCall): call is SessionCall & { readonly edit: FileEdit } {
  return call.edit !== undefined;
}

/** Is it a shell call? */
export function isShell(call: SessionCall): call is SessionCall & { readonly command: string } {
  return call.command !== undefined;
}
