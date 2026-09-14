/**
 * The joined read model behind `guardrails list` and `guardrails show`. Pure, CLI-only.
 *
 * Four sources have to agree before a person can be told what a rule is doing: the
 * shipped catalog, the user's own rules, `config.json`'s three levers (`enabledPacks`,
 * `disabledGuardrails`, `guardrailActionOverrides`), and the allowlist. Joining them in each
 * renderer is how the two views end up disagreeing about the same rule, so it happens
 * once, here, with no IO and no formatting.
 *
 * ── Why "disabled" carries its reason ────────────────────────────────────────
 * A rule can be off because its pack is off or because it was turned off by id, and the
 * fix differs (`guardrails enable <pack>` vs `guardrails enable <guardrail-id>`). Collapsing both to a
 * boolean means telling someone a rule is off without telling them how to turn it on,
 * which is the shape of problem this whole command surface exists to remove.
 */

import type { AllowlistEntry, GuardAction, GuardConfig, GuardRule } from "./types.js";

/** Where a rule came from. `library` ships with us; `yours` is from `guardrails.json`. */
export type RuleSource = "library" | "yours";

/** Why a rule is not running. `undefined` on the `enabled` path. */
export type DisabledBy = "pack" | "rule";

export interface RuleView {
  readonly rule: GuardRule;
  readonly source: RuleSource;
  /** The action in force — the override if there is one, else the shipped default. */
  readonly action: GuardAction;
  /** The action it ships with, so `show` can say what an override changed. */
  readonly shippedAction: GuardAction;
  /** True when this rule's action was changed by `guardrailActionOverrides`. */
  readonly overridden: boolean;
  readonly enabled: boolean;
  readonly disabledBy: DisabledBy | undefined;
  /** Allowlist entries naming this rule, in file order. */
  readonly allowlist: readonly AllowlistEntry[];
  /**
   * Set when the rule's `match` uses a construct that can never work at guard time.
   *
   * Populated for rules ALREADY on disk: `guardrails add` refuses these, but
   * `parsePolicyPredicate` permits them, so one can predate this command surface or
   * arrive by hand-editing. The text states the mechanism rather than the word
   * "warning" — a user told only that something is wrong will assume we are being
   * cautious, when in fact a `numeric` + `block` rule freezes every command they run.
   */
  readonly warning: string | undefined;
}

/**
 * Does this `match` contain a construct the guardrail format bans, and what does it do?
 *
 * Walks the three composition arms rather than the top level only — a `numeric` nested
 * under `any_of` is the shape a real rule has, and checking only the root would report
 * clean on every rule that actually has the problem.
 */
export const NUMERIC_REASON =
  "uses `numeric`, which cannot work before a tool runs: `tokens`, `cachedTokens` and `durationMs` are all 0 at decision time, so `gt` never fires and `lt` fires on EVERY command. At `block` this guardrail freezes every command you run. Remove the `numeric` condition.";

export const BROAD_REASON =
  "has a condition with no narrowing matcher — no `label`, `detail_contains`, `detail_matches` or `file_glob` — so it matches EVERY tool call of that kind. At `block` that denies every command you run. Add a matcher, or narrow the `kind`.";

export const SCOPE_REASON =
  "uses `scope`, which compares against an agent id that is always a UUID — never a vendor slug like `claude-code`. A scoped guardrail matches nothing, forever, and says nothing about it. Remove `scope`.";

/**
 * EXPORTED so `guardrails add`'s refusal and `guardrails list`'s warning row say the SAME
 * sentence. Two wordings for one mechanism is how a user comes to think they are two
 * different problems — and the wording is the point here: told only "unrecognized key
 * `numeric`", a person assumes a schema nicety. Told that `lt` is always true before the
 * tool runs, they understand their agent was about to lock up.
 */
export function bannedConstructWarning(match: unknown): string | undefined {
  const conditions: unknown[] = [];
  const positive: unknown[] = [];
  if (match !== null && typeof match === "object" && !Array.isArray(match)) {
    const m = match as Record<string, unknown>;
    for (const arm of ["any_of", "all_of", "none_of"]) {
      const list = m[arm];
      if (Array.isArray(list)) {
        conditions.push(...list);
        if (arm !== "none_of") positive.push(...list);
      }
    }
    if (m.scope !== undefined) return SCOPE_REASON;
  }
  for (const c of conditions) {
    if (
      c !== null &&
      typeof c === "object" &&
      (c as Record<string, unknown>).numeric !== undefined
    ) {
      return NUMERIC_REASON;
    }
  }

  // A condition carrying a `kind` and nothing else is LEGAL — the strict schema accepts
  // it, and an author can genuinely mean "every execute_tool". So it is warned about
  // rather than rejected: refusing it here would break the one-directional invariant in
  // the dangerous direction, letting `guardrails add` write a rule the hook then drops.
  //
  // Only the POSITIVE arms count. An unnarrowed condition under `none_of` excludes
  // everything of that kind, which makes a rule quieter rather than broader.
  if (positive.length > 0 && positive.every(isUnnarrowed)) return BROAD_REASON;

  return undefined;
}

/** A condition with nothing in it that could exclude a call. */
function isUnnarrowed(condition: unknown): boolean {
  if (condition === null || typeof condition !== "object") return false;
  const c = condition as Record<string, unknown>;
  return (
    c.label === undefined &&
    c.detail_contains === undefined &&
    c.detail_matches === undefined &&
    c.file_glob === undefined
  );
}

/**
 * Join catalog, user rules and config into one list, in catalog-then-yours order.
 *
 * Every rule appears exactly once, enabled or not — `guardrails list` has to be able to show
 * a disabled rule, which is the whole point of being able to re-enable it.
 */
export function buildRuleViews(
  catalog: readonly GuardRule[],
  userRules: readonly GuardRule[],
  config: GuardConfig,
): RuleView[] {
  const disabled = new Set(config.disabledGuardrails);
  const packs = config.enabledPacks;
  const views: RuleView[] = [];

  const add = (rule: GuardRule, source: RuleSource): void => {
    const packOff = packs !== undefined && !packs.includes(rule.category);
    const ruleOff = disabled.has(rule.id);
    const override = config.guardrailActionOverrides[rule.id];
    views.push({
      rule,
      source,
      action: override ?? rule.defaultAction,
      shippedAction: rule.defaultAction,
      overridden: override !== undefined && override !== rule.defaultAction,
      enabled: !packOff && !ruleOff,
      // A rule can be off both ways. `rule` is reported first because it is the more
      // specific action and the one `guardrails enable <id>` alone will not undo.
      disabledBy: ruleOff ? "rule" : packOff ? "pack" : undefined,
      allowlist: config.allowlist.filter((a) => a.guardrail === rule.id),
      warning: bannedConstructWarning(rule.match),
    });
  };

  for (const r of catalog) add(r, "library");
  for (const r of userRules) add(r, "yours");
  return views;
}

/** Every pack id present in these views, in first-seen order. */
export function packsOf(views: readonly RuleView[]): string[] {
  const seen: string[] = [];
  for (const v of views) if (!seen.includes(v.rule.category)) seen.push(v.rule.category);
  return seen;
}

/**
 * `require_approval` on disk, `ask` on screen.
 *
 * The single translation point for OUTPUT. Every human-facing render goes through it,
 * and nothing else in the package converts an action for display — so the word a person
 * reads and the word on disk can never drift apart by one renderer being missed.
 * `--json` deliberately does NOT use this: a machine reading structured output needs
 * the stored spelling.
 */
export function displayAction(action: GuardAction): string {
  return action === "require_approval" ? "ask" : action;
}
