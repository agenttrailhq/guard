/**
 * What the report shows for verified results: one card per category, the headline, the fix
 * commands, and a note per guardrail — as view models built from check results.
 *
 * ── Every sentence comes from a template ─────────────────────────────────────
 * A card never carries hand-written prose. Each line is a `CardSentence`, made by
 * `sentence(template, facts)` from a `SentenceTemplate` that reads typed facts, and it names
 * the template it came from. A test can therefore check that every line on the page belongs to
 * a template whose facts are present, and a card can never claim something no check produced.
 *
 * ── Two kinds of fix command, kept apart ─────────────────────────────────────
 * A card's `fixes` are `FixShape`s: redacted command shapes (`git branch recovered/<name>
 * <sha>`) from templates, safe for the page and the JSON. The exact commands for this machine,
 * with real branch names and paths, are `LocalFix`es. They travel beside the verification,
 * never inside it, and are for the local fixes file only: a `LocalFix` refuses to be turned
 * into JSON, so a serializer that reaches one fails rather than writing it.
 *
 * ── The headline ─────────────────────────────────────────────────────────────
 * `pickHeadline` takes the cards' headline claims in a fixed priority order, each with a typed
 * basis. Only a category whose check found something can lead: a clean, not-checked or
 * could-not-check category never does, and nothing leads a Codex scan, whose reading is
 * limited and unverified.
 *
 * Pure. No I/O.
 */

import type { RanEvidence, Verification, VerifyCategory, VerifyStatus } from "./types.js";
import {
  type CategoryFactsMap,
  type CheckedCategory,
  type CheckedCategoryName,
  HIDING_FORMS,
  type HidingForm,
  VERIFY_CATEGORIES,
  VERIFY_STATUSES,
} from "./types.js";

// ── Sentences ─────────────────────────────────────────────────────────────────

/**
 * Turns typed facts into one sentence, or `undefined` when the facts do not support it. `id` is
 * unique across templates and names the sentence on the page.
 */
export interface SentenceTemplate<F> {
  readonly id: string;
  render(facts: F): string | undefined;
}

/** One line of a card, and the template it came from. */
export interface CardSentence {
  readonly template: string;
  readonly text: string;
}

/** The sentence `template` makes from `facts`, or `undefined` when it makes none. */
export function sentence<F>(template: SentenceTemplate<F>, facts: F): CardSentence | undefined {
  const text = template.render(facts);
  return text === undefined ? undefined : { template: template.id, text };
}

/** The sentences the templates make from `facts`, in template order, skipping those that make none. */
export function sentences<F>(templates: readonly SentenceTemplate<F>[], facts: F): CardSentence[] {
  const out: CardSentence[] = [];
  for (const template of templates) {
    const made = sentence(template, facts);
    if (made !== undefined) out.push(made);
  }
  return out;
}

// ── Cards ─────────────────────────────────────────────────────────────────────

/** A redacted fix command, for the page and the JSON. Built from a template, never from data. */
export interface FixShape {
  readonly shape: string;
}

/**
 * What a headline claim counts. Each leading category has exactly one, and a claim with any
 * other basis cannot lead: the cloud card may lead only with the count of IAM changes that
 * ran, never with its other cloud actions.
 */
export const HEADLINE_BASES = [
  "likely-real-credentials",
  "commits-on-main-without-checks",
  "recoverable-deleted-work",
  "iam-changes",
  "lowered-test-floors",
  "unguarded-recursive-deletes",
] as const;

/** One of `HEADLINE_BASES`. */
export type HeadlineBasis = (typeof HEADLINE_BASES)[number];

/** What may lead the report, from one card. */
export interface HeadlineClaim {
  /** What `count` counts. It must be the basis `HEADLINE_BASIS` names for the card's category. */
  readonly basis: HeadlineBasis;
  /**
   * The count the headline states, such as the number of likely-real credentials. A count of
   * commands that ran counts only result-backed runs (`isResultBackedRun` in `ran.ts`): never a
   * `may-run-written-file` call, never an `unknown`.
   */
  readonly count: number;
  /**
   * The claim rests on Codex `ran` counts (`ranEvidence: "output-record"`), which may include
   * calls a hook blocked. Such a claim is never the headline.
   */
  readonly restsOnCodexRan: boolean;
  /**
   * The count is read from the repository's own state, not from commands: `"git-state"` for the
   * commits on main without their checks (ancestry of the remote main branch) and the deleted
   * branches and stashes still recoverable (the object store). A command this reading could not
   * take apart, or output a session did not record, could only mean there are more, so such a
   * claim may lead even where its card could not confirm; the card still says so. Only those two
   * categories may carry it, and nothing leads a Codex scan.
   */
  readonly confirmedBy?: "git-state";
  readonly sentence: CardSentence;
}

/** The categories whose claim may be confirmed by git state. See `HeadlineClaim.confirmedBy`. */
export const GIT_STATE_CLAIMS: ReadonlySet<VerifyCategory> = new Set([
  "skipped-checks",
  "lost-work",
]);

/** Is this card's claim confirmed by git state, in a category whose claim may be? */
function confirmedByGitState(card: CardView): boolean {
  return card.headline?.confirmedBy === "git-state" && GIT_STATE_CLAIMS.has(card.category);
}

/**
 * What a card shows among the "Also checked on this machine" chips: a count, zero included, and
 * what it counts. A count of commands counts only commands that ran.
 */
export interface ChipClaim {
  readonly count: number;
  /** What the count is of, without the number: "production databases touched". */
  readonly label: CardSentence;
}

/** One category's card: what the report renders. */
export interface CardView {
  readonly category: VerifyCategory;
  /** The card's tone: act, review, clean, not-checked or could-not-check. */
  readonly tone: VerifyStatus;
  /** The raw match count. */
  readonly count: number;
  /** The raw count in words, when it is not a count of matches (secrets counts values). */
  readonly countLine?: CardSentence;
  /** "What checking found". */
  readonly found: readonly CardSentence[];
  /** "Now": the state on this machine today. */
  readonly now: readonly CardSentence[];
  /** "Fix" in words, shown before the command shapes, such as which step comes first. */
  readonly fixSteps?: readonly CardSentence[];
  /** Redacted fix command shapes. The exact commands are `LocalFix`es. */
  readonly fixes: readonly FixShape[];
  /** The card states Codex `ran` counts, which may include calls a hook blocked; say so. */
  readonly codexCaveat: boolean;
  /** What this card could put in the headline, if anything. */
  readonly headline?: HeadlineClaim;
  /** Its chip in "Also checked on this machine". Without one, the chip states the tone. */
  readonly chip?: ChipClaim;
  /** What its check read on this machine, from the check's own counts. */
  readonly read?: CardSentence;
  /** Why the card could not confirm what it reports, when it could not. Set by `cardsFor`. */
  readonly unconfirmed?: Unconfirmed;
}

/**
 * Why a card could not confirm what it reports, so it never reads clean or "none":
 *
 * - `hiding-forms`: calls that ran hold forms that run something this reading does not take
 *   apart (`HIDING_FORMS`), named by the check's shared `hidingForms` fact;
 * - `no-output`: the app records no command output, so no command could be confirmed as run,
 *   and a check of commands that ran found none for that reason only.
 */
export interface Unconfirmed {
  readonly reason: "hiding-forms" | "no-output";
  readonly forms: readonly HidingForm[];
  /**
   * The card still found something (its tone is act or review), so what it could not confirm is
   * whether there is more, not whether it is clean.
   */
  readonly found?: boolean;
}

/** What a card builder may know beyond its own category's result. */
export interface CardContext {
  readonly ranEvidence: RanEvidence;
}

/** Builds the card for one checked category from its result. */
export type ToCard<C extends CheckedCategoryName> = (
  result: CheckedCategory<CategoryFactsMap[C]>,
  context: CardContext,
) => CardView;

/**
 * A card builder for every category that has a check. Required, not optional: a category
 * added to `CategoryFactsMap` does not compile until its card exists.
 */
export type CardBuilders = { readonly [C in CheckedCategoryName]: ToCard<C> };

/** The one sentence on a card whose category has no check yet. */
export const NOT_CHECKED_SENTENCE: SentenceTemplate<unknown> = {
  id: "not-checked",
  render: () => "Not checked.",
};

/** The one sentence on a card whose check could not finish. */
export const COULD_NOT_CHECK_SENTENCE: SentenceTemplate<unknown> = {
  id: "could-not-check",
  render: () => "Could not be checked on this machine, so this is not a clean result.",
};

/**
 * How the page names a hiding form. Any form without a label here is named from its id, so a
 * form added to `HIDING_FORMS` is still said, never dropped.
 */
export const HIDING_FORM_LABELS: Readonly<Partial<Record<string, string>>> = {
  "shell-string": "a shell given a string to run",
  "find-exec": "find -exec",
  xargs: "xargs",
  "process-substitution": "process substitution",
  "command-substitution": "a command substitution",
  eval: "eval",
  "git-config": "git with config set on its command line or by an earlier command",
  "git-exec": "git with --exec or an external diff",
  "git-hook": "git after a hook was written",
  "unread-shell": "a shell this reading does not parse",
  "inline-code": "code run inline by an interpreter",
  "piped-script": "a script piped into a shell or interpreter",
  "unterminated-quote": "a quote left open",
  "unread-match": "a command its guardrails matched, in a form this check does not read",
};

/** A hiding form's name on the page: its label, or its id in words. */
export function hidingFormLabel(form: string): string {
  return HIDING_FORM_LABELS[form] ?? form.replace(/-/g, " ");
}

/** The first line of a card that could not confirm what it reports. */
export const UNCONFIRMED_SENTENCE: SentenceTemplate<Unconfirmed> = {
  id: "could-not-confirm",
  render: (u) =>
    u.reason === "no-output"
      ? "Could not confirm: these sessions record no command output, so a count of commands that ran is zero because nothing could be confirmed, not because nothing ran."
      : u.found === true
        ? `Could not confirm all of it: commands that ran, or may have run, here used ${u.forms.map(hidingFormLabel).join(", ")}, which can run commands this reading does not take apart, so there may be more than this card shows.`
        : `Could not confirm: commands that ran, or may have run, here used ${u.forms.map(hidingFormLabel).join(", ")}, which can run commands this reading does not take apart, so this is not a clean result.`,
};

/** The card for a category with no check yet. */
export function notCheckedCard(category: VerifyCategory): CardView {
  return {
    category,
    tone: "not-checked",
    count: 0,
    found: sentences([NOT_CHECKED_SENTENCE], undefined),
    now: [],
    fixes: [],
    codexCaveat: false,
  };
}

/** The card for a category whose check could not finish. */
export function couldNotCheckCard(category: VerifyCategory, count: number): CardView {
  return {
    category,
    tone: "could-not-check",
    count,
    found: sentences([COULD_NOT_CHECK_SENTENCE], undefined),
    now: [],
    fixes: [],
    codexCaveat: false,
  };
}

/** The order of the tones on the page: act first, then review, then clean, then the rest. */
export const TONE_ORDER: readonly VerifyStatus[] = [
  "act",
  "review",
  "clean",
  "could-not-check",
  "not-checked",
];

/** Cards in page order: by tone, then in category order. */
export function orderCards(cards: readonly CardView[]): CardView[] {
  return [...cards].sort(
    (a, b) =>
      TONE_ORDER.indexOf(a.tone) - TONE_ORDER.indexOf(b.tone) ||
      VERIFY_CATEGORIES.indexOf(a.category) - VERIFY_CATEGORIES.indexOf(b.category),
  );
}

/** A category's result, as any category's. */
type AnyResult = {
  readonly status: VerifyStatus;
  readonly matches?: number;
  readonly facts?: unknown;
};

/** The registered statuses, so a builder's stray tone never reaches the page. */
const KNOWN_TONES: ReadonlySet<string> = new Set(VERIFY_STATUSES);

/** The hiding forms a check's facts name under the shared `hidingForms` key. */
function hidingFormsIn(facts: unknown): HidingForm[] {
  if (facts === null || typeof facts !== "object") return [];
  const named = (facts as { readonly hidingForms?: unknown }).hidingForms;
  if (!Array.isArray(named)) return [];
  return HIDING_FORMS.filter((form) => named.includes(form));
}

/** Categories whose check reads text, not commands that ran: no-output does not touch them. */
const READS_TEXT: ReadonlySet<VerifyCategory> = new Set(["secrets"]);

/**
 * Why a category's result could not confirm what it reports, or `undefined` when it could:
 * - its facts name hiding forms (`hiding-forms`);
 * - the app records no command output, the category is a check of commands that ran rather
 *   than of text, and the result would read clean (`no-output`).
 */
export function unconfirmedOf(
  category: VerifyCategory,
  status: string,
  facts: unknown,
  resultsRecorded: boolean,
): Unconfirmed | undefined {
  const forms = hidingFormsIn(facts);
  if (forms.length > 0) return { reason: "hiding-forms", forms };
  if (!resultsRecorded && !READS_TEXT.has(category) && status === "clean") {
    return { reason: "no-output", forms: [] };
  }
  return undefined;
}

/**
 * The status a category's result may be shown with, anywhere: the card, the report's data block
 * and `--json`. Computed here once for all of them. A status that is not a known one becomes
 * could-not-check, and so does a `clean` that could not confirm (`unconfirmedOf`): nothing reads
 * clean where commands that could hide what it looks for ran, or where no output was recorded.
 */
export function honestStatus(
  category: VerifyCategory,
  status: string,
  facts: unknown,
  resultsRecorded: boolean,
): VerifyStatus {
  const known: VerifyStatus = KNOWN_TONES.has(status)
    ? (status as VerifyStatus)
    : "could-not-check";
  return known === "clean" && unconfirmedOf(category, known, facts, resultsRecorded) !== undefined
    ? "could-not-check"
    : known;
}

/**
 * A built card, made honest about what it could confirm:
 * - its tone is `honestStatus` of the built tone: a tone that is not a known status becomes
 *   could-not-check, and so does a clean one that could not confirm;
 * - a check whose facts name hiding forms could not confirm, and never reads clean;
 * - on an app that records no command output, a check of commands that ran that would read
 *   clean could not confirm instead;
 * - a could-not-check card leads with why: could not confirm, or could not be checked.
 */
function confirmedCard(built: CardView, facts: unknown, verification: Verification): CardView {
  const recorded = verification.resultsRecorded;
  const tone: VerifyStatus = KNOWN_TONES.has(built.tone) ? built.tone : "could-not-check";
  const found = unconfirmedOf(built.category, tone, facts, recorded);
  // A card that still found something could not confirm whether there is more, not whether it is
  // clean, and says so.
  const unconfirmed: Unconfirmed | undefined =
    found === undefined
      ? undefined
      : tone === "act" || tone === "review"
        ? { ...found, found: true }
        : found;
  const finalTone = honestStatus(built.category, tone, facts, recorded);
  const lead =
    unconfirmed !== undefined
      ? sentences([UNCONFIRMED_SENTENCE], unconfirmed)
      : finalTone === "could-not-check"
        ? sentences([COULD_NOT_CHECK_SENTENCE], undefined)
        : [];
  return {
    ...built,
    tone: finalTone,
    found: [
      ...lead,
      ...built.found.filter((line) => line.template !== COULD_NOT_CHECK_SENTENCE.id),
    ],
    ...(unconfirmed === undefined ? {} : { unconfirmed }),
  };
}

/**
 * Every category's card, in page order. A not-checked category gets its default card. A
 * checked category goes to its builder, a could-not-check one too when it carries facts, so
 * the card can say what did and did not finish; with no facts, or no builder, it gets the
 * default could-not-check card, never a clean one. Every built card then passes through
 * `confirmedCard`.
 */
export function cardsFor(verification: Verification, builders: CardBuilders): CardView[] {
  const context: CardContext = { ranEvidence: verification.ranEvidence };
  const cards = VERIFY_CATEGORIES.map((category): CardView => {
    const result = verification.categories[category] as AnyResult;
    if (result.status === "not-checked") return notCheckedCard(category);
    const build = (builders as Readonly<Record<string, ToCard<CheckedCategoryName>>>)[category];
    if (build === undefined || result.facts === undefined) {
      // A result with no facts, or with facts and no builder, cannot be shown truthfully, and
      // is not clean.
      return couldNotCheckCard(category, result.matches ?? 0);
    }
    const built = build(result as CheckedCategory<CategoryFactsMap[CheckedCategoryName]>, context);
    return confirmedCard(built, result.facts, verification);
  });
  return orderCards(cards);
}

// ── The headline ──────────────────────────────────────────────────────────────

/**
 * The categories that may lead the report, highest priority first:
 * real credentials left in transcripts; commits that reached main without their checks;
 * deleted work that is still recoverable; IAM changes; lowered test floors; unguarded recursive
 * deletes. The other three categories never lead.
 */
export const HEADLINE_ORDER = [
  "secrets",
  "skipped-checks",
  "lost-work",
  "cloud",
  "tests",
  "destructive",
] as const satisfies readonly VerifyCategory[];

/** A category that may lead. */
type HeadlineCategory = (typeof HEADLINE_ORDER)[number];

/**
 * The tone each category may lead from. A finding leads only when its check found something
 * (`act`). Cloud changes cannot be confirmed locally, so the cloud card is always `review`, and
 * it leads only from `review`, saying that IAM changes ran and need review — never that harm
 * was done.
 */
const HEADLINE_TONES: Readonly<Record<HeadlineCategory, VerifyStatus>> = {
  secrets: "act",
  "skipped-checks": "act",
  "lost-work": "act",
  cloud: "review",
  tests: "act",
  destructive: "act",
};

/** The one basis each leading category's claim may have. */
export const HEADLINE_BASIS: Readonly<Record<HeadlineCategory, HeadlineBasis>> = {
  secrets: "likely-real-credentials",
  "skipped-checks": "commits-on-main-without-checks",
  "lost-work": "recoverable-deleted-work",
  cloud: "iam-changes",
  tests: "lowered-test-floors",
  destructive: "unguarded-recursive-deletes",
};

/**
 * A count that may be stated: a whole number above zero. Not a fraction, NaN, Infinity or a
 * value of another type, which a type-violating builder could pass and which would print as a
 * count that means nothing.
 */
export function isPositiveCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * The card whose claim leads the report, or `undefined` for the totals headline: the first of
 * `leadingCards`, so the headline and the share post follow one rule.
 */
export function pickHeadline(
  cards: readonly CardView[],
  context: CardContext,
): CardView | undefined {
  return leadingCards(cards, context)[0];
}

/**
 * Every card whose claim may lead, highest priority first. `pickHeadline` takes the first; the
 * share post states them all, as many as fit.
 *
 * Nothing leads a Codex scan (`ranEvidence: "output-record"`): Codex reading is limited and
 * unverified, so every finding of such a scan is Codex-only. Otherwise a claim may lead only
 * when its category is in `HEADLINE_ORDER`, its tone is the one that category may lead from,
 * its basis is the one that category may lead with, its count is a whole number above zero
 * (`isPositiveCount`), it does not rest
 * on Codex `ran` counts, and its card confirmed what it reports: a card that could not
 * confirm (`unconfirmed`) never leads, whatever its tone. The one exception is a count confirmed
 * by git state (`HeadlineClaim.confirmedBy`), in the categories that may carry one: what the
 * card could not confirm could only mean there are more, so it may lead, and the card still says
 * it could not confirm everything.
 */
export function leadingCards(cards: readonly CardView[], context: CardContext): CardView[] {
  if (context.ranEvidence === "output-record") return [];
  return HEADLINE_ORDER.flatMap((category) => {
    const card = cards.find(
      (c) =>
        c.category === category &&
        c.headline !== undefined &&
        c.tone === HEADLINE_TONES[category] &&
        c.headline.basis === HEADLINE_BASIS[category] &&
        isPositiveCount(c.headline.count) &&
        !c.headline.restsOnCodexRan &&
        (c.unconfirmed === undefined || confirmedByGitState(c)),
    );
    return card === undefined ? [] : [card];
  });
}

// ── Exact fix commands: the local fixes file only ────────────────────────────

/** Marks a `LocalFix`. */
const LOCAL_ONLY: unique symbol = Symbol("local-only");

/**
 * An exact fix command for this machine, with real branch names and paths. For the local
 * `0600` fixes file and nothing else: never part of `Verification`, `ScanResult`, the JSON or
 * the page. Made only by `localFixCommand`.
 */
export interface LocalFix {
  readonly [LOCAL_ONLY]: true;
  readonly category: VerifyCategory;
  /** The exact command. */
  readonly command: string;
  /** Throws: a local fix is never serialized. */
  toJSON(): never;
}

/** The error a serializer meets when it reaches a `LocalFix`. */
export const LOCAL_FIX_SERIALIZED =
  "a local fix command belongs in the local fixes file only, and is never serialized";

/**
 * A `LocalFix` holding `command` as written. Internal: every fix is built by `localFixCommand`,
 * which quotes each part and refuses an unsafe one.
 */
function localFix(category: VerifyCategory, command: string): LocalFix {
  return Object.freeze({
    [LOCAL_ONLY]: true as const,
    category,
    command,
    toJSON(): never {
      throw new Error(LOCAL_FIX_SERIALIZED);
    },
  });
}

/**
 * One part of an exact command: a literal from code (`"git"`, `"branch"`), or a value taken
 * from what a check read, by kind:
 *
 * - `sha`: a commit id: 7 to 40 hex digits, or a full 64-digit SHA-256 id.
 * - `branch`: a branch name that `git check-ref-format --branch` accepts, within the safe set.
 * - `repoPath`: a path inside a repository: relative, with no `..`, within the safe set.
 * - `ref`: any other value from data (a resource name, an absolute path), within the safe set.
 *
 * The safe set is letters, digits and `_ @ % + = : , . / -`: no shell syntax, no space, no
 * quote. No value may start with `-`, where it would read as an option.
 */
export type CommandPart =
  | string
  | { readonly sha: string }
  | { readonly branch: string }
  | { readonly repoPath: string }
  | { readonly ref: string };

/** The characters a value from data may hold: no shell syntax, no space, no quote. */
const SAFE_REF = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** A commit id. */
const SHA = /^(?:[0-9a-fA-F]{7,40}|[0-9a-fA-F]{64})$/;

/**
 * A branch name `git check-ref-format --branch` accepts, within the safe set: no `:` (which the
 * format refuses), no `..`, no `@{`, not `@` or `HEAD`, no `//`, no leading or trailing `/`, no
 * component that starts with `.` or ends with `.lock`, and no trailing `.`.
 */
function isSafeBranch(name: string): boolean {
  if (!SAFE_REF.test(name) || name.includes(":")) return false;
  if (name === "@" || name === "HEAD" || name.includes("..") || name.includes("@{")) return false;
  if (name.includes("//") || name.startsWith("/") || name.endsWith("/")) return false;
  if (name.endsWith(".")) return false;
  return name.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}

/** A path inside a repository: relative, no `..`, no drive or `:`, within the safe set. */
function isSafeRepoPath(path: string): boolean {
  return (
    SAFE_REF.test(path) && !path.includes(":") && !path.startsWith("/") && !path.includes("..")
  );
}

/** The value of a data part, or `undefined` when it is not safe for its kind. */
function safeValue(part: Exclude<CommandPart, string>): string | undefined {
  let value: string;
  let safe: boolean;
  if ("sha" in part) {
    value = part.sha;
    safe = SHA.test(value);
  } else if ("branch" in part) {
    value = part.branch;
    safe = isSafeBranch(value);
  } else if ("repoPath" in part) {
    value = part.repoPath;
    safe = isSafeRepoPath(value);
  } else {
    value = part.ref;
    safe = SAFE_REF.test(value);
  }
  return safe && !value.startsWith("-") ? value : undefined;
}

/** What a fix becomes when a ref in it could not be made safe. It carries no command text. */
export interface UnsafeFix {
  readonly category: VerifyCategory;
  readonly unsafe: true;
  readonly note: "could not make a safe command";
}

/** Quote one argument for a POSIX shell. */
function quoteArgument(argument: string): string {
  return `'${argument.replace(/'/g, "'\\''")}'`;
}

/**
 * An exact command for the local fixes file, built from parts, every one of them quoted. A data
 * part that is not safe for its kind (see `CommandPart`), empty, or starting with `-` makes the
 * whole fix an `UnsafeFix` instead: the command is not written at all, and the file says it
 * could not make a safe command. Every fix command goes through here.
 */
export function localFixCommand(
  category: VerifyCategory,
  parts: readonly CommandPart[],
): LocalFix | UnsafeFix {
  const argv: string[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      argv.push(quoteArgument(part));
      continue;
    }
    const value = safeValue(part);
    if (value === undefined) {
      return { category, unsafe: true, note: "could not make a safe command" };
    }
    argv.push(quoteArgument(value));
  }
  return localFix(category, argv.join(" "));
}

/** Is `value` a `LocalFix`? */
export function isLocalFix(value: unknown): value is LocalFix {
  return typeof value === "object" && value !== null && LOCAL_ONLY in value;
}

// ── The per-guardrail note ───────────────────────────────────────────────────

/**
 * Where a note's facts come from: a category's check, or the dependency check, which has no
 * card of its own and keeps its facts beside the categories.
 */
export type NoteSource = VerifyCategory | "dependencies";

/**
 * What a note says, for how the page marks it:
 * - `found`: counts of what the check found;
 * - `reassuring`: it says, in part or whole, that something is fine;
 * - `could-not-confirm`: the check could not confirm it.
 */
export const NOTE_OUTCOMES = ["found", "reassuring", "could-not-confirm"] as const;

/** One of `NOTE_OUTCOMES`. */
export type NoteOutcome = (typeof NOTE_OUTCOMES)[number];

/**
 * The one-line note under a guardrail in the findings list, from the check that covers its
 * rule. A rule no check covers gets no note. See `notes.ts`.
 */
export interface VerifiedNote {
  /** The guardrail's id, as the finding carries it. */
  readonly ruleId: string;
  readonly category: NoteSource;
  readonly outcome: NoteOutcome;
  readonly sentence: CardSentence;
}
