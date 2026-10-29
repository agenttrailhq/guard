/**
 * Small pieces the cards of the test, cloud, production, unreviewed-code and egress checks
 * share: the card's "Fix" sentences and its "Also checked" chip, and count wording.
 *
 * Pure. No I/O.
 */

import type { CardContext, CardSentence, CardView, HeadlineClaim } from "./cards.js";

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

/**
 * `count` matches, as "more" after the lines above it stated other matches (`others`), and
 * plainly when they stated none: "1 more match", or "1 match".
 */
export function moreMatches(count: number, others: boolean): string {
  return others ? counted(count, "more match", "more matches") : counted(count, "match", "matches");
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
