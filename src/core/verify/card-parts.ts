/**
 * Small pieces the cards of the test, cloud, production, unreviewed-code and egress checks
 * share: the card's "Fix" sentences and its "Also checked" chip, and count wording.
 *
 * Pure. No I/O.
 */

import type {
  CardContext,
  CardSentence,
  CardView,
  HeadlineClaim,
  SentenceTemplate,
} from "./cards.js";

/** The chip a card offers to "Also checked on this machine": a count and what it counts. */
export interface CardChip {
  readonly count: number;
  /** What is counted, worded for `count` but without the number, which the chip shows. */
  readonly label: CardSentence;
}

/**
 * What a headline claim from these checks counts. The report's headline order allows each
 * category one basis: the cloud card may lead only with IAM changes that ran, the test card only
 * with lowered test floors. The other checks never lead.
 */
export type ClaimBasis = "iam-changes" | "lowered-test-floors";

/** A card with its "Fix" sentences, its chip, and the basis of its headline claim. */
export type FullCard = Omit<CardView, "headline"> & {
  readonly headline?: HeadlineClaim & { readonly basis: ClaimBasis };
  /** "Fix", in sentences, beside the redacted command shapes in `fixes`. */
  readonly fixSteps?: readonly CardSentence[];
  readonly chip?: CardChip;
};

/** `count` with the singular or plural noun. */
export function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The singular or plural noun alone, for a chip whose number is shown apart. */
export function noun(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** Does a `ran` count on this card rest on Codex's output records? */
export function restsOnCodex(context: CardContext): boolean {
  return context.ranEvidence === "output-record";
}

/** Most exact fix commands one check writes to the local fixes file. */
export const MAX_LOCAL_FIXES = 50;

/**
 * The line a card shows when calls that ran, or may have run, could have run other commands its
 * check does not read. A call with no recorded result may have run, so it counts too. Such a
 * card never says that nothing ran, and never reads clean.
 */
export function couldHideTemplate<F extends { readonly couldHide: number }>(
  id: string,
): SentenceTemplate<F> {
  return {
    id,
    render: (f) =>
      f.couldHide > 0
        ? `${counted(f.couldHide, "command that ran, or may have run,", "commands that ran, or may have run,")} could run other commands this check does not read (code given to a shell or an interpreter, a script piped into one, find -exec, xargs, eval, a substitution, git config, exec or hooks, a quote left open, a command of its kind behind a program this check does not read, or a shell this reading does not parse), so it could not confirm it saw everything.`
        : undefined,
  };
}
