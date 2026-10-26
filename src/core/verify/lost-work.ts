// cspell:words pathspec worktrees WORKTREES
/**
 * Lost work: what the agent ran that deleted work git was holding, and what of it can still be
 * brought back.
 *
 *  - Force-deleted branches (`git branch -D`, or `-d --force`). The commit id comes from the
 *    `Deleted branch <name> (was <id>)` line. The branch is recoverable by its id when the
 *    commit is still in the object store and on no branch, remote-tracking branch or tag.
 *  - Dropped stashes (`git stash drop`). The id comes from `Dropped stash@{n} (<id>)`. One is
 *    recoverable when its commit is still in the object store and not back in the stash list.
 *    `git stash clear` prints no ids, so what it removed cannot be looked up.
 *  - Discarded changes (`git checkout -- <path>`, `git checkout .`, `git checkout -f`,
 *    `git restore <path>`, `git reset --hard`, `git switch --discard-changes`, `git clean -f`).
 *    Git keeps no copy of uncommitted changes, so these are classed by where they were: the
 *    agent's own worktree or scratch copy; named files the agent had edited; or the main
 *    checkout, where someone's own changes may have gone. A whole-tree discard in the main
 *    checkout is always the last, whatever the agent edited: it throws away every change there.
 *
 * Only what ran counts. The exact recovery commands, with real branch names and ids, are
 * `LocalFix`es for the local fixes file; the card shows their redacted shapes.
 */

import { resolve, sep } from "node:path";
import {
  type CardContext,
  type CardView,
  type FixShape,
  type LocalFix,
  type SentenceTemplate,
  sentence,
  sentences,
  type ToCard,
  type UnsafeFix,
} from "./cards.js";
import {
  addTallies,
  cardExtras,
  codexCaveat,
  couldNotConfirmLine,
  counted,
  FixList,
  type GitCheckContext,
  is,
  isUnder,
  MAX_PROBED_ITEMS,
  statusOf,
  unsafeFixLine,
  was,
} from "./git-copy.js";
import { isFailure } from "./repo-probe.js";
import {
  type CallLog,
  type Detector,
  gitFolder,
  type Judged,
  judgeAll,
  outputOf,
  resolvePath,
  tallyOf,
  walkCommands,
} from "./shell-calls.js";
import { commandStart, gitCommand, operands, programName, type ShellWord } from "./shell-words.js";
import type { CheckedCategory, HidingForm, RunTally } from "./types.js";

/** Force-deleted branches. */
export interface BranchFacts {
  readonly calls: RunTally;
  /** Branches whose deletion the output of a call that ran reports, with the commit id. */
  readonly deleted: number;
  /** Calls that ran with no deleted branch in their recorded output. */
  readonly notIdentified: number;
  /** Still in the object store and on no branch or tag: recoverable by its id. */
  readonly recoverable: number;
  /** Still on another branch, remote-tracking branch or tag: nothing is lost. */
  readonly onAnotherRef: number;
  /** No longer in the object store. */
  readonly gone: number;
  readonly couldNotCheck: number;
}

/** Dropped and cleared stashes. */
export interface StashFacts {
  readonly calls: RunTally;
  /** Stashes whose drop the output of a call that ran reports, with the commit id. */
  readonly dropped: number;
  /** `git stash clear` calls that ran. They print no ids, so what they removed is not checked. */
  readonly cleared: number;
  /** `git stash drop` calls that ran with no dropped stash in their recorded output. */
  readonly notIdentified: number;
  /** Still in the object store and not in the stash list: recoverable by its id. */
  readonly recoverable: number;
  /** Back in the stash list. */
  readonly listed: number;
  /** No longer in the object store. */
  readonly gone: number;
  readonly couldNotCheck: number;
}

/** Discarded uncommitted changes, by where they were. */
export interface DiscardFacts {
  readonly calls: RunTally;
  /** Paths discarded by calls that ran. A whole-tree discard is one path. */
  readonly paths: number;
  /** In the agent's own worktree or a scratch copy. */
  readonly ownCopy: number;
  /** Named paths the agent had edited, or a named folder holding an edit of the agent's. */
  readonly agentEdited: number;
  /** In the main checkout: a named path with no agent edit on record, or a whole-tree discard. */
  readonly mainCheckout: number;
  /** Paths whose folder could not be told. */
  readonly couldNotCheck: number;
}

/** What the lost-work check found. Counts only. */
export interface LostWorkFacts {
  readonly branches: BranchFacts;
  readonly stashes: StashFacts;
  readonly discards: DiscardFacts;
  /** Exact fix commands that could not be made safe, so were left out of the local fixes file. */
  readonly unsafeFixes: number;
  /**
   * The calls that ran holding a form this reading does not take apart, and those forms. While
   * any is present the check cannot say nothing ran, so it is never `clean`.
   */
  readonly hidingCalls: number;
  readonly hidingForms: readonly HidingForm[];
}

declare module "./types.js" {
  interface CategoryFactsMap {
    "lost-work": LostWorkFacts;
  }
}

/** The lost-work result. */
export type LostWorkCheck = CheckedCategory<LostWorkFacts>;

// ── Reading commands ─────────────────────────────────────────────────────────

/** A `git` command found in a call, and the folder it ran on. */
interface GitFound {
  readonly folder: string | undefined;
}

/** The folder a `git` command found by `walkCommands` ran on. */
function folderOf(
  git: NonNullable<ReturnType<typeof gitCommand>>,
  folder: string | undefined,
  home: string,
): string | undefined {
  return git.elsewhere ? undefined : gitFolder(folder, git.folders, home);
}

/** Do the options of a `git branch` force-delete a local branch? */
export function forceDeletesBranch(args: readonly ShellWord[]): boolean {
  let del = false;
  let force = false;
  let remote = false;
  for (const word of args) {
    const value = word.value;
    if (value === "--") break;
    if (value === "--delete") del = true;
    else if (value === "--force") force = true;
    else if (value === "--remotes") remote = true;
    else if (/^-[A-Za-z]+$/.test(value)) {
      if (value.includes("D")) {
        del = true;
        force = true;
      }
      if (value.includes("d")) del = true;
      if (value.includes("f")) force = true;
      if (value.includes("r")) remote = true;
    }
  }
  return del && force && !remote;
}

/** `git branch -D`. */
const branchDeletes: Detector<GitFound> = (text, cwd, home) => {
  const out: GitFound[] = [];
  walkCommands(text, cwd, home, (command, folder) => {
    const git = gitCommand(command.words);
    if (git?.sub === "branch" && forceDeletesBranch(git.args)) {
      out.push({ folder: folderOf(git, folder, home) });
    }
  });
  return out;
};

/** `git stash drop` or `git stash clear`. */
const stashDrops: Detector<GitFound & { readonly clear: boolean }> = (text, cwd, home) => {
  const out: (GitFound & { clear: boolean })[] = [];
  walkCommands(text, cwd, home, (command, folder) => {
    const git = gitCommand(command.words);
    if (git?.sub !== "stash") return;
    const verb = git.args[0]?.value;
    if (verb === "drop" || verb === "clear") {
      out.push({ folder: folderOf(git, folder, home), clear: verb === "clear" });
    }
  });
  return out;
};

/** A discard: the folder it ran in, and the paths it discarded, or every path below. */
interface DiscardFound {
  readonly folder: string | undefined;
  readonly paths: readonly ShellWord[] | "all";
}

/** `git restore` options that take the next word as their value. */
const RESTORE_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-s", "--source"]);

/** What a `git checkout`, `git restore` or `git reset` discards, if anything. */
export function discardedPaths(
  sub: string,
  args: readonly ShellWord[],
): DiscardFound["paths"] | undefined {
  if (sub === "reset") return args.some((a) => a.value === "--hard") ? "all" : undefined;
  if (sub === "checkout") {
    const dash = args.findIndex((a) => a.value === "--");
    if (dash >= 0) {
      const paths = args.slice(dash + 1);
      if (paths.length === 0) return undefined;
      return paths.some((p) => p.value === ".") ? "all" : paths;
    }
    const rest = operands(args);
    if (rest.length === 1 && rest[0]?.value === ".") return "all";
    // `git checkout -f <branch>` switches and throws away every local change.
    return args.some((a) => a.value === "-f" || a.value === "--force") ? "all" : undefined;
  }
  if (sub === "switch") {
    const values = args.map((a) => a.value);
    return values.includes("--discard-changes") ||
      values.includes("-f") ||
      values.includes("--force")
      ? "all"
      : undefined;
  }
  if (sub === "clean") {
    // `git clean -f` deletes untracked files: the named paths, or every one below.
    if (!args.some((a) => /^-[A-Za-z]*f[A-Za-z]*$/.test(a.value) || a.value === "--force")) {
      return undefined;
    }
    if (args.some((a) => /^-[A-Za-z]*n[A-Za-z]*$/.test(a.value) || a.value === "--dry-run")) {
      return undefined;
    }
    const paths = operands(args, new Set(["-e", "--exclude"]));
    return paths.length === 0 || paths.some((p) => p.value === ".") ? "all" : paths;
  }
  if (sub === "restore") {
    const values = args.map((a) => a.value);
    const staged = values.includes("--staged") || values.includes("-S");
    const worktree = values.includes("--worktree") || values.includes("-W");
    if (staged && !worktree) return undefined;
    if (values.some((v) => v.startsWith("--pathspec-from-file"))) return "all";
    const paths = operands(args, RESTORE_VALUE_OPTIONS);
    if (paths.length === 0) return undefined;
    return paths.some((p) => p.value === ".") ? "all" : paths;
  }
  return undefined;
}

/** `git checkout -- <path>`, `git checkout .`, `git restore <path>`, `git reset --hard`. */
const discards: Detector<DiscardFound> = (text, cwd, home) => {
  const out: DiscardFound[] = [];
  walkCommands(text, cwd, home, (command, folder) => {
    const git = gitCommand(command.words);
    if (git === undefined) return;
    const paths = discardedPaths(git.sub, git.args);
    if (paths !== undefined) out.push({ folder: folderOf(git, folder, home), paths });
  });
  return out;
};

/** `git clone` options that take the next word as their value. */
const CLONE_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-b",
  "--branch",
  "-o",
  "--origin",
  "--depth",
  "--reference",
  "--separate-git-dir",
  "-c",
  "--config",
  "--template",
  "-u",
  "--upload-pack",
  "-j",
  "--jobs",
  "--filter",
  "--shallow-since",
  "--shallow-exclude",
  "--server-option",
]);

/** `git worktree add` options that take the next word as their value. */
const WORKTREE_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-b", "-B", "--reason", "--orphan"]);

/**
 * Folders the agent made its own copy in: `git worktree add <path>`, `git clone <url> [<path>]`
 * and `cp -r <from> <to>`.
 */
const copies: Detector<string> = (text, cwd, home) => {
  const out: string[] = [];
  const add = (folder: string | undefined, word: ShellWord | undefined): void => {
    if (word === undefined || word.expands) return;
    const path = resolvePath(folder, word.value, home);
    if (path !== undefined) out.push(path);
  };
  walkCommands(text, cwd, home, (command, folder) => {
    const git = gitCommand(command.words);
    if (git !== undefined) {
      const base = folderOf(git, folder, home);
      if (git.sub === "worktree" && git.args[0]?.value === "add") {
        add(base, operands(git.args.slice(1), WORKTREE_VALUE_OPTIONS)[0]);
      } else if (git.sub === "clone") {
        const [url, into] = operands(git.args, CLONE_VALUE_OPTIONS);
        if (into !== undefined) add(base, into);
        else if (url !== undefined && !url.expands) {
          const name =
            url.value
              .replace(/[\\/]+$/, "")
              .split(/[\\/:]/)
              .pop() ?? "";
          const folderName = name.replace(/\.git$/, "");
          if (folderName !== "") add(base, { raw: folderName, value: folderName, expands: false });
        }
      }
      return;
    }
    const start = commandStart(command.words).index;
    const program = command.words[start];
    if (program === undefined || programName(program) !== "cp") return;
    const args = command.words.slice(start + 1);
    const recursive = args.some(
      (a) => /^-[A-Za-z]*[rRa]/.test(a.value) || a.value === "--recursive",
    );
    const rest = operands(args);
    if (recursive && rest.length >= 2) add(folder, rest[rest.length - 1]);
  });
  return out;
};

// ── The check ────────────────────────────────────────────────────────────────

/** What the lost-work check produced: its result, and the exact local commands. */
export interface LostWorkOutcome {
  readonly result: LostWorkCheck;
  readonly localFixes: readonly LocalFix[];
  /** Fixes that could not be made safe, each with its note. Counted in the facts. */
  readonly unsafeFixes: readonly UnsafeFix[];
}

/** A deleted branch line. */
const DELETED_BRANCH = /^Deleted branch (\S+) \(was ([0-9a-f]{7,64})\)\.?\s*$/gm;

/** A dropped stash line. */
const DROPPED_STASH = /^Dropped (?:refs\/)?stash@\{\d+\} \(([0-9a-f]{7,64})\)\s*$/gm;

/** One deleted branch or dropped stash to look up. */
interface Deleted {
  readonly folder: string | undefined;
  readonly id: string;
  /** The branch's name, for the recovery command. Never leaves this module but in a `LocalFix`. */
  readonly name?: string;
}

/** The deleted items a call's output reports, when they can be put to one folder. */
function reported(
  judged: Judged<GitFound>,
  pattern: RegExp,
  read: (match: RegExpMatchArray) => Omit<Deleted, "folder">,
): Deleted[] | undefined {
  const folders = new Set(judged.found.map((f) => f.folder));
  const items = [...outputOf(judged.call).matchAll(pattern)].map(read);
  if (folders.size !== 1 || items.length === 0) return undefined;
  const [folder] = [...folders];
  return items.map((item) => ({ ...item, folder }));
}

/** Look up deleted branches. */
async function checkBranches(
  context: GitCheckContext,
  judged: readonly Judged<GitFound>[],
  fixes: FixList,
): Promise<BranchFacts> {
  const items: Deleted[] = [];
  let notIdentified = 0;
  for (const j of judged) {
    if (j.found.length === 0) continue;
    const found = reported(j, DELETED_BRANCH, (m) => ({
      name: m[1] as string,
      id: m[2] as string,
    }));
    if (found === undefined) notIdentified += 1;
    else items.push(...found);
  }
  let recoverable = 0;
  let onAnotherRef = 0;
  let gone = 0;
  let couldNotCheck = 0;
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    const looked = index < MAX_PROBED_ITEMS ? await lookUp(context, item, seen) : undefined;
    if (looked === undefined) {
      couldNotCheck += 1;
      continue;
    }
    if (looked === "seen") continue;
    if (looked === null) {
      gone += 1;
      continue;
    }
    const held = await context.probe.onAnyRef(looked.root, looked.full);
    if (isFailure(held)) couldNotCheck += 1;
    else if (held) onAnotherRef += 1;
    else {
      recoverable += 1;
      fixes.add([
        "git",
        "-C",
        { ref: looked.root },
        "branch",
        { branch: `recovered/${item.name ?? ""}` },
        { sha: looked.full },
      ]);
    }
  }
  return {
    calls: tallyOf(judged),
    deleted: items.length,
    notIdentified,
    recoverable,
    onAnotherRef,
    gone,
    couldNotCheck,
  };
}

/**
 * Find a deleted item's repository and commit: `undefined` when it cannot be asked, `"seen"`
 * when the same commit in the same repository was looked up already, `null` when the commit
 * is no longer in the object store.
 */
async function lookUp(
  context: GitCheckContext,
  item: Deleted,
  seen: Set<string>,
): Promise<{ root: string; full: string } | null | "seen" | undefined> {
  if (item.folder === undefined) return undefined;
  const root = await context.probe.toplevel(item.folder);
  if (isFailure(root)) return undefined;
  const full = await context.probe.commit(root, item.id);
  if (isFailure(full)) return undefined;
  if (full === null) return null;
  const key = `${root}\0${full}`;
  if (seen.has(key)) return "seen";
  seen.add(key);
  return { root, full };
}

/** Look up dropped stashes. */
async function checkStashes(
  context: GitCheckContext,
  judged: readonly Judged<GitFound & { readonly clear: boolean }>[],
  fixes: FixList,
): Promise<StashFacts> {
  const items: Deleted[] = [];
  let cleared = 0;
  let notIdentified = 0;
  for (const j of judged) {
    const drops = j.found.filter((f) => !f.clear);
    cleared += j.found.length - drops.length;
    if (drops.length === 0) continue;
    const found = reported({ ...j, found: drops }, DROPPED_STASH, (m) => ({ id: m[1] as string }));
    if (found === undefined) notIdentified += 1;
    else items.push(...found);
  }
  let recoverable = 0;
  let listed = 0;
  let gone = 0;
  let couldNotCheck = 0;
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    const looked = index < MAX_PROBED_ITEMS ? await lookUp(context, item, seen) : undefined;
    if (looked === undefined) {
      couldNotCheck += 1;
      continue;
    }
    if (looked === "seen") continue;
    if (looked === null) {
      gone += 1;
      continue;
    }
    const list = await context.probe.stashes(looked.root);
    if (isFailure(list)) couldNotCheck += 1;
    else if (list.has(looked.full)) listed += 1;
    else {
      recoverable += 1;
      fixes.add([
        "git",
        "-C",
        { ref: looked.root },
        "stash",
        "store",
        "-m",
        "recovered",
        { sha: looked.full },
      ]);
    }
  }
  return {
    calls: tallyOf(judged),
    dropped: items.length,
    cleared,
    notIdentified,
    recoverable,
    listed,
    gone,
    couldNotCheck,
  };
}

/** Agent folders that hold the agent's own worktrees. */
const AGENT_WORKTREES = [
  `${sep}.claude${sep}worktrees${sep}`,
  `${sep}.codex${sep}worktrees${sep}`,
  `${sep}.cursor${sep}worktrees${sep}`,
];

/** Is `path` the same as `folder`, or inside it? */
function within(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`);
}

/** Class each discarded path. Read from the transcripts alone: git keeps no copy to look up. */
async function checkDiscards(
  context: GitCheckContext,
  judged: readonly Judged<DiscardFound>[],
  own: readonly string[],
): Promise<DiscardFacts> {
  const log: CallLog = context.log;
  let paths = 0;
  let ownCopy = 0;
  let agentEdited = 0;
  let mainCheckout = 0;
  let couldNotCheck = 0;
  /** Is a folder the agent's own worktree or scratch copy? */
  const isOwn = (folder: string): boolean =>
    own.some((copy) => within(folder, copy)) ||
    isUnder(folder, context.scratchRoots) ||
    AGENT_WORKTREES.some((marker) => `${folder}${sep}`.includes(marker));
  for (const j of judged) {
    for (const found of j.found) {
      if (found.paths === "all") {
        // A whole-tree discard throws away every change in the repository, whatever the
        // agent edited, so it is the main checkout unless the repository is the agent's own.
        paths += 1;
        if (found.folder === undefined) {
          couldNotCheck += 1;
          continue;
        }
        const folder = resolve(found.folder);
        const root = await context.probe.toplevel(folder);
        if (isOwn(folder) || (!isFailure(root) && isOwn(root))) ownCopy += 1;
        else mainCheckout += 1;
        continue;
      }
      const targets = found.paths.map((p) =>
        p.expands ? undefined : resolvePath(found.folder, p.value, log.home),
      );
      for (const target of targets) {
        paths += 1;
        if (target === undefined || found.folder === undefined) {
          couldNotCheck += 1;
          continue;
        }
        if (isOwn(resolve(found.folder))) {
          ownCopy += 1;
          continue;
        }
        const edited = log.writes.some(
          (w) => within(w.path, target) && (w.session !== j.call.session || w.id < j.call.id),
        );
        if (edited) agentEdited += 1;
        else mainCheckout += 1;
      }
    }
  }
  return { calls: tallyOf(judged), paths, ownCopy, agentEdited, mainCheckout, couldNotCheck };
}

/** Run the lost-work check. Never throws: what cannot be asked is counted. */
export async function checkLostWork(context: GitCheckContext): Promise<LostWorkOutcome> {
  const log = context.log;
  const fixes = new FixList("lost-work");
  const branchCalls = judgeAll(log, /branch/, branchDeletes);
  const stashCalls = judgeAll(log, /stash/, stashDrops);
  const discardCalls = judgeAll(log, /checkout|restore|reset|switch|clean/, discards);
  const own = judgeAll(log, /worktree|clone|cp\s/, copies).flatMap((j) => j.found);

  const branches = await checkBranches(context, branchCalls, fixes);
  const stashes = await checkStashes(context, stashCalls, fixes);
  const discarded = await checkDiscards(context, discardCalls, own);
  const facts: LostWorkFacts = {
    branches,
    stashes,
    discards: discarded,
    unsafeFixes: fixes.unsafe.length,
    hidingCalls: log.hiding.calls,
    hidingForms: [...log.hiding.forms],
  };

  const calls = new Set([...branchCalls, ...stashCalls, ...discardCalls].map((j) => j.call.id));
  const all = addTallies(branches.calls, stashes.calls, discarded.calls);
  const status = statusOf({
    sessions: log.sessions,
    act: branches.recoverable + stashes.recoverable > 0,
    review: discarded.mainCheckout > 0,
    incomplete:
      branches.notIdentified +
        branches.couldNotCheck +
        stashes.notIdentified +
        stashes.cleared +
        stashes.couldNotCheck +
        discarded.couldNotCheck +
        all.unknown +
        log.hiding.calls >
      0,
  });
  return {
    result: { status, matches: calls.size, facts },
    localFixes: fixes.made,
    unsafeFixes: fixes.unsafe,
  };
}

// ── The card ─────────────────────────────────────────────────────────────────

type T = SentenceTemplate<LostWorkFacts>;

/** Every call the card counts, by state. */
function allCalls(f: LostWorkFacts): RunTally {
  return addTallies(f.branches.calls, f.stashes.calls, f.discards.calls);
}

/** Deleted branches and dropped stashes still recoverable. */
function recoverable(f: LostWorkFacts): number {
  return f.branches.recoverable + f.stashes.recoverable;
}

const HEADLINE: T = {
  id: "lost-work.headline",
  render: (f) =>
    recoverable(f) > 0
      ? `${counted(recoverable(f), "deleted branch or stash", "deleted branches or stashes")} can still be recovered.`
      : undefined,
};

const FOUND: readonly T[] = [
  {
    id: "lost-work.branches",
    render: (f) =>
      f.branches.deleted > 0
        ? `${counted(f.branches.deleted, "branch", "branches")} ${was(f.branches.deleted)} force-deleted.`
        : undefined,
  },
  {
    id: "lost-work.stashes",
    render: (f) =>
      f.stashes.dropped > 0
        ? `${counted(f.stashes.dropped, "stash", "stashes")} ${was(f.stashes.dropped)} dropped.`
        : undefined,
  },
  {
    id: "lost-work.stashes-cleared",
    render: (f) =>
      f.stashes.cleared > 0
        ? `${counted(f.stashes.cleared, "git stash clear command")} ran. It prints no ids, so what it removed could not be looked up.`
        : undefined,
  },
  {
    id: "lost-work.not-identified",
    render: (f) => {
      const n = f.branches.notIdentified + f.stashes.notIdentified;
      return n > 0
        ? `${counted(n, "branch or stash deletion", "branch or stash deletions")} ran, but the commit id is not in the recorded output, so it could not be looked up.`
        : undefined;
    },
  },
  {
    id: "lost-work.discards",
    render: (f) =>
      f.discards.paths > 0
        ? `Uncommitted changes to ${counted(f.discards.paths, "path")} were discarded with git checkout, git restore, git reset --hard, git switch or git clean.`
        : undefined,
  },
  {
    id: "lost-work.mentioned",
    render: (f) => {
      const n = allCalls(f).mentioned;
      return n > 0
        ? `${counted(n, "match", "matches")} only mentioned deleting work, and ${n === 1 ? "is" : "are"} not counted.`
        : undefined;
    },
  },
  {
    id: "lost-work.unknown",
    render: (f) => {
      const n = allCalls(f).unknown;
      return n > 0 ? `${counted(n, "command")} could not be confirmed as run.` : undefined;
    },
  },
  {
    id: "lost-work.none",
    render: (f) =>
      allCalls(f).ran === 0 && f.hidingCalls === 0
        ? "No command this check could read deleted a branch or a stash, or discarded changes."
        : undefined,
  },
  {
    id: "lost-work.could-not-confirm",
    render: (f) =>
      couldNotConfirmLine(
        f.hidingCalls,
        f.hidingForms,
        "branch, stash or change was deleted or discarded",
      ),
  },
];

const NOW: readonly T[] = [
  {
    id: "lost-work.now.unsafe-fixes",
    render: (f) => unsafeFixLine(f.unsafeFixes),
  },
  {
    id: "lost-work.now.recoverable-branches",
    render: (f) =>
      f.branches.recoverable > 0
        ? `${counted(f.branches.recoverable, "deleted branch", "deleted branches")} ${is(f.branches.recoverable)} still in the repo and on no other branch: recoverable by commit id.`
        : undefined,
  },
  {
    id: "lost-work.now.recoverable-stashes",
    render: (f) =>
      f.stashes.recoverable > 0
        ? `${counted(f.stashes.recoverable, "dropped stash", "dropped stashes")} ${is(f.stashes.recoverable)} still in the repo: recoverable by commit id.`
        : undefined,
  },
  {
    id: "lost-work.now.on-another-ref",
    render: (f) =>
      f.branches.onAnotherRef > 0
        ? `${counted(f.branches.onAnotherRef, "deleted branch", "deleted branches")} ${is(f.branches.onAnotherRef)} still on another branch or tag, so nothing is lost.`
        : undefined,
  },
  {
    id: "lost-work.now.listed",
    render: (f) =>
      f.stashes.listed > 0
        ? `${counted(f.stashes.listed, "dropped stash", "dropped stashes")} ${is(f.stashes.listed)} back in the stash list.`
        : undefined,
  },
  {
    id: "lost-work.now.gone",
    render: (f) => {
      const n = f.branches.gone + f.stashes.gone;
      return n > 0
        ? `${counted(n, "deleted branch or stash", "deleted branches or stashes")} ${is(n)} no longer in the repo.`
        : undefined;
    },
  },
  {
    id: "lost-work.now.discards-main",
    render: (f) =>
      f.discards.mainCheckout > 0
        ? `${counted(f.discards.mainCheckout, "discarded path")} ${was(f.discards.mainCheckout)} in a main checkout with no agent edit on record, so ${f.discards.mainCheckout === 1 ? "it" : "they"} may have held someone's own changes. Git keeps no copy of those.`
        : undefined,
  },
  {
    id: "lost-work.now.discards-agent",
    render: (f) =>
      f.discards.agentEdited > 0
        ? `${counted(f.discards.agentEdited, "discarded path")} held files the agent had edited.`
        : undefined,
  },
  {
    id: "lost-work.now.discards-own",
    render: (f) =>
      f.discards.ownCopy > 0
        ? `${counted(f.discards.ownCopy, "discarded path")} ${was(f.discards.ownCopy)} in the agent's own worktree or a scratch copy.`
        : undefined,
  },
  {
    id: "lost-work.now.could-not-check",
    render: (f) => {
      const n = f.branches.couldNotCheck + f.stashes.couldNotCheck + f.discards.couldNotCheck;
      return n > 0 ? `${counted(n, "item")} could not be checked on this machine.` : undefined;
    },
  },
];

const CHIP: T = {
  id: "lost-work.chip",
  render: (f) =>
    `${counted(recoverable(f), "deleted branch or stash", "deleted branches or stashes")} still recoverable`,
};

const FIX_STEPS: readonly T[] = [
  {
    id: "lost-work.fix.recover",
    render: (f) =>
      recoverable(f) > 0
        ? "Recover each one by its commit id before git cleans unreachable commits away. The exact commands are in the local fixes file."
        : undefined,
  },
  {
    id: "lost-work.fix.discards",
    render: (f) =>
      f.discards.mainCheckout > 0
        ? "Check whether the discarded paths held changes you still need. Git cannot bring them back, but an editor's local history may."
        : undefined,
  },
];

/** The redacted fix shapes for what was found. */
function fixShapes(f: LostWorkFacts): FixShape[] {
  const out: FixShape[] = [];
  if (f.branches.recoverable > 0) out.push({ shape: "git branch recovered/<name> <sha>" });
  if (f.stashes.recoverable > 0) out.push({ shape: "git stash store -m recovered <sha>" });
  return out;
}

/** The lost-work card. */
export const lostWorkCard: ToCard<"lost-work"> = (result, context: CardContext): CardView => {
  const f = result.facts;
  const headline = sentence(HEADLINE, f);
  const extras = cardExtras(
    { count: recoverable(f), label: sentence(CHIP, f) },
    sentences(FIX_STEPS, f),
  );
  return {
    ...extras,
    category: "lost-work",
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
            basis: "recoverable-deleted-work",
            count: recoverable(f),
            restsOnCodexRan: context.ranEvidence === "output-record",
            sentence: headline,
          },
        }),
  };
};

/** The templates, for a test that every card line comes from one. */
export const LOST_WORK_TEMPLATES: readonly T[] = [HEADLINE, CHIP, ...FOUND, ...NOW, ...FIX_STEPS];
