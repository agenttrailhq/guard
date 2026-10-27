/**
 * Small helpers the git-backed cards share for their sentences, and the state every check
 * needs: the call log, the repository probe, and where scratch folders are.
 *
 * Pure, apart from the probe it carries.
 */

import { formatCount } from "../tokens.js";
import {
  type CardContext,
  type CardSentence,
  type CommandPart,
  isLocalFix,
  type LocalFix,
  localFixCommand,
  type SentenceTemplate,
  sentences,
  type UnsafeFix,
} from "./cards.js";
import type { RepoProbe } from "./repo-probe.js";
import type { CallLog } from "./shell-calls.js";
import type { RunTally, VerifyCategory, VerifyStatus } from "./types.js";

/** `n` and a noun, with the noun's plural when `n` is not 1. */
export function counted(n: number, singular: string, plural = `${singular}s`): string {
  return `${formatCount(n)} ${n === 1 ? singular : plural}`;
}

/** `was` or `were`, for `n`. */
export function was(n: number): string {
  return n === 1 ? "was" : "were";
}

/** `is` or `are`, for `n`. */
export function is(n: number): string {
  return n === 1 ? "is" : "are";
}

/** Calls of a tally, all states. */
export function callsIn(tally: RunTally): number {
  return tally.ran + tally.mentioned + tally.unknown;
}

/** The tallies added together. */
export function addTallies(...tallies: readonly RunTally[]): RunTally {
  const sum = { ran: 0, mentioned: 0, unknown: 0 };
  for (const tally of tallies) {
    sum.ran += tally.ran;
    sum.mentioned += tally.mentioned;
    sum.unknown += tally.unknown;
  }
  return sum;
}

/**
 * A check's status from what it found: `act` before `review`, and either before anything it
 * could not check. A check with something it could not check, and nothing to act on or review,
 * is `could-not-check`, never `clean`.
 */
export function statusOf(found: {
  readonly act: boolean;
  readonly review: boolean;
  readonly incomplete: boolean;
  readonly sessions: number;
}): VerifyStatus {
  if (found.sessions === 0) return "not-checked";
  if (found.act) return "act";
  if (found.review) return "review";
  if (found.incomplete) return "could-not-check";
  return "clean";
}

/** Does a card state a Codex `ran` count, which may include calls a hook blocked? */
export function codexCaveat(context: CardContext, ran: number): boolean {
  return context.ranEvidence === "output-record" && ran > 0;
}

/** How far a Codex reading goes, said on every git-backed card of a Codex scan. */
const CODEX_LIMITED =
  "The Codex reading is limited and unverified: it is tested only on synthetic sessions built from Codex's documented rollout format, a Codex call counted as ran may be one a hook blocked, and ids a Codex command printed are not identified.";

/** The template for a category's Codex line. */
export function codexLimitedTemplate<F>(category: VerifyCategory): SentenceTemplate<F> {
  return { id: `${category}.codex-limited`, render: () => CODEX_LIMITED };
}

/** The Codex line, on a Codex scan only. */
export function codexLines<F>(
  template: SentenceTemplate<F>,
  context: CardContext,
  facts: F,
): CardSentence[] {
  return context.ranEvidence === "output-record" ? sentences([template], facts) : [];
}

/**
 * The card's "Also checked on this machine" chip, and its Fix in words: the same two optional
 * fields the page's `CardView` carries as `chip` and `fixSteps`. Both come from templates.
 */
export interface CardExtras {
  readonly chip?: { readonly count: number; readonly label: CardSentence };
  readonly fixSteps?: readonly CardSentence[];
}

/** A card's chip, and its fix steps when any template makes one. */
export function cardExtras(
  chip: { readonly count: number; readonly label: CardSentence | undefined },
  fixSteps: readonly CardSentence[],
): CardExtras {
  return {
    ...(chip.label === undefined ? {} : { chip: { count: chip.count, label: chip.label } }),
    ...(fixSteps.length === 0 ? {} : { fixSteps }),
  };
}

/**
 * The exact fix commands one check makes, each built from quoted parts by `localFixCommand`.
 * A command with a part that is not safe for its kind is not made: it is kept as an
 * `UnsafeFix`, counted, and reported with its note ("could not make a safe command").
 */
export class FixList {
  readonly made: LocalFix[] = [];
  readonly unsafe: UnsafeFix[] = [];
  readonly #category: VerifyCategory;

  constructor(category: VerifyCategory) {
    this.#category = category;
  }

  /** Make one command from `parts`, or keep it as unsafe. */
  add(parts: readonly CommandPart[]): void {
    const fix = localFixCommand(this.#category, parts);
    if (isLocalFix(fix)) this.made.push(fix);
    else this.unsafe.push(fix);
  }
}

/** The note on a card that left fixes out: the commands could not be made safe. */
export function unsafeFixLine(n: number): string | undefined {
  return n > 0
    ? `Could not make a safe command for ${counted(n, "fix", "fixes")}: a name or path in ${n === 1 ? "it" : "them"} holds characters a command cannot carry safely, so the local fixes file lists ${n === 1 ? "it" : "them"} as could not make a safe command, with no command.`
    : undefined;
}

/** Most items one check asks the repositories about. Past it, the rest are could-not-check. */
export const MAX_PROBED_ITEMS = 500;

/** Folders whose contents are scratch on every machine. */
export const TEMP_ROOTS: readonly string[] = [
  "/tmp",
  "/private/tmp",
  "/var/tmp",
  "/private/var/tmp",
  "/var/folders",
  "/private/var/folders",
  "/dev/shm",
];

/** What every git-backed check runs with. */
export interface GitCheckContext {
  readonly log: CallLog;
  readonly probe: RepoProbe;
  /** Folders whose contents are scratch. `TEMP_ROOTS` unless a test sets its own. */
  readonly scratchRoots: readonly string[];
}

/** Is `path` inside one of `roots`, or one of them? */
export function isUnder(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const base = root.replace(/[\\/]+$/, "");
    return path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}\\`);
  });
}
