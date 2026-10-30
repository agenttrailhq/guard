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

/** Each basis as a line of the post states it, after its count, for one and for many. */
const SHARE_PHRASES: Readonly<Record<HeadlineBasis, readonly [string, string]>> = {
  "likely-real-credentials": [
    "real credential left in its transcripts",
    "real credentials left in its transcripts",
  ],
  "commits-on-main-without-checks": [
    "commit shipped without its checks",
    "commits shipped without their checks",
  ],
  "recoverable-deleted-work": [
    "piece of deleted work it could still bring back",
    "pieces of deleted work it could still bring back",
  ],
  "iam-changes": ["IAM change that needs a review", "IAM changes that need a review"],
  "lowered-test-floors": ["test floor it lowered", "test floors it lowered"],
  "unguarded-recursive-deletes": [
    "recursive delete with nothing guarding it",
    "recursive deletes with nothing guarding them",
  ],
};

/** One verified count as the post states it. */
export function sharePhrase(basis: HeadlineBasis, count: number): string {
  const [one, many] = SHARE_PHRASES[basis];
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

/**
 * The verified counts a post may state, highest priority first: every claim that may lead the
 * page (`leadingCards`: result-backed, not clean, not could-not-check, never on a Codex scan,
 * and confirmed, except a skipped-checks or lost-work count read from git state, which may lead
 * where its card could not confirm), the same rule the headline follows.
 */
export function shareCounts(cards: readonly CardView[], context: CardContext): string[] {
  return leadingCards(cards, context).flatMap((card) =>
    card.headline === undefined ? [] : [sharePhrase(card.headline.basis, card.headline.count)],
  );
}
