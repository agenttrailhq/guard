/**
 * The share post's verified counts: one phrase per headline basis, made from the claim's count
 * and nothing else.
 *
 * A phrase never carries a card's own sentence, a name, a path, a command, a project name or a
 * guardrail title: the only thing that varies is the number, so a post can say no more than
 * "how many". The cloud phrase says IAM changes ran and need a review, never that harm was done.
 *
 * Pure. No I/O.
 */

import { formatCount } from "../tokens.js";
import { type CardContext, type CardView, type HeadlineBasis, leadingCards } from "./cards.js";

/** Each basis as the post states it, for one and for many. */
const SHARE_PHRASES: Readonly<Record<HeadlineBasis, readonly [string, string]>> = {
  "likely-real-credentials": [
    "likely-real credential left in its transcripts",
    "likely-real credentials left in its transcripts",
  ],
  "commits-on-main-without-checks": [
    "commit shipped to main without its checks",
    "commits shipped to main without their checks",
  ],
  "recoverable-deleted-work": [
    "piece of deleted work still recoverable",
    "pieces of deleted work still recoverable",
  ],
  "iam-changes": ["IAM change ran and needs a review", "IAM changes ran and need a review"],
  "lowered-test-floors": ["lowered test floor", "lowered test floors"],
  "unguarded-recursive-deletes": ["unguarded recursive delete", "unguarded recursive deletes"],
};

/** One verified count as the post states it. */
export function sharePhrase(basis: HeadlineBasis, count: number): string {
  const [one, many] = SHARE_PHRASES[basis];
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

/**
 * The verified counts a post may state, highest priority first: every claim that may lead the
 * page (`leadingCards`: result-backed, not clean, not could-not-check, never on a Codex scan),
 * less any card that could not confirm what it reports.
 */
export function shareCounts(cards: readonly CardView[], context: CardContext): string[] {
  return leadingCards(cards, context)
    .filter((card) => card.unconfirmed === undefined)
    .flatMap((card) =>
      card.headline === undefined ? [] : [sharePhrase(card.headline.basis, card.headline.count)],
    );
}
