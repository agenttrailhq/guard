/**
 * Reading and validating `~/.agenttrail/guard/guardrails.json` — the user's own rules.
 *
 * ── Why `status` has to report the invalid ones LOUDLY ───────────────────────
 * An invalid rule is skipped, never fatal — one bad rule must not disable the others.
 * The obvious implementation then prints a warning to stderr and carries on. That
 * warning reaches nobody: per `hooks.md:794`, stderr from a hook that exits 0 "goes to
 * the debug log only, never the transcript, and Claude never sees it". So the user goes
 * on believing a rule protects them when it does not. `status` is the ONLY channel that
 * reaches a person, which is why the invalid list is printed first, above everything.
 *
 * ── Validating the right thing ─────────────────────────────────────────────────
 * `parsePolicyPredicate` is the schema of the `match` sub-object, not of a rule, so it
 * rejects a whole rule outright. `rules.ts` already does the right thing: wrap into
 * `{version: 1, match, action}` and validate THAT. We wrap identically here, so this
 * verdict is by construction the verdict the hook reaches — a rule this reports as
 * valid is a rule the hook will actually compile.
 */

import { parsePolicyPredicate } from "../engine/policy-predicate.js";
import type { GuardAction, GuardRule } from "./types.js";

const VALID_ACTIONS: ReadonlySet<string> = new Set(["block", "require_approval", "warn"]);

/** A rule we could not load, and the reason, ready to print. */
export interface InvalidUserRule {
  /** The rule's id if it had a usable one, else a positional label. */
  readonly id: string;
  readonly reason: string;
}

export interface UserRulesResult {
  readonly valid: GuardRule[];
  readonly invalid: InvalidUserRule[];
}

const EMPTY: UserRulesResult = { valid: [], invalid: [] };

/**
 * Parse and validate the user's rules file. Never throws.
 *
 * A file that is absent is not an error — it is the normal state on a fresh install,
 * and `init` seeds it as `[]`.
 */
export function loadUserRules(text: string | undefined): UserRulesResult {
  if (text === undefined || text.trim().length === 0) return EMPTY;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      valid: [],
      invalid: [{ id: "guardrails.json", reason: `not valid JSON: ${(error as Error).message}` }],
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      valid: [],
      invalid: [{ id: "guardrails.json", reason: "expected a JSON array of guardrails" }],
    };
  }

  const valid: GuardRule[] = [];
  const invalid: InvalidUserRule[] = [];

  parsed.forEach((raw, index) => {
    const label = `guardrails.json[${index}]`;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      invalid.push({ id: label, reason: "not a JSON object" });
      return;
    }
    const rec = raw as Record<string, unknown>;
    const id = typeof rec.id === "string" && rec.id.length > 0 ? rec.id : undefined;
    const named = id ?? label;

    if (id === undefined) {
      invalid.push({ id: label, reason: "missing a string `id`" });
      return;
    }
    const action = rec.defaultAction;
    if (typeof action !== "string" || !VALID_ACTIONS.has(action)) {
      // `ask` is called out by name because it is the single most likely wrong answer:
      // it is the vocabulary the CLI uses (`guardrails set-action <id> block|ask|warn`) and
      // the decision Claude Code ultimately shows, but the STORED action is
      // `require_approval`, and a hand-edited file gets it wrong.
      const hint =
        action === "ask"
          ? " — write `require_approval`; `ask` is the prompt Claude Code shows, not the stored action"
          : "";
      invalid.push({
        id: named,
        reason: `\`defaultAction\` must be one of block, require_approval, warn${hint}`,
      });
      return;
    }
    // `category` is the pack a rule belongs to — what `disabledPacks` switches off. The
    // hook's loader (`user-rules-data.ts`) skips a rule without one, so it never runs.
    if (typeof rec.category !== "string" || rec.category.length === 0) {
      invalid.push({
        id: named,
        reason:
          "missing `category` — the hook does not load a guardrail without one; set it to the pack it belongs to",
      });
      return;
    }

    // Zod `SafeParseReturnType`: check `.success` before touching `.data`.
    const result = parsePolicyPredicate({ version: 1, match: rec.match, action });
    if (!result.success) {
      // First issue only. The whole `issues` array is accurate and unreadable; one
      // path-and-message is what a person can act on.
      const issue = result.error.issues[0];
      const where = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
      invalid.push({ id: named, reason: `${issue?.message ?? "invalid predicate"}${where}` });
      return;
    }

    valid.push({
      id,
      category: rec.category,
      severity: typeof rec.severity === "string" ? rec.severity : "medium",
      defaultAction: action as GuardAction,
      title: typeof rec.title === "string" ? rec.title : id,
      description: typeof rec.description === "string" ? rec.description : "",
      match: result.data.match,
    });
  });

  return { valid, invalid };
}
