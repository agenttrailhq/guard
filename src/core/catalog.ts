/**
 * The catalog the guard ships — `@agenttrail/guardrails`, 56 rules.
 *
 * Every call site reads `deps.catalog ?? <this catalog>`, so tests inject their own.
 *
 * ── Why the `/guardrails` SUBPATH and not the package root ───────────────────────
 *
 * The package root re-exports the guardrails schema, which value-imports zod.
 * `built-artifact.test.ts` asserts that this bundle contains no `ZodError` and
 * no `ZodType`: the hook is a fresh Node process on every tool call and cannot
 * afford to parse a validator it never calls.
 *
 * Importing the root would put zod here AND run 56 `safeParse` calls per tool call to
 * re-check data that has not changed since publish. In a cold `node` process, an empty
 * process takes about 20ms and a root import that validates all 56 rules about 40ms,
 * so the subpath saves about 20ms a call — five times the cost of compiling every
 * rule's regexes and globs (3.8ms).
 *
 * ── The type assertion, and why it holds ────────────────────────────────────
 *
 * `Rule` (guardrails) and `GuardRule` (here) are the same shape modulo two
 * things: `Rule` also carries `fixtures`, which the guard never reads, and its
 * `severity`/`defaultAction` are string-literal unions where `GuardRule` widens
 * `severity` to `string`. Structural assignment therefore holds.
 */

import { RULES } from "@agenttrail/guardrails/guardrails";
import type { GuardRule } from "./types.js";

/**
 * Every rule the guard enforces out of the box.
 *
 * Frozen at install: the corpus is BUNDLED, not fetched, so updates arrive only
 * when the package updates. There is no network on this path and
 * there is not going to be one.
 */
export const SHIPPED_CATALOG: readonly GuardRule[] = RULES;
