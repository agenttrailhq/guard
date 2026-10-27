/**
 * The card builders for the checks that read what commands and edits did. The report's
 * builder registry takes these beside the other categories' builders.
 *
 * Pure. No I/O.
 */

import type { ToCard } from "./cards.js";
import { cloudCard } from "./cloud.js";
import { egressCard } from "./egress.js";
import { prodInfraCard } from "./prod-infra.js";
import { testsCard } from "./tests.js";
import { unreviewedCard } from "./unreviewed.js";

/** The categories these builders cover. */
type CommandCategory = "tests" | "cloud" | "prod-infra" | "unreviewed" | "egress";

/** One builder per category these checks fill. */
export const COMMAND_CHECK_CARDS: { readonly [C in CommandCategory]: ToCard<C> } = {
  tests: testsCard,
  cloud: cloudCard,
  "prod-infra": prodInfraCard,
  unreviewed: unreviewedCard,
  egress: egressCard,
};
