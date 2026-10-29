// cspell:words oneline refspec refspecs
/**
 * The unreviewed-code check, for the "Unreviewed code" card: commits the agent pushed straight
 * to `main` or `master`.
 *
 * A commit counts when a `git push` that RAN updated `main` or `master` on `origin`, by the
 * ref lines the push printed (`1a2b3c4..5d6e7f8  main -> main`), and `origin`'s main branch,
 * as this machine last saw it (`refs/remotes/origin/main`), still contains it. That is asked
 * with read-only `git` through `VerifyIO`, offline: nothing is fetched, so a push someone has
 * since undone on the server can still read as on main here.
 *
 *  - The commit ids come from the push's own output and fill the allow-list's `sha` slots.
 *    A push to a remote other than `origin` is not asked about, and is counted as not
 *    checked.
 *  - A `--dry-run` push pushes nothing and is skipped.
 *  - Guard's Codex reader keeps whether a call has an output record, not the output's text,
 *    so a Codex push cannot be read here and is counted as not checked, never as clean.
 *
 * What leaves this module is counts. Folders and commit ids go only into exact commands for
 * the local fixes file, built from quoted parts (`localFixCommand`).
 */

import type { CompiledAllowlist } from "../evaluate.js";
import type { CompiledRule } from "../rules.js";
import {
  backstopCalls,
  type CorpusCalls,
  executedText,
  hidingFacts,
  isShell,
  programAndArgs,
  quietStatus,
  rulesMatcher,
  runStateOf,
  type SessionCall,
  simpleCommands,
} from "./calls.js";
import { counted, type FullCard, MAX_LOCAL_FIXES, noun, restsOnCodex } from "./card-parts.js";
import {
  type CardContext,
  type LocalFix,
  localFixCommand,
  type SentenceTemplate,
  type SummaryTemplates,
  sentence,
  sentences,
  summaryOf,
  type ToCard,
  type UnsafeFix,
} from "./cards.js";
import { GIT_GLOBAL_VALUE_OPTIONS } from "./prefix-words.js";
import { READ_PROGRAMS } from "./ran.js";
import { placed, repoRoot, rootCache } from "./repos.js";
import type { CheckedCategory, HidingForm, VerifyIO, VerifyStatus } from "./types.js";

/** What the unreviewed-code check found. Every count is of pushes that ran. */
export interface UnreviewedFacts {
  /** Pushes that updated a remote's `main` or `master`, by their output. */
  readonly pushesToMain: number;
  /** Commits those pushes carried that the remote's main branch contains now. */
  readonly commitsOnMain: number;
  /** Commits those pushes carried that the remote's main branch no longer contains. */
  readonly commitsNotOnMain: number;
  /** Pushes that ran whose target or commits could not be read. */
  readonly pushesNotChecked: number;
  /**
   * Of the main updates not checked, those that created `main` or `master` on the remote
   * (`* [new branch]`): the output was read, but it names no range of commits.
   */
  readonly pushesCreatingMain: number;
  /**
   * Of the pushes not checked, those in a command with several pushes whose output was read but
   * cannot be put to one of them: which push a line, or "up to date", is about is not known.
   */
  readonly pushesUnattributed: number;
  /** Pushes only mentioned, which did not run. */
  readonly mentioned: number;
  /** Pushes that could not be confirmed as run. */
  readonly unconfirmed: number;
  /** Calls that ran, or may have run, and could have run other commands this check does not read. */
  readonly couldHide: number;
  /** The hiding forms those calls hold, in `HIDING_FORMS` order. */
  readonly hidingForms: readonly HidingForm[];
}

declare module "./types.js" {
  interface CategoryFactsMap {
    unreviewed: UnreviewedFacts;
  }
}

/** The unreviewed-code category's result. */
export type UnreviewedCheck = CheckedCategory<UnreviewedFacts>;

/** One `git push` in a shell text. */
export interface PushCommand {
  /** The remote pushed to: the first operand, `--repo`, or `origin`. */
  readonly remote: string;
  /** The folder it ran in, from `git -C` or an earlier `cd`, as written. */
  readonly dir: string | undefined;
  readonly dryRun: boolean;
  /** The branches its refspecs name as the destination, where it names any. */
  readonly destinations: readonly string[];
}

/** One ref a push updated, from its output. */
export interface RefUpdate {
  /** The ids before and after, or `undefined` for a branch the push created. */
  readonly from: string | undefined;
  readonly to: string | undefined;
  /** The destination branch, as the push printed it. */
  readonly branch: string;
}

/**
 * `git push` options that take the next word. `--signed` is not one: it takes a value only
 * after `=` (`--signed=if-asked`), and alone is a flag.
 */
const PUSH_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-o",
  "--push-option",
  "--receive-pack",
  "--exec",
]);

/** A main branch, as a push prints its destination or a refspec names it. */
const MAIN_BRANCH = /^(?:refs\/heads\/)?(main|master)$/;

/** The `git push` commands in a shell text, with the folder each runs in. */
export function readPushes(command: string): PushCommand[] {
  const out: PushCommand[] = [];
  let dir: string | undefined;
  for (const simple of simpleCommands(command)) {
    const { program, args } = programAndArgs(simple);
    if (program === "cd") {
      dir = args[0];
      continue;
    }
    if (program !== "git") continue;
    let k = 0;
    let here = dir;
    while (k < args.length && (args[k] as string).startsWith("-")) {
      const arg = args[k] as string;
      if (arg === "-C") here = args[k + 1];
      k += GIT_GLOBAL_VALUE_OPTIONS.has(arg) ? 2 : 1;
    }
    if (args[k] !== "push") continue;
    let remote: string | undefined;
    let dryRun = false;
    const refspecs: string[] = [];
    const rest = args.slice(k + 1);
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i] as string;
      if (arg === "--dry-run" || arg === "-n") dryRun = true;
      else if (arg.startsWith("--repo=")) remote = arg.slice("--repo=".length);
      else if (arg === "--repo") {
        remote = rest[i + 1];
        i += 1;
      } else if (PUSH_VALUE_OPTIONS.has(arg)) i += 1;
      else if (arg.startsWith("-")) continue;
      else if (remote === undefined) remote = arg;
      else refspecs.push(arg);
    }
    out.push({
      remote: remote ?? "origin",
      dir: here,
      dryRun,
      destinations: refspecs.map((spec) => spec.replace(/^\+/, "").split(":").pop() ?? spec),
    });
  }
  return out;
}

/** Is there a `git push` in a shell text? */
export function hasPush(command: string): boolean {
  return readPushes(command).length > 0;
}

/**
 * The ref lines a push printed: refs it updated with a range of commits, and branches it
 * created (`* [new branch]  main -> main`), which carry no ids.
 */
export function pushedRefs(output: string): RefUpdate[] {
  const out: RefUpdate[] = [];
  for (const raw of output.split(/\r?\n/)) {
    // Leading blanks are taken off once, so neither pattern backtracks over a long run of them.
    const line = raw.trimStart();
    const range = /^\+?\s*([0-9a-f]{7,64})\.\.\.?([0-9a-f]{7,64})\s+(\S+)\s+->\s+(\S+)/.exec(line);
    if (range !== null) {
      out.push({ from: range[1] as string, to: range[2] as string, branch: range[4] as string });
      continue;
    }
    const created = /^\*\s+\[new branch\]\s+(\S+)\s+->\s+(\S+)/.exec(line);
    if (created !== null)
      out.push({ from: undefined, to: undefined, branch: created[2] as string });
  }
  return out;
}

/**
 * Does a push's output say what happened to each ref: a ref line, a rejection, or that
 * everything was up to date? A recorded output with none of these cannot be read.
 */
function saysWhatHappened(output: string): boolean {
  return /\s->\s|Everything up-to-date|\[up to date\]/.test(output);
}

/**
 * Guardrails whose match is a push. When one matched a command that ran and this module's
 * reading found no `git push` in it, the push is in a form the reading does not take apart, and
 * the card could not confirm (`unread-match`).
 */
export const PUSH_RULES: ReadonlySet<string> = new Set(["block-force-push"]);

/** What the unreviewed-code check needs. */
export interface UnreviewedInput {
  readonly calls: CorpusCalls;
  readonly io: VerifyIO;
  /**
   * The guardrails, to tell whether a `PUSH_RULES` match that the reading found no push in sits
   * where the shell runs it. Without them, such a match is not looked at.
   */
  readonly rules?: {
    readonly catalog: readonly CompiledRule[];
    readonly allowlist: CompiledAllowlist;
  };
}

/** What the unreviewed-code check produced. */
export interface UnreviewedOutcome {
  readonly check: UnreviewedCheck;
  readonly localFixes: readonly (LocalFix | UnsafeFix)[];
}

/** Commits a push carried, and whether the remote's main contains them now. */
type Placement = { readonly onMain: boolean; readonly commits: number } | undefined;

/** Ask the repo about one ref update to `origin`. `undefined` when it could not answer. */
async function place(io: VerifyIO, root: string, update: RefUpdate): Promise<Placement> {
  const branch = MAIN_BRANCH.exec(update.branch)?.[1];
  if (branch === undefined || update.from === undefined || update.to === undefined) {
    return undefined;
  }
  const contains = await io.git(root, [
    "for-each-ref",
    "--contains",
    update.to,
    "--format=%(refname)",
    "refs/remotes/origin/main",
    "refs/remotes/origin/master",
  ]);
  if (!contains.ok) return undefined;
  const range = await io.git(root, [
    "log",
    "--format=%H",
    "--max-count=1000",
    update.to,
    "--not",
    update.from,
  ]);
  if (!range.ok) return undefined;
  const commits = range.stdout.split("\n").filter((l) => l.trim() !== "").length;
  const ref = `refs/remotes/origin/${branch}`;
  return { onMain: contains.stdout.split("\n").some((l) => l.trim() === ref), commits };
}

/**
 * Run the unreviewed-code check. See the module header.
 *
 * Never throws: a repo that is gone, a `git` that fails and an output that cannot be read
 * are each counted as a push not checked.
 */
export async function checkUnreviewed(input: UnreviewedInput): Promise<UnreviewedOutcome> {
  const { agent, calls } = input.calls;
  const cache = rootCache();
  const fixes: (LocalFix | UnsafeFix)[] = [];
  const counts = {
    pushesToMain: 0,
    commitsOnMain: 0,
    commitsNotOnMain: 0,
    pushesNotChecked: 0,
    pushesCreatingMain: 0,
    pushesUnattributed: 0,
    mentioned: 0,
    unconfirmed: 0,
  };
  let matches = 0;
  const rules = input.rules;
  const pushRule =
    rules === undefined
      ? undefined
      : rulesMatcher(rules.catalog, rules.allowlist, (r) => PUSH_RULES.has(r.rule.id));
  const unread: SessionCall[] = [];

  for (const call of calls) {
    if (!isShell(call)) continue;
    if (!hasPush(call.command)) {
      // A push guardrail matched a call this reading finds no push in.
      if (pushRule === undefined || !call.ruleIds.some((id) => PUSH_RULES.has(id))) continue;
      matches += 1;
      const state = runStateOf(agent, call, (command) => pushRule(call, command));
      if (state === "mentioned") counts.mentioned += 1;
      else if (state === "unknown") counts.unconfirmed += 1;
      else unread.push(call);
      continue;
    }
    matches += 1;
    const state = runStateOf(agent, call, hasPush);
    if (state === "mentioned") {
      counts.mentioned += 1;
      continue;
    }
    if (state === "unknown") {
      counts.unconfirmed += 1;
      continue;
    }
    const pushes = readPushes(executedText(call.command)).filter((p) => !p.dryRun);
    const push = pushes[0];
    if (push === undefined) continue;

    const output = call.result?.content ?? "";
    const updates = pushedRefs(output).filter((u) => MAIN_BRANCH.test(u.branch));
    // Each push that names main as its destination, or names nothing at all, could have gone
    // to main.
    const mainPushes = pushes.filter(couldReachMain).length;
    if (updates.length === 0) {
      // No main update read. One push is not checked unless its recorded output says what
      // happened to each ref. With several, what the output says cannot be put to one of them,
      // so each that could have gone to main is not checked.
      if (pushes.length > 1) {
        counts.pushesNotChecked += mainPushes;
        // An output that says what happened, read but not put to one push.
        if (saysWhatHappened(output)) counts.pushesUnattributed += mainPushes;
      } else if (mainPushes > 0 && !saysWhatHappened(output)) counts.pushesNotChecked += 1;
      continue;
    }
    // With several pushes, each that could have gone to main beyond the main updates read
    // printed nothing to read: not checked.
    if (pushes.length > 1) {
      const extra = Math.max(0, mainPushes - updates.length);
      counts.pushesNotChecked += extra;
      counts.pushesUnattributed += extra;
    }
    counts.pushesToMain += updates.length;
    // A branch the push created carries no ids to ask about, so each is one not checked, below.
    counts.pushesCreatingMain += updates.filter((u) => u.from === undefined).length;

    // The updates are asked about in one repo, of one remote: every push must name both.
    const oneTarget = pushes.every((p) => p.remote === push.remote && p.dir === push.dir);
    const dir = placed(push.dir ?? call.cwd ?? "", call.cwd);
    const root = dir === undefined || dir === "" ? undefined : await repoRoot(input.io, dir, cache);
    if (root === undefined || !root.ok || push.remote !== "origin") {
      counts.pushesNotChecked += updates.length;
      continue;
    }
    if (!oneTarget) {
      counts.pushesNotChecked += updates.length;
      counts.pushesUnattributed += updates.length;
      continue;
    }
    for (const update of updates) {
      // A branch the push created carries no ids to ask about: not checked.
      const placement = await place(input.io, root.root, update);
      if (placement === undefined) {
        counts.pushesNotChecked += 1;
        continue;
      }
      if (placement.onMain) {
        counts.commitsOnMain += placement.commits;
        if (fixes.length < MAX_LOCAL_FIXES) {
          fixes.push(
            localFixCommand("unreviewed", [
              "git",
              "-C",
              { ref: root.root },
              "log",
              "--oneline",
              { sha: update.to ?? "" },
              "--not",
              { sha: update.from ?? "" },
            ]),
          );
        }
      } else counts.commitsNotOnMain += placement.commits;
    }
  }

  // A push behind a program no check reads, in any call, read or not.
  const behind = backstopCalls(
    input.calls,
    READ_PROGRAMS.unreviewed,
    (tail) => readPushes(tail).some((p) => !p.dryRun),
    pushRule,
  );
  const facts: UnreviewedFacts = { ...counts, ...hidingFacts(input.calls, [...unread, ...behind]) };
  return { check: { status: unreviewedStatus(facts), matches, facts }, localFixes: fixes };
}

/** Could a push have gone to main: does it name main as its destination, or name nothing? */
function couldReachMain(push: PushCommand): boolean {
  return push.destinations.length === 0 || push.destinations.some((d) => MAIN_BRANCH.test(d));
}

/** The unreviewed-code card's tone: `review` when commits reached main without a review. */
export function unreviewedStatus(facts: UnreviewedFacts): VerifyStatus {
  if (facts.commitsOnMain > 0) return "review";
  if (facts.pushesNotChecked > 0) return "could-not-check";
  return quietStatus(facts.unconfirmed, facts.couldHide);
}

// ── The card ─────────────────────────────────────────────────────────────────

/** A template that renders when `when` holds. */
function when(
  id: string,
  test: (f: UnreviewedFacts) => boolean,
  say: (f: UnreviewedFacts) => string,
): SentenceTemplate<UnreviewedFacts> {
  return { id, render: (f) => (test(f) ? say(f) : undefined) };
}

/** "What checking found". */
export const UNREVIEWED_FOUND: readonly SentenceTemplate<UnreviewedFacts>[] = [
  when(
    "unreviewed.pushes",
    (f) => f.pushesToMain > 0,
    (f) =>
      `${counted(f.pushesToMain, "push that ran", "pushes that ran")} went straight to a main branch.`,
  ),
  when(
    "unreviewed.none",
    (f) =>
      f.pushesToMain === 0 && f.pushesNotChecked === 0 && f.couldHide === 0 && f.unconfirmed === 0,
    () => "No push that ran went straight to a main branch.",
  ),
  when(
    "unreviewed.creates-main",
    (f) => f.pushesCreatingMain > 0,
    (f) =>
      `${counted(f.pushesCreatingMain, "push", "pushes")} created a main branch on the remote, so its output names no range of commits, and ${f.pushesCreatingMain === 1 ? "it was" : "they were"} not checked.`,
  ),
  when(
    "unreviewed.unattributed",
    (f) => f.pushesUnattributed > 0,
    (f) => {
      const other = f.pushesCreatingMain > 0;
      return `${counted(f.pushesUnattributed, other ? "more push" : "push", other ? "more pushes" : "pushes")} could not be checked: the command ran several pushes, and what their output says cannot be put to one of them.`;
    },
  ),
  when(
    "unreviewed.not-checked",
    (f) => f.pushesNotChecked > f.pushesCreatingMain + f.pushesUnattributed,
    (f) => {
      const n = f.pushesNotChecked - f.pushesCreatingMain - f.pushesUnattributed;
      const other = f.pushesCreatingMain + f.pushesUnattributed > 0;
      return `${counted(n, other ? "more push" : "push", other ? "more pushes" : "pushes")} could not be checked: the output or the repo could not be read.`;
    },
  ),
  when(
    "unreviewed.mentioned",
    (f) => f.mentioned > 0,
    (f) => {
      const other = f.pushesToMain + f.pushesNotChecked > 0;
      return `${counted(f.mentioned, other ? "more push was" : "push was", other ? "more pushes were" : "pushes were")} only mentioned and did not run.`;
    },
  ),
  when(
    "unreviewed.unconfirmed",
    (f) => f.unconfirmed > 0,
    (f) => `${counted(f.unconfirmed, "push", "pushes")} could not be confirmed as run.`,
  ),
];

/** "Now": where those commits are. */
export const UNREVIEWED_NOW: readonly SentenceTemplate<UnreviewedFacts>[] = [
  when(
    "unreviewed.on-main",
    (f) => f.commitsOnMain > 0,
    (f) =>
      `${counted(f.commitsOnMain, "commit is", "commits are")} on the remote's main branch, as this machine last fetched it.`,
  ),
  when(
    "unreviewed.not-on-main",
    (f) => f.commitsNotOnMain > 0,
    (f) =>
      `${counted(f.commitsNotOnMain, "pushed commit is", "pushed commits are")} no longer on it.`,
  ),
];

/** "Fix", in sentences. */
export const UNREVIEWED_FIX_STEPS: readonly SentenceTemplate<UnreviewedFacts>[] = [
  when(
    "unreviewed.fix.review",
    (f) => f.commitsOnMain > 0,
    () => "Review these commits as a pull request would have, and require pull requests on main.",
  ),
];

/** The chip label: the number is shown apart. */
const UNREVIEWED_CHIP: SentenceTemplate<UnreviewedFacts> = {
  id: "unreviewed.chip",
  render: (f) =>
    noun(f.commitsOnMain, "commit pushed straight to main", "commits pushed straight to main"),
};

/** The card's short rows. The full sentences above stay behind its expander. */
export const UNREVIEWED_SUMMARY: SummaryTemplates<UnreviewedFacts> = {
  happened: [
    ...UNREVIEWED_FOUND.filter((t) => ["unreviewed.pushes", "unreviewed.none"].includes(t.id)),
    when(
      "unreviewed.short.not-checked",
      (f) => f.pushesNotChecked > 0,
      (f) => `${counted(f.pushesNotChecked, "push", "pushes")} could not be checked.`,
    ),
  ],
  now: UNREVIEWED_NOW,
  fix: UNREVIEWED_FIX_STEPS,
};

/** The card for the unreviewed-code check. */
export const unreviewedCard: ToCard<"unreviewed"> = (result, context: CardContext) => {
  const f = result.facts;
  const card: FullCard = {
    category: "unreviewed",
    tone: result.status,
    count: result.matches,
    found: sentences(UNREVIEWED_FOUND, f),
    now: sentences(UNREVIEWED_NOW, f),
    summary: summaryOf(UNREVIEWED_SUMMARY, f),
    fixes: f.commitsOnMain > 0 ? [{ shape: "git log --oneline <from>..<to>" }] : [],
    fixSteps: sentences(UNREVIEWED_FIX_STEPS, f),
    chip: {
      count: f.commitsOnMain,
      label: sentence(UNREVIEWED_CHIP, f) ?? { template: UNREVIEWED_CHIP.id, text: "" },
    },
    codexCaveat: restsOnCodex(context) && f.pushesToMain > 0,
  };
  return card;
};
