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
  VERIFY_CATEGORIES,
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
  readonly sentence: CardSentence;
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
  render: () => "Not checked yet.",
};

/** The one sentence on a card whose check could not finish. */
export const COULD_NOT_CHECK_SENTENCE: SentenceTemplate<unknown> = {
  id: "could-not-check",
  render: () => "Could not be checked on this machine, so this is not a clean result.",
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

/**
 * Every category's card, in page order. A not-checked or could-not-check category gets its
 * default card; every other category goes to its builder.
 */
export function cardsFor(verification: Verification, builders: CardBuilders): CardView[] {
  const context: CardContext = { ranEvidence: verification.ranEvidence };
  const cards = VERIFY_CATEGORIES.map((category): CardView => {
    const result = verification.categories[category] as AnyResult;
    if (result.status === "not-checked") return notCheckedCard(category);
    if (result.status === "could-not-check") {
      return couldNotCheckCard(category, result.matches ?? 0);
    }
    const build = (builders as Readonly<Record<string, ToCard<CheckedCategoryName>>>)[category];
    if (build === undefined || result.facts === undefined) {
      // A result with facts and no builder cannot be shown truthfully, and is not clean.
      return couldNotCheckCard(category, result.matches ?? 0);
    }
    return build(result as CheckedCategory<CategoryFactsMap[CheckedCategoryName]>, context);
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
 * The card whose claim leads the report, or `undefined` for the totals headline.
 *
 * Nothing leads a Codex scan (`ranEvidence: "output-record"`): Codex reading is limited and
 * unverified, so every finding of such a scan is Codex-only. Otherwise a claim leads only when
 * its category is in `HEADLINE_ORDER`, its tone is the one that category may lead from, its
 * basis is the one that category may lead with, its count is above zero and it does not rest
 * on Codex `ran` counts. Among those, the highest priority wins.
 */
export function pickHeadline(
  cards: readonly CardView[],
  context: CardContext,
): CardView | undefined {
  if (context.ranEvidence === "output-record") return undefined;
  for (const category of HEADLINE_ORDER) {
    const card = cards.find(
      (c) =>
        c.category === category &&
        c.headline !== undefined &&
        c.tone === HEADLINE_TONES[category] &&
        c.headline.basis === HEADLINE_BASIS[category] &&
        c.headline.count > 0 &&
        !c.headline.restsOnCodexRan,
    );
    if (card !== undefined) return card;
  }
  return undefined;
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
 * - `sha`: a commit id, 7 to 40 hex digits.
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
const SHA = /^[0-9a-fA-F]{7,40}$/;

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
 * The one-line note under a guardrail in the findings list, from the check that covers its
 * rule. A rule no check covers gets no note.
 */
export interface VerifiedNote {
  /** The guardrail's id, as the finding carries it. */
  readonly ruleId: string;
  readonly category: VerifyCategory;
  readonly sentence: CardSentence;
}
