/**
 * Reading `~/.agenttrail/guard/guardrails.json` FOR THE HOOK. Structural, zero zod.
 *
 * ── Why this is a separate module from `user-rules.ts`, and it is structural ─
 * `user-rules.ts` value-imports `parsePolicyPredicate`, which is zod.
 * `built-artifact.test.ts` asserts the built hook bundle contains no `ZodError` and no
 * `ZodType` — so importing `loadUserRules` from `hook.ts` would not merely cost bytes,
 * it would RED AN EXISTING TEST. Putting this function in that file and relying on
 * tree-shaking to drop the other one would be betting the fence on esbuild eliminating
 * a module whose top level builds zod schemas, which it cannot.
 *
 * So the split is by import graph, not by taste: this module imports nothing but types,
 * and it is the only one the hook reaches.
 *
 * ── Why the hook needs it at all ─────────────────────────────────────────────
 * `loadUserRules` once had exactly one caller — `status.ts`. `init` seeded
 * `guardrails.json`, `status` counted it and printed "(N of them yours)", the README
 * documented it, and **the hook never read it**, so a rule a user wrote enforced
 * nothing. A tool that reports success and does nothing is the failure this package
 * exists to prevent; it had it in its own rule surface.
 *
 * ── The invariant, and which way round it runs ───────────────────────────────
 * **Everything `loadUserRules` accepts, this admits.** `guardrails add` validates with the
 * strict one, so anything it writes must be something the hook actually loads —
 * otherwise "Added." is followed by silent non-enforcement.
 *
 * The converse is deliberately NOT required. A hand-edited rule this admits and the
 * strict validator rejects is loaded by the hook and reported by `status` — running,
 * and not vouched for. `status` prints the difference rather than picking one of the
 * two numbers. `user-rules.test.ts` pins the direction as a property over a shared
 * corpus, because a one-directional invariant with no test is how two validators drift.
 *
 * ── What it does NOT check ───────────────────────────────────────────────────
 * The predicate. `compileCatalog` hands each rule to `compilePolicy` inside a
 * `try/catch` that skips on a throw, so a rule whose `match` cannot compile is dropped
 * there — one bad rule never disabling the other 55. Validating the predicate here
 * would mean shipping the validator, which is the thing this module exists to avoid.
 */

import type { Match } from "../engine/policy-predicate.js";
import type { GuardAction, GuardRule } from "./types.js";

/** The three stored spellings. `ask` is the CLI verb, never what is on disk. */
const VALID_ACTIONS: ReadonlySet<string> = new Set(["block", "require_approval", "warn"]);

/**
 * Does this `match` positively SELECT anything?
 *
 * ── Why the check exists ─────────────────────────────────────────────────────
 * Checking only that `match` is an object and casting it was fail-DANGEROUS, in a
 * package whose every other failure mode is fail-open. `evaluate` ANDs the arms it
 * recognizes; a match carrying none of them has nothing to fail, so it is satisfied by
 * every call. Against the built bundle:
 *
 *   match: {}                                        -> `echo hello` DENIED
 *   match: {tool_in: ["Bash"], detail_contains: [x]} -> `echo hello` DENIED
 *
 * The second is the realistic one: it is what someone writes from a half-remembered
 * schema, with the conditions at the top level instead of nested under `any_of`. Both
 * keys are unrecognized, nothing narrows, and a rule meant to catch one command becomes
 * "block every Bash command on this machine": a wrong rule that ends the session
 * rather than one that does nothing.
 *
 * So a match with no interpretable condition is DISCARDED, like every other unreadable
 * input here. `status` and `guardrails validate` still name it, because the strict validator
 * rejects it too and reports why.
 *
 * ── Why this exact test, and not a stricter one ──────────────────────────────
 * It mirrors `MatchSchema`'s own refinement — "At least one of 'any_of' or 'all_of'
 * must be provided", each `.min(1)` — so the one-directional invariant still holds:
 * everything the strict validator accepts, this admits. `none_of` alone is not enough
 * for the same reason the strict schema refuses it: a pure negation selects every call
 * that does not match, which at `block` denies everything the agent does.
 *
 * It deliberately does NOT reject a condition that is merely broad, such as
 * `{any_of: [{kind: "execute_tool"}]}`. That is legal in the strict schema and is a
 * thing an author can genuinely mean, so rejecting it here would break the invariant in
 * the dangerous direction — `guardrails add` would write a rule the hook then drops.
 * `guardrails list` warns about it instead (`core/rule-view.ts`).
 */
function hasSelectableMatch(match: unknown): match is Match {
  if (match === null || typeof match !== "object" || Array.isArray(match)) return false;
  const m = match as Record<string, unknown>;
  const populated = (arm: unknown): boolean => Array.isArray(arm) && arm.length > 0;
  return populated(m.any_of) || populated(m.all_of);
}

/**
 * Parse the user's rules file for the hook. Never throws.
 *
 * Absent, empty, malformed, or not an array all yield `[]` — a broken personal rules
 * file must never take the shipped catalog down with it. Individual entries that do not
 * have the shape are skipped, not fatal, for the same reason.
 */
export function parseUserRulesData(text: string | undefined): GuardRule[] {
  if (text === undefined || text.trim().length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: GuardRule[] = [];
  for (const raw of parsed) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const rec = raw as Record<string, unknown>;
    const { id, category, defaultAction, match } = rec;
    if (typeof id !== "string" || id.length === 0) continue;
    if (typeof category !== "string" || category.length === 0) continue;
    if (typeof defaultAction !== "string" || !VALID_ACTIONS.has(defaultAction)) continue;
    if (!hasSelectableMatch(match)) continue;

    out.push({
      id,
      category,
      severity: typeof rec.severity === "string" ? rec.severity : "medium",
      defaultAction: defaultAction as GuardAction,
      title: typeof rec.title === "string" ? rec.title : id,
      description: typeof rec.description === "string" ? rec.description : "",
      match: match as Match,
    });
  }
  return out;
}
