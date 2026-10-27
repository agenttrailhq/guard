/**
 * The card builder for every category that has a check: the one registry the report reads.
 *
 * `CardBuilders` requires an entry for every category in `CategoryFactsMap`, so a check that
 * adds its category there does not compile until its card is added here, from its own file.
 *
 * Pure. No I/O.
 */

import type { CardBuilders } from "./cards.js";
import { COMMAND_CHECK_CARDS } from "./command-cards.js";
import { destructiveCard } from "./destructive.js";
import { lostWorkCard } from "./lost-work.js";
import { secretsCard } from "./secrets-card.js";
import { skippedChecksCard } from "./skipped.js";

/** The registry. One entry per checked category. */
export const CARD_BUILDERS: CardBuilders = {
  secrets: secretsCard,
  "skipped-checks": skippedChecksCard,
  "lost-work": lostWorkCard,
  destructive: destructiveCard,
  // The command checks' builders: tests, cloud, production infrastructure, unreviewed code and
  // egress, as many as exist.
  ...COMMAND_CHECK_CARDS,
};
