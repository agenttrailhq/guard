// cspell:words hookspath mustn shouldn cursorrules pathspec urlmatch windsurfrules
/**
 * Skipped safety checks: what the agent ran that skipped a repository's hooks, and what on this
 * machine still tells it to.
 *
 *  - `git commit --no-verify` (or `-n`) that ran. The commit ids come from the `[branch id]`
 *    line the commit printed. For each, the repository must have a commit hook now, or nothing
 *    was skipped; then the commit is looked up, and checked against origin/main and
 *    origin/master. A commit on one of them reached main without its checks.
 *  - Other commands that ran with `--no-verify`: a push, a merge, a rebase.
 *  - `HUSKY=0` on one command: Husky's hooks skipped for that command only.
 *  - `git config core.hooksPath …` or `--unset core.hooksPath` that ran.
 *  - Hooks now, as opposed to skipped for one command: in every repository where a check was
 *    skipped or `core.hooksPath` changed, are hooks switched off now — `core.hooksPath` points
 *    at a folder that holds no hook — or on, or never set up?
 *  - Instruction and memory files that tell the agent to skip checks: the ones the agent wrote,
 *    the standard ones at the top of each repository the sessions ran in, and the agent's own
 *    home instruction file. Each is read now.
 *
 * Only what ran counts. A match whose text only sat in a message, a search or printed text is
 * counted as mentioned, and a call with no result to judge by as unknown.
 *
 * What leaves this module is counts. The exact commands for this machine — real commit ids and
 * paths — are `LocalFix`es, for the local fixes file only.
 */

import { dirname, join } from "node:path";
import {
  type CardContext,
  type CardView,
  type FixShape,
  type LocalFix,
  type SentenceTemplate,
  sentence,
  sentences,
  type ToCard,
} from "./cards.js";
import {
  addTallies,
  callsIn,
  cardExtras,
  codexCaveat,
  counted,
  type GitCheckContext,
  is,
  MAX_PROBED_ITEMS,
  pushFix,
  statusOf,
  was,
} from "./git-copy.js";
import { CHECK_HOOKS, COMMIT_HOOKS, isFailure } from "./repo-probe.js";
import {
  type Detector,
  gitFolder,
  type Judged,
  judgeAll,
  outputOf,
  tallyOf,
  walkCommands,
} from "./shell-calls.js";
import { commandStart, gitCommand, operands, programName, type ShellWord } from "./shell-words.js";
import type { CheckedCategory, RunTally } from "./types.js";

/** The `--no-verify` commits, and where they are now. */
export interface NoVerifyFacts {
  /** `git commit --no-verify` calls, by whether they ran. */
  readonly calls: RunTally;
  /** Commit ids read from the output of the calls that ran. */
  readonly commits: number;
  /** Calls that ran with no commit id in their recorded output. */
  readonly notIdentified: number;
  /** Commits in a repository with no commit hook now: nothing was skipped. */
  readonly withoutHooks: number;
  /** Commits in a repository with a commit hook, on origin/main or origin/master now. */
  readonly onMain: number;
  /** Commits in a repository with a commit hook, on neither. */
  readonly offMain: number;
  /** Commits in a repository with a commit hook and neither origin/main nor origin/master. */
  readonly noMainToCheck: number;
  /** Commits in a repository with a commit hook that are no longer in it. */
  readonly gone: number;
  /** Commits whose repository could not be asked. */
  readonly couldNotCheck: number;
}

/**
 * Changes to `core.hooksPath`, and the hooks now in every repository where a check was skipped
 * or `core.hooksPath` changed. Each repository is counted once.
 */
export interface HooksPathFacts {
  /** `git config core.hooksPath …` and its unset, by whether they ran. */
  readonly calls: RunTally;
  /** Switched off: `core.hooksPath` points at a folder that holds no hook. */
  readonly off: number;
  /** A hook is in the folder in effect. */
  readonly on: number;
  /** No `core.hooksPath` and no hook: the repository has none set up. */
  readonly none: number;
  readonly couldNotCheck: number;
}

/** Instruction and memory files that tell the agent to skip checks. */
export interface InstructionFacts {
  /** Files read now. */
  readonly read: number;
  /** Files that tell the agent to skip checks now. */
  readonly sayToSkip: number;
  /**
   * Files the agent wrote an instruction to skip checks into, in these sessions. Only Claude
   * Code records both what an edit wrote and that it ran: Codex keeps no per-file text, so its
   * edited files are read now but not counted here, and Cursor records no results, so none of
   * its edits counts as having run.
   */
  readonly agentWrote: number;
  /** Of those, files that still say so. */
  readonly agentWroteStill: number;
  /** Of those, files that no longer say so. */
  readonly agentWroteRemoved: number;
  /** Files named that could not be read. */
  readonly couldNotRead: number;
}

/** What the skipped-checks check found. Counts only. */
export interface SkippedChecksFacts {
  readonly noVerify: NoVerifyFacts;
  /** Other commands with `--no-verify`: a push, a merge, a rebase. */
  readonly otherNoVerify: RunTally;
  /** Commands run with Husky turned off for that command only. */
  readonly husky: RunTally;
  /** `core.hooksPath` changes, and hooks now where checks were skipped. */
  readonly hooksPath: HooksPathFacts;
  readonly instructions: InstructionFacts;
}

declare module "./types.js" {
  interface CategoryFactsMap {
    "skipped-checks": SkippedChecksFacts;
  }
}

/** The skipped-checks result. */
export type SkippedChecksCheck = CheckedCategory<SkippedChecksFacts>;

// ── Reading commands ─────────────────────────────────────────────────────────

/** A `git` command found in a call, and the folder it ran on. */
interface GitFound {
  readonly folder: string | undefined;
}

/** `git commit` options that take the next word as their value. */
const COMMIT_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-m",
  "--message",
  "-F",
  "--file",
  "-C",
  "--reuse-message",
  "-c",
  "--reedit-message",
  "-t",
  "--template",
  "--author",
  "--date",
  "--fixup",
  "--squash",
  "--cleanup",
  "--trailer",
  "--pathspec-from-file",
]);

/** Short `git commit` options whose value follows them. */
const COMMIT_VALUE_LETTERS = "mFCct";

/**
 * Does a `git commit` skip its hooks? `--no-verify`, or `-n` alone or in a cluster such as
 * `-nm`.
 *
 * An option's value is skipped, except an unquoted word that starts with `-`: the text this
 * reads may have the value itself blanked out as a message, which leaves the option bare.
 */
export function commitSkipsHooks(args: readonly ShellWord[]): boolean {
  let k = 0;
  while (k < args.length) {
    const value = (args[k] as ShellWord).value;
    if (value === "--") return false;
    if (value === "--no-verify") return true;
    let takesNext = false;
    if (value.startsWith("--")) takesNext = COMMIT_VALUE_OPTIONS.has(value);
    else if (value.startsWith("-") && value !== "-") {
      for (let c = 1; c < value.length; c++) {
        const letter = value[c] as string;
        if (letter === "n") return true;
        if (COMMIT_VALUE_LETTERS.includes(letter)) {
          takesNext = c === value.length - 1;
          break;
        }
        if (letter === "S" || letter === "u") break;
      }
    }
    const next = args[k + 1];
    const bareOption = next !== undefined && next.raw === next.value && next.value.startsWith("-");
    k += takesNext && next !== undefined && !bareOption ? 2 : 1;
  }
  return false;
}

/** Every `git commit` in a text, with the folder it ran on and whether it skipped hooks. */
function commits(
  text: string,
  cwd: string | undefined,
  home: string,
): { folder: string | undefined; skips: boolean }[] {
  const out: { folder: string | undefined; skips: boolean }[] = [];
  walkCommands(text, cwd, home, (command, folder) => {
    const git = gitCommand(command.words);
    if (git === undefined || git.sub !== "commit") return;
    out.push({
      folder: git.elsewhere ? undefined : gitFolder(folder, git.folders, home),
      skips: commitSkipsHooks(git.args),
    });
  });
  return out;
}

/** `git commit --no-verify`. */
const noVerifyCommits: Detector<GitFound> = (text, cwd, home) =>
  commits(text, cwd, home).filter((c) => c.skips);

/** Any other `git` command given `--no-verify`. */
const otherNoVerify: Detector<GitFound> = (text, cwd, home) => {
  const out: GitFound[] = [];
  walkCommands(text, cwd, home, (command, folder) => {
    const git = gitCommand(command.words);
    if (git === undefined || git.sub === "commit") return;
    if (git.args.some((a) => a.value === "--no-verify" && a.raw === a.value)) {
      out.push({ folder: git.elsewhere ? undefined : gitFolder(folder, git.folders, home) });
    }
  });
  return out;
};

/** Is an assignment one that turns Husky's hooks off? */
function huskyOff(word: ShellWord): boolean {
  const match = /^(HUSKY|HUSKY_SKIP_HOOKS)=(.*)$/.exec(word.value);
  if (match === null) return false;
  const value = (match[2] as string).toLowerCase();
  return match[1] === "HUSKY"
    ? value === "0" || value === "false"
    : value === "1" || value === "true";
}

/** A command run with `HUSKY=0`, `env HUSKY=0` or after `export HUSKY=0`, and its folder. */
const huskyCommands: Detector<GitFound> = (text, cwd, home) => {
  const out: GitFound[] = [];
  walkCommands(text, cwd, home, (command, folder) => {
    const start = commandStart(command.words);
    const program = command.words[start.index];
    const exported =
      program !== undefined &&
      programName(program) === "export" &&
      command.words.slice(start.index + 1).some(huskyOff);
    if (!start.assignments.some(huskyOff) && !exported) return;
    const git = gitCommand(command.words);
    out.push({
      folder:
        git === undefined
          ? folder
          : git.elsewhere
            ? undefined
            : gitFolder(folder, git.folders, home),
    });
  });
  return out;
};

/** `git config` options that take the next word as their value. */
const CONFIG_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-f",
  "--file",
  "--blob",
  "--type",
  "--default",
  "--comment",
  "--value",
]);

/** `git config` options and verbs that read, not write. */
const CONFIG_READS: ReadonlySet<string> = new Set([
  "--get",
  "--get-all",
  "--get-regexp",
  "--get-urlmatch",
  "-l",
  "--list",
  "get",
  "list",
]);

/** `git config core.hooksPath <path>`, or its `--unset`. */
const hooksPathChanges: Detector<GitFound> = (text, cwd, home) => {
  const out: GitFound[] = [];
  walkCommands(text, cwd, home, (command, folder) => {
    const git = gitCommand(command.words);
    if (git === undefined || git.sub !== "config") return;
    if (git.args.some((a) => CONFIG_READS.has(a.value))) return;
    const rest = operands(git.args, CONFIG_VALUE_OPTIONS);
    const verb = rest[0]?.value;
    const named = verb === "set" || verb === "unset" ? rest.slice(1) : rest;
    if (named[0]?.value.toLowerCase() !== "core.hookspath") return;
    const unset =
      verb === "unset" || git.args.some((a) => a.value === "--unset" || a.value === "--unset-all");
    if (!unset && named.length < 2) return;
    out.push({ folder: git.elsewhere ? undefined : gitFolder(folder, git.folders, home) });
  });
  return out;
};

// ── Instruction files ────────────────────────────────────────────────────────

/** Instruction and memory files, by name. */
const INSTRUCTION_NAMES: ReadonlySet<string> = new Set([
  "claude.md",
  "claude.local.md",
  "agents.md",
  "agent.md",
  "gemini.md",
  ".cursorrules",
  ".windsurfrules",
  "copilot-instructions.md",
  "memory.md",
]);

/** The standard instruction files looked for at the top of a repository. */
const REPO_INSTRUCTION_FILES: readonly string[] = [
  "CLAUDE.md",
  "CLAUDE.local.md",
  "AGENTS.md",
  "GEMINI.md",
  ".cursorrules",
  ".windsurfrules",
  ".github/copilot-instructions.md",
];

/**
 * Is `path` an agent's instruction or memory file? A file by one of the standard names, or a
 * Markdown file in an agent's own folder (`.claude`, `.codex`, `.cursor`).
 */
export function isInstructionFile(path: string): boolean {
  const parts = path.split(/[\\/]/);
  const base = (parts[parts.length - 1] ?? "").toLowerCase();
  if (INSTRUCTION_NAMES.has(base)) return true;
  return (
    /\.mdc?$/.test(base) &&
    parts.some((part) => part === ".claude" || part === ".codex" || part === ".cursor")
  );
}

/** Verbs that tell the agent to skip something. */
const SKIP_VERB = String.raw`(?:skip|skipping|bypass|bypassing|disable|disabling|ignore|ignoring|turn\s+off)`;

/** What a skip verb is aimed at, for it to be about checks. */
const SKIP_OBJECT = String.raw`(?:the\s+|all\s+|any\s+)?(?:git\s+|pre-commit\s+|pre-push\s+|commit\s+|husky\s+|lint\s+|ci\s+)?(?:hooks?|checks?|pre-commit|pre-push|husky|linting|lint)`;

/** A line that tells the agent to skip checks, before negation is ruled out. */
const SKIP_LINE = new RegExp(
  String.raw`--no-verify\b|\bHUSKY(?:_SKIP_HOOKS)?=|\bSKIP=[A-Za-z]|core\.hooksPath\b[^\n]{0,24}?(?:/dev/null|''|"")|\b${SKIP_VERB}\s+${SKIP_OBJECT}\b`,
  "i",
);

/** A line that tells the agent NOT to skip: "never use --no-verify", "don't skip hooks". */
const NEGATED =
  /\b(?:never|don'?t|do\s+not|does\s+not|must\s+not|mustn'?t|should\s+not|shouldn'?t|can'?t|cannot|avoid|forbidden|not\s+allowed|no\s+longer|refuse|instead\s+of|rather\s+than)\b/i;

/**
 * Does `text` tell an agent to skip checks? A line that names a way to skip them —
 * `--no-verify`, `HUSKY=0`, pre-commit's `SKIP=`, hooks pointed at `/dev/null`, "skip the
 * hooks" — and does not say never to.
 */
export function tellsToSkip(text: string): boolean {
  return text.split(/\r?\n/).some((line) => SKIP_LINE.test(line) && !NEGATED.test(line));
}

/** The command that shows the lines of a file that say to skip checks. */
const SKIP_GREP = "grep -n -i -E 'no-verify|HUSKY|SKIP=|hooks'";

/** The same command, as the parts of an exact fix command. */
const SKIP_GREP_PARTS: readonly string[] = [
  "grep",
  "-n",
  "-i",
  "-E",
  "no-verify|HUSKY|SKIP=|hooks",
];

// ── The check ────────────────────────────────────────────────────────────────

/** What the skipped-checks check produced: its result, and the exact local commands. */
export interface SkippedChecksOutcome {
  readonly result: SkippedChecksCheck;
  readonly localFixes: readonly LocalFix[];
}

/** A `--no-verify` commit to look up: its repository folder and printed id. */
interface CommitToCheck {
  readonly folder: string;
  readonly id: string;
}

/** A commit line: `[main 1a2b3c4] message`, `[main (root-commit) 1a2b3c4] message`. */
const COMMIT_LINE = /^\[[^\]\n]*? ([0-9a-f]{7,64})\] /gm;

/** The ids of the `--no-verify` commits in the calls that ran, and the calls with none. */
function noVerifyIds(
  context: GitCheckContext,
  judged: readonly Judged<GitFound>[],
): { toCheck: CommitToCheck[]; notIdentified: number; noFolder: number } {
  const toCheck: CommitToCheck[] = [];
  let notIdentified = 0;
  let noFolder = 0;
  for (const j of judged) {
    if (j.found.length === 0) continue;
    const all = commits(j.call.view, j.call.cwd, context.log.home);
    const folders = new Set(j.found.map((f) => f.folder));
    const [folder] = [...folders];
    const ids = [...outputOf(j.call).matchAll(COMMIT_LINE)].map((m) => m[1] as string);
    // The ids can be put to the right commit only when every commit in the call skipped its
    // hooks, in one folder.
    if (all.length !== j.found.length || folders.size !== 1 || ids.length === 0) {
      notIdentified += 1;
      continue;
    }
    if (folder === undefined) {
      noFolder += ids.length;
      continue;
    }
    for (const id of ids) toCheck.push({ folder, id });
  }
  return { toCheck, notIdentified, noFolder };
}

/** Look up each `--no-verify` commit. */
async function checkCommits(
  context: GitCheckContext,
  judged: readonly Judged<GitFound>[],
  fixes: LocalFix[],
): Promise<NoVerifyFacts> {
  const { toCheck, notIdentified, noFolder } = noVerifyIds(context, judged);
  const probe = context.probe;
  let withoutHooks = 0;
  let onMain = 0;
  let offMain = 0;
  let noMainToCheck = 0;
  let gone = 0;
  let couldNotCheck = noFolder;
  const seen = new Set<string>();

  for (const [index, item] of toCheck.entries()) {
    if (index >= MAX_PROBED_ITEMS) {
      couldNotCheck += 1;
      continue;
    }
    const root = await probe.toplevel(item.folder);
    if (isFailure(root)) {
      couldNotCheck += 1;
      continue;
    }
    const key = `${root}\0${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const hooks = await probe.hasHooks(root, COMMIT_HOOKS);
    if (isFailure(hooks)) {
      couldNotCheck += 1;
      continue;
    }
    if (!hooks) {
      withoutHooks += 1;
      continue;
    }
    const full = await probe.commit(root, item.id);
    if (isFailure(full)) {
      couldNotCheck += 1;
      continue;
    }
    if (full === null) {
      gone += 1;
      continue;
    }
    const defaults = await probe.defaultRefs(root);
    if (isFailure(defaults)) {
      couldNotCheck += 1;
      continue;
    }
    if (defaults.length === 0) {
      noMainToCheck += 1;
      continue;
    }
    const reached = await probe.onDefaultBranch(root, full);
    if (isFailure(reached)) {
      couldNotCheck += 1;
      continue;
    }
    if (reached) onMain += 1;
    else offMain += 1;
    pushFix(fixes, "skipped-checks", ["git", "-C", { ref: root }, "show", "--stat", { sha: full }]);
  }

  return {
    calls: tallyOf(judged),
    commits: toCheck.length,
    notIdentified,
    withoutHooks,
    onMain,
    offMain,
    noMainToCheck,
    gone,
    couldNotCheck,
  };
}

/**
 * The hooks now, in every repository where a check was skipped or `core.hooksPath` changed by
 * a call that ran: switched off, on, or never set up. A folder that could not be told, or a
 * repository that could not be asked, is could-not-check.
 */
async function checkHooksNow(
  context: GitCheckContext,
  changes: readonly Judged<GitFound>[],
  skips: readonly (readonly Judged<GitFound>[])[],
  fixes: LocalFix[],
): Promise<HooksPathFacts> {
  const folders = new Set<string>();
  let couldNotCheck = 0;
  for (const j of [changes, ...skips].flat()) {
    for (const found of j.found) {
      if (found.folder === undefined) couldNotCheck += 1;
      else folders.add(found.folder);
    }
  }
  const roots = new Set<string>();
  for (const folder of [...folders].slice(0, MAX_PROBED_ITEMS)) {
    const root = await context.probe.toplevel(folder);
    if (isFailure(root)) couldNotCheck += 1;
    else roots.add(root);
  }
  couldNotCheck += Math.max(0, folders.size - MAX_PROBED_ITEMS);
  let off = 0;
  let on = 0;
  let none = 0;
  for (const root of roots) {
    const state = await context.probe.hooksState(root, CHECK_HOOKS);
    if (isFailure(state)) couldNotCheck += 1;
    else if (state === "on") on += 1;
    else if (state === "none") none += 1;
    else {
      off += 1;
      pushFix(fixes, "skipped-checks", [
        "git",
        "-C",
        { ref: root },
        "config",
        "--unset",
        "core.hooksPath",
      ]);
    }
  }
  return { calls: tallyOf(changes), off, on, none, couldNotCheck };
}

/** One instruction file to read now. */
interface InstructionFile {
  /** The agent wrote an instruction to skip checks into it, in these sessions. */
  agentWrote: boolean;
  /** It is a standard file looked for, not one the sessions named: a missing one is not news. */
  readonly lookedFor: boolean;
}

/** The agent's own home instruction file, for each app. */
function homeInstructions(context: GitCheckContext): string[] {
  const home = context.log.home;
  switch (context.log.agent) {
    case "claude":
      return [join(home, ".claude", "CLAUDE.md")];
    case "codex":
      return [join(home, ".codex", "AGENTS.md")];
    default:
      return [];
  }
}

/** Read every instruction file now and say which tell the agent to skip checks. */
async function checkInstructions(
  context: GitCheckContext,
  fixes: LocalFix[],
): Promise<InstructionFacts> {
  const files = new Map<string, InstructionFile>();
  for (const write of context.log.writes) {
    if (!isInstructionFile(write.path)) continue;
    const file = files.get(write.path) ?? { agentWrote: false, lookedFor: false };
    if (write.texts.some(tellsToSkip)) file.agentWrote = true;
    files.set(write.path, file);
  }
  for (const folder of context.log.folders.slice(0, MAX_PROBED_ITEMS)) {
    const root = await context.probe.toplevel(folder);
    if (isFailure(root)) continue;
    for (const name of REPO_INSTRUCTION_FILES) {
      const path = join(root, name);
      if (!files.has(path)) files.set(path, { agentWrote: false, lookedFor: true });
    }
  }
  for (const path of homeInstructions(context)) {
    if (!files.has(path)) files.set(path, { agentWrote: false, lookedFor: true });
  }

  let read = 0;
  let sayToSkip = 0;
  let agentWrote = 0;
  let agentWroteStill = 0;
  let agentWroteRemoved = 0;
  let couldNotRead = 0;
  for (const [index, [path, file]] of [...files].entries()) {
    if (file.agentWrote) agentWrote += 1;
    if (index >= MAX_PROBED_ITEMS) {
      couldNotRead += 1;
      continue;
    }
    // A file that is not there says nothing now. One the agent wrote an instruction into has
    // had it removed with the file.
    if (!context.probe.exists(path)) {
      if (file.agentWrote) agentWroteRemoved += 1;
      continue;
    }
    // A file in a repository is read only once the seam has seen the repository's top.
    if (!file.lookedFor) await context.probe.toplevel(dirname(path));
    const text = await context.probe.read(path);
    if (!text.ok) {
      couldNotRead += 1;
      continue;
    }
    read += 1;
    const says = tellsToSkip(text.text);
    if (says) {
      sayToSkip += 1;
      pushFix(fixes, "skipped-checks", [...SKIP_GREP_PARTS, { ref: path }]);
    }
    if (file.agentWrote) {
      if (says) agentWroteStill += 1;
      else agentWroteRemoved += 1;
    }
  }
  return { read, sayToSkip, agentWrote, agentWroteStill, agentWroteRemoved, couldNotRead };
}

/** Run the skipped-checks check. Never throws: what cannot be asked is counted. */
export async function checkSkippedChecks(context: GitCheckContext): Promise<SkippedChecksOutcome> {
  const log = context.log;
  const fixes: LocalFix[] = [];
  const commitCalls = judgeAll(log, /no-verify|commit[^\n]*\s-[A-Za-z]*n/, noVerifyCommits);
  const otherCalls = judgeAll(log, /--no-verify/, otherNoVerify);
  const huskyCalls = judgeAll(log, /HUSKY/, huskyCommands);
  const configCalls = judgeAll(log, /hooksPath/i, hooksPathChanges);

  const noVerify = await checkCommits(context, commitCalls, fixes);
  const hooksPath = await checkHooksNow(
    context,
    configCalls,
    [commitCalls, otherCalls, huskyCalls],
    fixes,
  );
  const instructions = await checkInstructions(context, fixes);
  const facts: SkippedChecksFacts = {
    noVerify,
    otherNoVerify: tallyOf(otherCalls),
    husky: tallyOf(huskyCalls),
    hooksPath,
    instructions,
  };

  const calls = new Set(
    [...commitCalls, ...otherCalls, ...huskyCalls, ...configCalls].map((j) => j.call.id),
  );
  const all = addTallies(noVerify.calls, facts.otherNoVerify, facts.husky, hooksPath.calls);
  const status = statusOf({
    sessions: log.sessions,
    act: noVerify.onMain > 0 || hooksPath.off > 0 || instructions.sayToSkip > 0,
    review:
      noVerify.offMain + noVerify.noMainToCheck > 0 ||
      facts.otherNoVerify.ran > 0 ||
      facts.husky.ran > 0,
    incomplete:
      noVerify.notIdentified +
        noVerify.couldNotCheck +
        hooksPath.couldNotCheck +
        instructions.couldNotRead +
        all.unknown >
      0,
  });
  return { result: { status, matches: calls.size, facts }, localFixes: fixes };
}

// ── The card ─────────────────────────────────────────────────────────────────

type T = SentenceTemplate<SkippedChecksFacts>;

/** Every `--no-verify` commit in a repository with a commit hook. */
function withHooks(f: SkippedChecksFacts): number {
  const n = f.noVerify;
  return n.onMain + n.offMain + n.noMainToCheck + n.gone;
}

/** Every call the card counts, by state. */
function allCalls(f: SkippedChecksFacts): RunTally {
  return addTallies(f.noVerify.calls, f.otherNoVerify, f.husky, f.hooksPath.calls);
}

const HEADLINE: T = {
  id: "skipped-checks.headline",
  render: (f) =>
    f.noVerify.onMain > 0
      ? `${counted(f.noVerify.onMain, "commit")} reached main without ${f.noVerify.onMain === 1 ? "its" : "their"} checks.`
      : undefined,
};

const FOUND: readonly T[] = [
  {
    id: "skipped-checks.no-verify",
    render: (f) =>
      withHooks(f) > 0
        ? `${counted(withHooks(f), "commit")} ${was(withHooks(f))} made with --no-verify in a repo with commit hooks.`
        : undefined,
  },
  {
    id: "skipped-checks.no-verify-no-hooks",
    render: (f) =>
      f.noVerify.withoutHooks > 0
        ? `${counted(f.noVerify.withoutHooks, "commit")} used --no-verify in a repo with no commit hooks, so no check was skipped.`
        : undefined,
  },
  {
    id: "skipped-checks.no-verify-not-identified",
    render: (f) =>
      f.noVerify.notIdentified > 0
        ? `${counted(f.noVerify.notIdentified, "commit command")} with --no-verify ran, but the commit id is not in the recorded output, so it could not be looked up.`
        : undefined,
  },
  {
    id: "skipped-checks.other-no-verify",
    render: (f) =>
      f.otherNoVerify.ran > 0
        ? `${counted(f.otherNoVerify.ran, "push, merge or rebase", "pushes, merges or rebases")} ran with --no-verify.`
        : undefined,
  },
  {
    id: "skipped-checks.husky",
    render: (f) =>
      f.husky.ran > 0
        ? `${counted(f.husky.ran, "command")} ran with Husky's hooks turned off for that one command (HUSKY=0).`
        : undefined,
  },
  {
    id: "skipped-checks.hooks-path",
    render: (f) =>
      f.hooksPath.calls.ran > 0
        ? `${counted(f.hooksPath.calls.ran, "change")} to core.hooksPath ran, which switches hooks for every later command.`
        : undefined,
  },
  {
    id: "skipped-checks.instructions",
    render: (f) =>
      f.instructions.sayToSkip > 0
        ? `${counted(f.instructions.sayToSkip, "agent instruction or memory file")} ${f.instructions.sayToSkip === 1 ? "tells" : "tell"} the agent to skip checks.`
        : undefined,
  },
  {
    id: "skipped-checks.instructions-written",
    render: (f) =>
      f.instructions.agentWrote > 0
        ? `The agent wrote an instruction to skip checks into ${counted(f.instructions.agentWrote, "file")} itself.`
        : undefined,
  },
  {
    id: "skipped-checks.mentioned",
    render: (f) => {
      const n = allCalls(f).mentioned;
      return n > 0
        ? `${counted(n, "match", "matches")} only mentioned skipping a check, and ${n === 1 ? "is" : "are"} not counted.`
        : undefined;
    },
  },
  {
    id: "skipped-checks.unknown",
    render: (f) => {
      const n = allCalls(f).unknown;
      return n > 0 ? `${counted(n, "command")} could not be confirmed as run.` : undefined;
    },
  },
  {
    id: "skipped-checks.none",
    render: (f) => {
      if (allCalls(f).ran > 0 || f.instructions.sayToSkip > 0) return undefined;
      return f.instructions.read > 0
        ? `No command that ran skipped a hook, and none of the ${counted(f.instructions.read, "instruction file")} read says to.`
        : "No command that ran skipped a hook.";
    },
  },
];

const NOW: readonly T[] = [
  {
    id: "skipped-checks.now.on-main",
    render: (f) =>
      f.noVerify.onMain > 0
        ? `${counted(f.noVerify.onMain, "of those commits", "of those commits")} ${is(f.noVerify.onMain)} on origin/main or origin/master now.`
        : undefined,
  },
  {
    id: "skipped-checks.now.off-main",
    render: (f) =>
      f.noVerify.offMain > 0
        ? `${counted(f.noVerify.offMain, "commit")} ${is(f.noVerify.offMain)} not on origin/main or origin/master.`
        : undefined,
  },
  {
    id: "skipped-checks.now.no-main",
    render: (f) =>
      f.noVerify.noMainToCheck > 0
        ? `${counted(f.noVerify.noMainToCheck, "commit")} ${is(f.noVerify.noMainToCheck)} in a repo with no origin/main or origin/master to check against.`
        : undefined,
  },
  {
    id: "skipped-checks.now.gone",
    render: (f) =>
      f.noVerify.gone > 0
        ? `${counted(f.noVerify.gone, "commit")} ${is(f.noVerify.gone)} no longer in the repo.`
        : undefined,
  },
  {
    id: "skipped-checks.now.hooks-off",
    render: (f) =>
      f.hooksPath.off > 0
        ? `Hooks are switched off now in ${counted(f.hooksPath.off, "repo")} where a check was skipped: core.hooksPath points at a folder with no hook.`
        : undefined,
  },
  {
    id: "skipped-checks.now.hooks-on",
    render: (f) =>
      f.hooksPath.on > 0
        ? `Hooks are on now in ${counted(f.hooksPath.on, "repo")} where a check was skipped.`
        : undefined,
  },
  {
    id: "skipped-checks.now.instructions-still",
    render: (f) =>
      f.instructions.agentWroteStill > 0
        ? `${counted(f.instructions.agentWroteStill, "file")} still ${f.instructions.agentWroteStill === 1 ? "holds" : "hold"} the instruction the agent wrote.`
        : undefined,
  },
  {
    id: "skipped-checks.now.instructions-removed",
    render: (f) =>
      f.instructions.agentWroteRemoved > 0
        ? `The instruction the agent wrote is gone from ${counted(f.instructions.agentWroteRemoved, "file")}.`
        : undefined,
  },
  {
    id: "skipped-checks.now.could-not-check",
    render: (f) => {
      const n = f.noVerify.couldNotCheck + f.hooksPath.couldNotCheck + f.instructions.couldNotRead;
      return n > 0 ? `${counted(n, "item")} could not be checked on this machine.` : undefined;
    },
  },
];

const CHIP: T = {
  id: "skipped-checks.chip",
  render: (f) =>
    `${counted(f.noVerify.onMain, "commit")} reached main without ${f.noVerify.onMain === 1 ? "its" : "their"} checks`,
};

const FIX_STEPS: readonly T[] = [
  {
    id: "skipped-checks.fix.review-commits",
    render: (f) =>
      f.noVerify.onMain + f.noVerify.offMain > 0
        ? "Review each commit that skipped its hooks, and run your checks on it."
        : undefined,
  },
  {
    id: "skipped-checks.fix.hooks-on",
    render: (f) =>
      f.hooksPath.off > 0
        ? "Turn hooks back on where they are off. If a hook manager set core.hooksPath, run its install again."
        : undefined,
  },
  {
    id: "skipped-checks.fix.instructions",
    render: (f) =>
      f.instructions.sayToSkip > 0
        ? "Remove the instruction to skip checks from each file the local fixes file names."
        : undefined,
  },
];

/** The redacted fix shapes for what was found. */
function fixShapes(f: SkippedChecksFacts): FixShape[] {
  const out: FixShape[] = [];
  if (f.noVerify.onMain + f.noVerify.offMain > 0) out.push({ shape: "git show --stat <sha>" });
  if (f.hooksPath.off > 0) out.push({ shape: "git config --unset core.hooksPath" });
  if (f.instructions.sayToSkip > 0) out.push({ shape: `${SKIP_GREP} <path>` });
  return out;
}

/** The skipped-checks card. */
export const skippedChecksCard: ToCard<"skipped-checks"> = (
  result,
  context: CardContext,
): CardView => {
  const f = result.facts;
  const headline = sentence(HEADLINE, f);
  const extras = cardExtras(
    { count: f.noVerify.onMain, label: sentence(CHIP, f) },
    sentences(FIX_STEPS, f),
  );
  return {
    ...extras,
    category: "skipped-checks",
    tone: result.status,
    count: result.matches,
    found: sentences(FOUND, f),
    now: sentences(NOW, f),
    fixes: fixShapes(f),
    codexCaveat: codexCaveat(context, allCalls(f).ran),
    ...(headline === undefined
      ? {}
      : {
          headline: {
            basis: "commits-on-main-without-checks",
            count: f.noVerify.onMain,
            restsOnCodexRan: context.ranEvidence === "output-record",
            sentence: headline,
          },
        }),
  };
};

/** The templates, for a test that every card line comes from one. */
export const SKIPPED_CHECKS_TEMPLATES: readonly T[] = [
  HEADLINE,
  CHIP,
  ...FOUND,
  ...NOW,
  ...FIX_STEPS,
];

/** How many calls a card counts. Exported for the tests. */
export function skippedCallCount(f: SkippedChecksFacts): number {
  return callsIn(allCalls(f));
}
