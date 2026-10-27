/**
 * The verified note on each guardrail in All findings: one line, from the check that covers
 * the guardrail's rule, such as "Mostly scratch, temp or build folders. No tracked file is
 * missing."
 *
 * ── One table, and no guessed note ───────────────────────────────────────────
 * `NOTE_RULES` maps a shipped guardrail's id to the check that covers it and the kind of note it
 * gets. A rule not in the table gets no note, and neither does a guardrail the user wrote, even
 * one that reuses a shipped id: the table is about the shipped rules.
 *
 * ── Only counts, read by registered keys ─────────────────────────────────────
 * Each kind reads named counts from its check's facts by paths of registered fact keys
 * (`NOTE_FACT_KEYS` lists them all). A count is a non-negative whole number or the note is not
 * made: a string, a missing key or a value of any other type ends it. So the only variable part
 * of a note is a number, and no value, name, path or host can reach one. The facts are the ones
 * the report carries, after its boundary has dropped every key that is not registered.
 *
 * ── Never more than the check confirmed ──────────────────────────────────────
 * Before a kind's template runs:
 *  - a category not checked gets no note;
 *  - a check whose commands that ran hold a form that can hide others (`HIDING_FORMS`), or that
 *    could not finish, gets a "Could not confirm" note, never a reassuring one;
 *  - a note that rests on commands having run, or on what commands printed, from sessions that
 *    record no command output, gets a "Could not confirm" note.
 * A template's reassuring clauses ("False positive", "Nothing lost", "No tracked file is
 * missing" and the like) run only when it is told it may reassure. Codex sessions are read in a
 * limited way that is not verified, so on a Codex scan no note reassures: what is left is its
 * counts, followed by the Codex caveat, or no note at all. Each note says whether it reassures,
 * so the page never marks a reassuring note in an alarming card's colour. No template says a
 * guardrail's commands did not run.
 *
 * Pure. No I/O.
 */

import { formatCount } from "../tokens.js";
import {
  type CardSentence,
  type CardView,
  type NoteOutcome,
  type NoteSource,
  type SentenceTemplate,
  sentence,
  UNCONFIRMED_SENTENCE,
  type VerifiedNote,
} from "./cards.js";
import { CODEX_CAVEAT, countOf } from "./copy.js";
import { HIDING_FORMS, type HidingForm, type Verification } from "./types.js";

// ── Reading counts ────────────────────────────────────────────────────────────

/** A path into a check's facts. Every step is a registered fact key or a registered enum value. */
type FactPath = readonly string[];

/**
 * How one count is read:
 * - a path to a count;
 * - `{ path, equals }`: 1 when the enum at `path` is `equals`, 0 when it is another string;
 * - `{ list, where }`: how many objects in the list at `list` hold `where[1]` in their list
 *   under `where[0]`.
 */
type CountRead =
  | FactPath
  | { readonly path: FactPath; readonly equals: string }
  | { readonly list: FactPath; readonly where: readonly [string, string] };

/** The counts a note kind reads, by name. */
type CountReads<K extends string> = Readonly<Record<K, CountRead>>;

/** The counts a note kind read, by name. */
type Counts<K extends string> = Readonly<Record<K, number>>;

/** What a template is told beside its counts. */
interface NoteContext {
  /** Whether its reassuring clauses may run. Never on a Codex scan. */
  readonly reassure: boolean;
}

/** A template's input: its counts, and its context. */
type NoteFacts<K extends string> = Counts<K> & NoteContext;

/** The value at `path`, through plain objects only; `undefined` when a step is missing. */
function at(facts: unknown, path: FactPath): unknown {
  let value = facts;
  for (const key of path) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    if (!Object.hasOwn(value, key)) return undefined;
    value = (value as Readonly<Record<string, unknown>>)[key];
  }
  return value;
}

/** A count: a non-negative whole number, or `undefined`. */
function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Is `read` a plain path? */
function isPath(read: CountRead): read is FactPath {
  return Array.isArray(read);
}

/** One count, read as `read` says, or `undefined` when the facts do not hold it as a count. */
function readCount(facts: unknown, read: CountRead): number | undefined {
  if (isPath(read)) return asCount(at(facts, read));
  if ("equals" in read) {
    const value = at(facts, read.path);
    return typeof value === "string" ? (value === read.equals ? 1 : 0) : undefined;
  }
  const list = at(facts, read.list);
  if (!Array.isArray(list)) return undefined;
  const [key, value] = read.where;
  let n = 0;
  for (const item of list) {
    const held = at(item, [key]);
    if (!Array.isArray(held)) return undefined;
    if (held.includes(value)) n += 1;
  }
  return n;
}

/** Every count a kind reads, or `undefined` when any one is not there as a count. */
function readCounts<K extends string>(facts: unknown, reads: CountReads<K>): Counts<K> | undefined {
  const out: Record<string, number> = {};
  for (const [name, read] of Object.entries(reads) as [K, CountRead][]) {
    const n = readCount(facts, read);
    if (n === undefined) return undefined;
    out[name] = n;
  }
  return out as Counts<K>;
}

// ── Words ─────────────────────────────────────────────────────────────────────

/** `is` or `are`. */
function is(n: number): string {
  return n === 1 ? "is" : "are";
}

/** `was` or `were`. */
function was(n: number): string {
  return n === 1 ? "was" : "were";
}

/** Sentences joined into one line, or `undefined` when there are none. */
function line(parts: readonly (string | undefined)[]): string | undefined {
  const made = parts.filter((p): p is string => p !== undefined);
  return made.length === 0 ? undefined : made.join(" ");
}

/** "N could not be looked up." */
function notLookedUp(n: number, one: string, many?: string): string | undefined {
  return n > 0 ? `${countOf(n, one, many)} could not be looked up.` : undefined;
}

/** What a note from Codex sessions adds: the card's own Codex caveat. */
const CODEX_NOTE_TEXT = CODEX_CAVEAT.render({ codexCaveat: true }) ?? "";

/** Cloud and infrastructure changes cannot be checked from this machine. */
function reviewByHand(n: number): string {
  return n === 1
    ? "It cannot be checked from this machine, so review it by hand."
    : "They cannot be checked from this machine, so review them by hand.";
}

// ── Note kinds ────────────────────────────────────────────────────────────────

/** A kind of note: the counts it reads, its template, and whether it rests on commands that ran. */
interface NoteKind<K extends string> {
  readonly reads: CountReads<K>;
  readonly template: SentenceTemplate<NoteFacts<K>>;
  /**
   * The note states what commands that ran did. From sessions that record no command output it
   * could confirm nothing, and from Codex sessions its counts may include blocked calls.
   */
  readonly ran: boolean;
  /**
   * The note rests on what commands printed. From sessions that record no command output it
   * could confirm nothing, whether or not it counts commands that ran.
   */
  readonly output?: boolean;
}

/** A kind, as the table holds it. */
type AnyKind = NoteKind<string>;

/** Erase a kind's count names, for the table. */
function kind<K extends string>(spec: NoteKind<K>): AnyKind {
  return spec as unknown as AnyKind;
}

/** Commits made skipping hooks, and where they are now. Skipped safety checks. */
const NO_VERIFY = kind({
  reads: {
    commits: ["noVerify", "commits"],
    notIdentified: ["noVerify", "notIdentified"],
    withoutHooks: ["noVerify", "withoutHooks"],
    onMain: ["noVerify", "onMain"],
    offMain: ["noVerify", "offMain"],
    noMain: ["noVerify", "noMainToCheck"],
    gone: ["noVerify", "gone"],
    couldNotCheck: ["noVerify", "couldNotCheck"],
    unknown: ["noVerify", "calls", "unknown"],
  },
  ran: true,
  template: {
    id: "note.no-verify",
    render: (f) => {
      const withHooks = f.onMain + f.offMain + f.noMain + f.gone;
      const settled = f.notIdentified + f.couldNotCheck + f.unknown === 0;
      return line([
        withHooks > 0
          ? `${countOf(withHooks, "commit")} skipped the hooks of a repo that has them; ${formatCount(f.onMain)} ${is(f.onMain)} on main now.`
          : undefined,
        f.reassure && withHooks === 0 && f.withoutHooks > 0 && settled
          ? `False positive: ${f.withoutHooks === 1 ? "the commit" : `all ${formatCount(f.withoutHooks)} commits`} that skipped hooks ${was(f.withoutHooks)} in repos with no commit hook, so no check was skipped.`
          : undefined,
        f.noMain > 0
          ? `${countOf(f.noMain, "commit")} ${is(f.noMain)} in a repo with no main branch to check against.`
          : undefined,
        notLookedUp(f.notIdentified + f.couldNotCheck, "commit"),
      ]);
    },
  },
});

/** Hooks switched off, now and for one command. Skipped safety checks. */
const HOOKS_OFF = kind({
  reads: {
    off: ["hooksPath", "off"],
    on: ["hooksPath", "on"],
    couldNotCheck: ["hooksPath", "couldNotCheck"],
    unknown: ["hooksPath", "calls", "unknown"],
    oneCommand: ["husky", "ran"],
  },
  ran: true,
  template: {
    id: "note.hooks-off",
    render: (f) =>
      line([
        f.off > 0 ? `Hooks are switched off now in ${countOf(f.off, "repo")}.` : undefined,
        f.reassure && f.off === 0 && f.on > 0 && f.couldNotCheck + f.unknown === 0
          ? "Hooks are on now in every repo where they were switched."
          : undefined,
        f.oneCommand > 0
          ? `${countOf(f.oneCommand, "command")} turned Husky off for that command only.`
          : undefined,
        notLookedUp(f.couldNotCheck, "repo"),
      ]),
  },
});

/** Force-deleted branches, and whether their commits can be recovered. Lost work. */
const BRANCHES = kind({
  reads: {
    deleted: ["branches", "deleted"],
    notIdentified: ["branches", "notIdentified"],
    recoverable: ["branches", "recoverable"],
    onAnotherRef: ["branches", "onAnotherRef"],
    gone: ["branches", "gone"],
    couldNotCheck: ["branches", "couldNotCheck"],
    unknown: ["branches", "calls", "unknown"],
  },
  ran: true,
  template: {
    id: "note.branches",
    render: (f) =>
      line([
        f.recoverable > 0
          ? `${countOf(f.recoverable, "deleted branch", "deleted branches")} can still be recovered by commit id.`
          : undefined,
        f.gone > 0
          ? `${countOf(f.gone, "deleted branch", "deleted branches")} ${is(f.gone)} gone from the object store.`
          : undefined,
        f.reassure &&
        f.recoverable + f.gone === 0 &&
        f.onAnotherRef > 0 &&
        f.notIdentified + f.couldNotCheck + f.unknown === 0
          ? "Nothing lost: every deleted branch's commits are still on another branch or tag."
          : undefined,
        notLookedUp(f.notIdentified + f.couldNotCheck, "deleted branch", "deleted branches"),
      ]),
  },
});

/** Dropped and cleared stashes, and whether they can be recovered. Lost work. */
const STASHES = kind({
  reads: {
    cleared: ["stashes", "cleared"],
    notIdentified: ["stashes", "notIdentified"],
    recoverable: ["stashes", "recoverable"],
    listed: ["stashes", "listed"],
    gone: ["stashes", "gone"],
    couldNotCheck: ["stashes", "couldNotCheck"],
    unknown: ["stashes", "calls", "unknown"],
  },
  ran: true,
  template: {
    id: "note.stashes",
    render: (f) =>
      line([
        f.recoverable > 0
          ? `${countOf(f.recoverable, "dropped stash", "dropped stashes")} can still be recovered by commit id.`
          : undefined,
        f.gone > 0
          ? `${countOf(f.gone, "dropped stash", "dropped stashes")} ${is(f.gone)} gone from the object store.`
          : undefined,
        f.reassure &&
        f.recoverable + f.gone + f.cleared === 0 &&
        f.listed > 0 &&
        f.notIdentified + f.couldNotCheck + f.unknown === 0
          ? "Nothing lost: every dropped stash is back in the stash list."
          : undefined,
        f.cleared > 0
          ? `${countOf(f.cleared, "stash clear")} ran; what ${f.cleared === 1 ? "it" : "they"} removed is not checked.`
          : undefined,
        notLookedUp(f.notIdentified + f.couldNotCheck, "dropped stash", "dropped stashes"),
      ]),
  },
});

/** Discarded and restored paths, by whose they were. Lost work. */
const DISCARDS = kind({
  reads: {
    paths: ["discards", "paths"],
    ownCopy: ["discards", "ownCopy"],
    agentEdited: ["discards", "agentEdited"],
    mainCheckout: ["discards", "mainCheckout"],
    couldNotCheck: ["discards", "couldNotCheck"],
    unknown: ["discards", "calls", "unknown"],
  },
  ran: true,
  template: {
    id: "note.discards",
    render: (f) => {
      if (f.paths === 0) return undefined;
      if (f.reassure && f.ownCopy === f.paths && f.couldNotCheck + f.unknown === 0) {
        return f.paths === 1
          ? "The discarded path was in the agent's own worktree or a scratch copy."
          : `All ${formatCount(f.paths)} discarded paths were in the agent's own worktree or a scratch copy.`;
      }
      const parts: string[] = [];
      if (f.ownCopy > 0) parts.push(`${formatCount(f.ownCopy)} in the agent's own copy`);
      if (f.agentEdited > 0) parts.push(`${formatCount(f.agentEdited)} the agent had edited`);
      if (f.mainCheckout > 0) {
        parts.push(
          `${formatCount(f.mainCheckout)} in the main checkout with no agent edit on record`,
        );
      }
      if (f.couldNotCheck > 0) parts.push(`${formatCount(f.couldNotCheck)} could not be placed`);
      return parts.length === 0
        ? undefined
        : `Of ${countOf(f.paths, "discarded path")}: ${parts.join(", ")}.`;
    },
  },
});

/** Recursive delete targets, by class, and whether tracked files are back. Destructive commands. */
const RM_TARGETS = kind({
  reads: {
    targets: ["rm", "targets"],
    scratch: ["rm", "classes", "scratch"],
    untracked: ["rm", "classes", "untracked"],
    home: ["rm", "classes", "home"],
    unguarded: ["rm", "classes", "unguarded-variable"],
    guarded: ["rm", "classes", "guarded-variable"],
    trackedGone: ["rm", "trackedGone"],
    trackedPartlyBack: ["rm", "trackedPartlyBack"],
    couldNotCheck: ["rm", "couldNotCheck"],
    unknown: ["rm", "calls", "unknown"],
  },
  ran: true,
  template: {
    id: "note.rm-targets",
    render: (f) => {
      if (f.targets === 0) return undefined;
      const missing = f.trackedGone + f.trackedPartlyBack;
      // A target held in a variable is never resolved, so what it held is not known.
      const settled = f.couldNotCheck + f.unknown + f.unguarded + f.guarded === 0;
      return line([
        f.reassure && settled && f.scratch === f.targets
          ? "All scratch, temp or build folders."
          : f.reassure && settled && f.scratch * 2 > f.targets
            ? "Mostly scratch, temp or build folders."
            : f.scratch > 0
              ? `${formatCount(f.scratch)} of ${countOf(f.targets, "target")} ${was(f.scratch)} scratch, temp or build folders.`
              : undefined,
        missing > 0
          ? `${countOf(missing, "tracked target")} still ${missing === 1 ? "has" : "have"} files missing.`
          : f.reassure && settled
            ? "No tracked file is missing."
            : undefined,
        f.untracked > 0
          ? `${countOf(f.untracked, "target")} held untracked files in a repo.`
          : undefined,
        f.home > 0
          ? `${countOf(f.home, "target")} ${was(f.home)} under the home folder, outside a repo.`
          : undefined,
        f.unguarded > 0
          ? `${countOf(f.unguarded, "target")} came from a variable with no guard.`
          : undefined,
        f.guarded > 0
          ? `${countOf(f.guarded, "target")} came from a guarded variable, so what ${f.guarded === 1 ? "it" : "they"} held is not known.`
          : undefined,
        f.couldNotCheck > 0
          ? `${countOf(f.couldNotCheck, "target")} could not be checked.`
          : undefined,
      ]);
    },
  },
});

/** Databases a destructive command was aimed at, by class. Destructive commands. */
const DATABASES = kind({
  reads: {
    local: ["databases", "classes", "local"],
    scratch: ["databases", "classes", "scratch"],
    other: ["databases", "classes", "other"],
    unresolved: ["databases", "classes", "unresolved"],
    unknown: ["databases", "calls", "unknown"],
  },
  ran: true,
  template: {
    id: "note.databases",
    render: (f) => {
      if (f.local + f.scratch + f.other + f.unresolved === 0) return undefined;
      return line([
        f.other > 0
          ? `${countOf(f.other, "database")} aimed at ${was(f.other)} neither local nor scratch.`
          : f.reassure && f.unresolved + f.unknown === 0
            ? `Only local or scratch databases: ${formatCount(f.local)} local, ${formatCount(f.scratch)} scratch.`
            : undefined,
        f.unresolved > 0 ? `${countOf(f.unresolved, "database")} could not be placed.` : undefined,
      ]);
    },
  },
});

/**
 * Likely-real credentials, by how many got into a transcript one way. Secrets. `output` when
 * that way is a command's printed output, which some sessions do not record.
 */
function secretsBy(id: string, via: string, how: string, output: boolean): AnyKind {
  return kind({
    reads: {
      likelyReal: ["classes", "likely-real"],
      shown: { list: ["items"], where: ["via", via] },
      more: ["moreItems"],
      read: ["filesRead"],
      notRead: ["filesNotRead"],
      unplaced: ["unplaced"],
      outputOnly: ["setAside", "unnamedOutputOnly"],
      notShaped: ["setAside", "namedNotCredentialShaped"],
    },
    ran: false,
    output,
    template: {
      id,
      render: (f) => {
        if (f.shown > 0) {
          return `Likely-real credentials ${how}: ${f.more > 0 ? "at least " : ""}${formatCount(f.shown)}.`;
        }
        // Nothing in a count the check could not finish, or set aside by a rule that can miss.
        if (
          !f.reassure ||
          f.read === 0 ||
          f.more + f.notRead + f.unplaced + f.outputOnly + f.notShaped > 0
        ) {
          return undefined;
        }
        return f.likelyReal > 0
          ? `None of the likely-real credentials found ${was(f.likelyReal)} ${how}.`
          : "No likely-real credential was found in the transcripts.";
      },
    },
  });
}

/** Credentials printed by a command. Secrets. */
const SECRETS_PRINTED = secretsBy(
  "note.secrets-printed",
  "printed-by-command",
  "printed by a command",
  true,
);

/** Credentials typed into a command. Secrets. */
const SECRETS_TYPED = secretsBy(
  "note.secrets-typed",
  "typed-into-command",
  "typed into a command",
  false,
);

/** IAM changes that ran. Cloud and permissions. */
const IAM = kind({
  reads: { iam: ["iamChanges"] },
  ran: true,
  template: {
    id: "note.iam",
    render: (f) =>
      f.iam > 0 ? `${countOf(f.iam, "IAM change")} ran. ${reviewByHand(f.iam)}` : undefined,
  },
});

/** Terraform changes that ran. Cloud and permissions. */
const TERRAFORM = kind({
  reads: { changes: ["terraformChanges"], autoApprove: ["terraformAutoApprove"] },
  ran: true,
  template: {
    id: "note.terraform",
    render: (f) =>
      f.changes > 0
        ? `${countOf(f.changes, "Terraform command")} that change${f.changes === 1 ? "s" : ""} infrastructure or state ran, ${formatCount(f.autoApprove)} with auto-approve. ${reviewByHand(f.changes)}`
        : undefined,
  },
});

/** Production infrastructure commands and edits that ran. Production infrastructure. */
const INFRA = kind({
  reads: { infra: ["infraMatches"] },
  ran: true,
  template: {
    id: "note.infra",
    render: (f) =>
      f.infra > 0
        ? `${countOf(f.infra, "production infrastructure command or edit", "production infrastructure commands or edits")} ran. ${reviewByHand(f.infra)}`
        : undefined,
  },
});

/** Test files deleted, and whether they failed first. Gaming tests. */
const TESTS_DELETED = kind({
  reads: {
    deleted: ["testFilesDeleted"],
    afterFailing: ["deletedAfterFailing"],
    notKnown: ["deletedFailureUnknown"],
  },
  ran: true,
  template: {
    id: "note.tests-deleted",
    render: (f) =>
      f.deleted > 0
        ? line([
            `${countOf(f.deleted, "test file")} deleted, ${formatCount(f.afterFailing)} after a test run reported ${f.afterFailing === 1 ? "it" : "them"} failing.`,
            f.notKnown > 0
              ? `For ${formatCount(f.notKnown)}, whether ${f.notKnown === 1 ? "it" : "they"} failed first is not known.`
              : undefined,
          ])
        : undefined,
  },
});

/** Coverage floors and excludes. Gaming tests. */
const TESTS_CONFIG = kind({
  reads: {
    lowered: ["thresholdsLowered"],
    reverts: ["autoUpdateReverts"],
    excludes: ["excludesAdded"],
    rewritten: ["configsRewritten"],
    unconfirmed: ["unconfirmed"],
  },
  ran: true,
  template: {
    id: "note.tests-config",
    render: (f) =>
      line([
        f.lowered > 0
          ? `${countOf(f.lowered, "coverage threshold")} lowered.`
          : f.reassure && f.reverts > 0 && f.rewritten + f.unconfirmed === 0
            ? `No coverage floor went down: the ${countOf(f.reverts, "threshold drop")} undid an automatic raise.`
            : undefined,
        f.excludes > 0
          ? `${countOf(f.excludes, "exclude")} added to a test or coverage list.`
          : undefined,
        f.rewritten > 0
          ? `${countOf(f.rewritten, "test config")} rewritten whole, so whether a threshold went down cannot be told.`
          : undefined,
      ]),
  },
});

/** Test runs made to pass with nothing to pass. Gaming tests. */
const TESTS_PASS = kind({
  reads: { passWithNoTests: ["passWithNoTests"], forcedTrue: ["ciStepsForcedTrue"] },
  ran: true,
  template: {
    id: "note.tests-pass",
    render: (f) =>
      line([
        f.passWithNoTests > 0
          ? `${countOf(f.passWithNoTests, "test run or config", "test runs or configs")} allowed passing with no tests.`
          : undefined,
        f.forcedTrue > 0
          ? `${countOf(f.forcedTrue, "CI step")} ${was(f.forcedTrue)} made to pass whatever ${f.forcedTrue === 1 ? "it returns" : "they return"}.`
          : undefined,
      ]),
  },
});

/** Uploads off this machine, and calls that only reached it. Data leaving the machine. */
const UPLOADS = kind({
  reads: { uploads: ["uploads"], localOnly: ["localOnly"], unconfirmed: ["unconfirmed"] },
  ran: true,
  template: {
    id: "note.uploads",
    render: (f) =>
      f.uploads > 0
        ? `${countOf(f.uploads, "upload")} to a host off this machine ran.`
        : f.reassure && f.localOnly > 0 && f.unconfirmed === 0
          ? `False positive: nothing that ran left this machine; ${countOf(f.localOnly, "call")} went to this machine or LocalStack.`
          : undefined,
  },
});

/** Tunnels started, and tunnel programs running now. Data leaving the machine. */
const TUNNELS = kind({
  reads: {
    started: ["tunnelsStarted"],
    running: ["tunnelsRunning"],
    listed: { path: ["processCheck"], equals: "checked" },
  },
  ran: true,
  template: {
    id: "note.tunnels",
    render: (f) =>
      line([
        f.started > 0
          ? `${countOf(f.started, "tunnel")} ${was(f.started)} started to expose this machine.`
          : undefined,
        f.running > 0
          ? `${countOf(f.running, "tunnel program")} ${is(f.running)} running now.`
          : f.listed === 0
            ? "Whether one is running now could not be checked."
            : f.reassure
              ? "No known tunnel or relay program was seen running now."
              : undefined,
      ]),
  },
});

/** Package installs, with lockfile restores left out. Dependencies. */
const INSTALLS = kind({
  reads: {
    installs: ["installs"],
    restores: ["lockfileRestores"],
    unconfirmed: ["unconfirmed"],
  },
  ran: true,
  template: {
    id: "note.installs",
    render: (f) =>
      f.installs > 0
        ? `${countOf(f.installs, "package install")} ran, not counting ${countOf(f.restores, "lockfile restore")}. Package age is not checked: the scan runs offline.`
        : f.reassure && f.restores > 0 && f.unconfirmed === 0
          ? `False positive: the ${countOf(f.restores, "install")} that ran only restored a lockfile.`
          : undefined,
  },
});

/** Every note kind, by name. */
export const NOTE_KINDS = {
  "no-verify": NO_VERIFY,
  "hooks-off": HOOKS_OFF,
  branches: BRANCHES,
  stashes: STASHES,
  discards: DISCARDS,
  "rm-targets": RM_TARGETS,
  databases: DATABASES,
  "secrets-printed": SECRETS_PRINTED,
  "secrets-typed": SECRETS_TYPED,
  iam: IAM,
  terraform: TERRAFORM,
  infra: INFRA,
  "tests-deleted": TESTS_DELETED,
  "tests-config": TESTS_CONFIG,
  "tests-pass": TESTS_PASS,
  uploads: UPLOADS,
  tunnels: TUNNELS,
  installs: INSTALLS,
} as const satisfies Readonly<Record<string, AnyKind>>;

/** One kind of note. */
export type NoteKindName = keyof typeof NOTE_KINDS;

/** Where a rule's note comes from: the check that covers it, and its kind of note. */
export interface NoteRule {
  readonly category: NoteSource;
  readonly kind: NoteKindName;
}

/**
 * The one table: each shipped guardrail a check covers, the check, and the note it gets. A rule
 * not here gets no note.
 */
export const NOTE_RULES: Readonly<Record<string, NoteRule>> = {
  // Skipped safety checks.
  "gb.git-no-verify": { category: "skipped-checks", kind: "no-verify" },
  "gb.hooks-disable": { category: "skipped-checks", kind: "hooks-off" },
  // Lost work.
  "wt.branch-force-delete": { category: "lost-work", kind: "branches" },
  "wt.stash-drop": { category: "lost-work", kind: "stashes" },
  "wt.checkout-discard": { category: "lost-work", kind: "discards" },
  "wt.restore-path": { category: "lost-work", kind: "discards" },
  "wt.reset-hard": { category: "lost-work", kind: "discards" },
  // Destructive commands.
  "require-approval-rm-rf": { category: "destructive", kind: "rm-targets" },
  "dd.rm-rf-absolute": { category: "destructive", kind: "rm-targets" },
  "dd.database-drop": { category: "destructive", kind: "databases" },
  "block-destructive-sql": { category: "destructive", kind: "databases" },
  // Secrets in transcripts.
  "se.env-print": { category: "secrets", kind: "secrets-printed" },
  "se.token-print": { category: "secrets", kind: "secrets-printed" },
  "se.secret-manager-read": { category: "secrets", kind: "secrets-printed" },
  "se.credential-file": { category: "secrets", kind: "secrets-printed" },
  "block-env-file-read": { category: "secrets", kind: "secrets-printed" },
  "warn-op-read-secret": { category: "secrets", kind: "secrets-printed" },
  "block-hardcoded-secrets": { category: "secrets", kind: "secrets-typed" },
  // Cloud and permissions.
  "ps.iam-grant": { category: "cloud", kind: "iam" },
  "pi.terraform-auto-approve": { category: "cloud", kind: "terraform" },
  "pi.terraform-state-mutate": { category: "cloud", kind: "terraform" },
  // Production infrastructure.
  "pi.kubectl-delete": { category: "prod-infra", kind: "infra" },
  "pi.prod-namespace": { category: "prod-infra", kind: "infra" },
  "pi.helm-release": { category: "prod-infra", kind: "infra" },
  "pi.cloud-resource-delete": { category: "prod-infra", kind: "infra" },
  "pi.deploy-to-prod": { category: "prod-infra", kind: "infra" },
  "block-prod-config-edit": { category: "prod-infra", kind: "infra" },
  // Gaming tests.
  "ti.test-file-delete": { category: "tests", kind: "tests-deleted" },
  "ti.test-config-edit": { category: "tests", kind: "tests-config" },
  "ti.coverage-bypass": { category: "tests", kind: "tests-pass" },
  // Data leaving the machine.
  "ex.file-upload": { category: "egress", kind: "uploads" },
  "se.secret-egress": { category: "egress", kind: "uploads" },
  "ex.paste-service": { category: "egress", kind: "uploads" },
  "ex.reverse-shell": { category: "egress", kind: "uploads" },
  "ex.tunnel-expose": { category: "egress", kind: "tunnels" },
  // Dependencies.
  "flag-dependency-install": { category: "dependencies", kind: "installs" },
  "rce.unverified-package": { category: "dependencies", kind: "installs" },
};

/** The fact keys that say a check's commands held a form that can hide others. */
const HIDING_COUNTS: readonly FactPath[] = [["couldHide"], ["hidingCalls"]];

/** Every fact key and enum value a note reads, for the registered-keys test. */
export const NOTE_FACT_KEYS: readonly string[] = [
  ...new Set([
    "dependencies",
    "hidingForms",
    ...HIDING_COUNTS.flat(),
    ...Object.values(NOTE_KINDS).flatMap((k) =>
      Object.values(k.reads).flatMap((read: CountRead): string[] =>
        isPath(read)
          ? [...read]
          : "equals" in read
            ? [...read.path, read.equals]
            : [...read.list, ...read.where],
      ),
    ),
  ]),
];

// ── Before a template runs ────────────────────────────────────────────────────

/** A note on a check that could not finish. */
export const NOTE_COULD_NOT_CHECK: SentenceTemplate<unknown> = {
  id: "note.could-not-check",
  render: () => "Could not confirm: the check behind this could not finish on this machine.",
};

/** A note on a check whose commands held a form that can hide others, with none named. */
export const NOTE_COULD_HIDE: SentenceTemplate<unknown> = {
  id: "note.could-hide",
  render: () =>
    "Could not confirm: commands that ran could have run others this reading does not take apart.",
};

/** A note that rests on command output, from sessions that record none. */
export const NOTE_NO_OUTPUT: SentenceTemplate<unknown> = {
  id: "note.no-output",
  render: () => "Could not confirm: these sessions record no command output to check this against.",
};

/** The templates of the notes that could not confirm. */
export const UNCONFIRMED_NOTES: readonly string[] = [
  UNCONFIRMED_SENTENCE.id,
  NOTE_COULD_NOT_CHECK.id,
  NOTE_COULD_HIDE.id,
  NOTE_NO_OUTPUT.id,
];

/** The hiding forms a check's facts name, and whether it counted any call holding one. */
function hidingIn(facts: unknown): { readonly forms: HidingForm[]; readonly any: boolean } {
  const named = at(facts, ["hidingForms"]);
  const forms = Array.isArray(named) ? HIDING_FORMS.filter((form) => named.includes(form)) : [];
  const counted = HIDING_COUNTS.some((path) => (asCount(at(facts, path)) ?? 0) > 0);
  return { forms, any: forms.length > 0 || counted };
}

/** What a note says when its check could not confirm, or `undefined` when it could. */
function unconfirmedLine(
  rule: NoteRule,
  facts: unknown,
  card: CardView | undefined,
  verification: Pick<Verification, "resultsRecorded">,
): CardSentence | undefined {
  if (card?.unconfirmed?.reason === "hiding-forms") {
    return sentence(UNCONFIRMED_SENTENCE, card.unconfirmed);
  }
  if (card?.unconfirmed?.reason === "no-output") return sentence(NOTE_NO_OUTPUT, undefined);
  const hiding = hidingIn(facts);
  if (hiding.forms.length > 0) {
    return sentence(UNCONFIRMED_SENTENCE, { reason: "hiding-forms", forms: hiding.forms });
  }
  if (hiding.any) return sentence(NOTE_COULD_HIDE, undefined);
  if (card?.tone === "could-not-check") return sentence(NOTE_COULD_NOT_CHECK, undefined);
  const spec = NOTE_KINDS[rule.kind];
  if ((spec.ran || spec.output === true) && !verification.resultsRecorded) {
    return sentence(NOTE_NO_OUTPUT, undefined);
  }
  return undefined;
}

/** The facts a rule's note reads: its category's, or the dependency check's. */
function factsFor(rule: NoteRule, verification: Verification): unknown {
  if (rule.category === "dependencies") {
    return (verification as { readonly dependencies?: unknown }).dependencies;
  }
  return (verification.categories[rule.category] as { readonly facts?: unknown }).facts;
}

/** A finding, as far as a note needs it. */
export interface NotedFinding {
  readonly ruleId: string;
  readonly source: "library" | "yours";
}

/**
 * The note for one finding, or `undefined` when it gets none.
 *
 * `cards` are the report's cards, built from the same verification; a category with no card,
 * or whose card is not checked, gets no note. Any check that could not confirm what it found
 * gets a "Could not confirm" note before its facts are read. The note says whether it found
 * something, reassures, or could not confirm, so the page can mark it by what it says.
 */
export function verifiedNote(
  finding: NotedFinding,
  verification: Verification,
  cards: readonly CardView[],
): VerifiedNote | undefined {
  if (finding.source !== "library" || !Object.hasOwn(NOTE_RULES, finding.ruleId)) return undefined;
  const rule = NOTE_RULES[finding.ruleId] as NoteRule;
  const card =
    rule.category === "dependencies" ? undefined : cards.find((c) => c.category === rule.category);
  if (rule.category !== "dependencies" && (card === undefined || card.tone === "not-checked")) {
    return undefined;
  }
  const facts = factsFor(rule, verification);
  const note = (made: CardSentence, outcome: NoteOutcome): VerifiedNote => ({
    ruleId: finding.ruleId,
    category: rule.category,
    outcome,
    sentence: made,
  });

  // A dependency check that did not run has nothing to confirm or not.
  if (rule.category === "dependencies" && facts === undefined) return undefined;
  const unconfirmed = unconfirmedLine(rule, facts, card, verification);
  if (unconfirmed !== undefined) return note(unconfirmed, "could-not-confirm");

  const spec = NOTE_KINDS[rule.kind];
  const counts = readCounts(facts, spec.reads);
  if (counts === undefined) return undefined;
  // The Codex reading is limited and unverified: on a Codex scan no note reassures.
  const codex = verification.ranEvidence === "output-record";
  const made = sentence(spec.template, { ...counts, reassure: !codex });
  if (made === undefined) return undefined;
  // A note reassures when its reassuring clauses changed what it says.
  const plain = codex ? made : sentence(spec.template, { ...counts, reassure: false });
  const outcome: NoteOutcome = plain?.text === made.text ? "found" : "reassuring";
  // From Codex sessions, a count of commands that ran may include calls a hook blocked.
  return codex && spec.ran && /\d/.test(made.text)
    ? note({ template: made.template, text: `${made.text} ${CODEX_NOTE_TEXT}` }, outcome)
    : note(made, outcome);
}

/** The notes for `findings`, in their order, one per finding that gets one. */
export function verifiedNotes(
  findings: readonly NotedFinding[],
  verification: Verification,
  cards: readonly CardView[],
): VerifiedNote[] {
  return findings.flatMap((finding) => {
    const made = verifiedNote(finding, verification, cards);
    return made === undefined ? [] : [made];
  });
}
