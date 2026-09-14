// cspell:words enablable
/**
 * The joined read model behind `guardrails list` and `guardrails show`, held to saying one thing.
 *
 * Four sources decide what a rule is actually doing — the shipped catalog, the user's own
 * rules, config's three levers, and the allowlist — and the reason they are joined in one
 * place is that two renderers joining them separately is exactly how a list view and a
 * detail view come to disagree about the same rule. So these tests concentrate on the
 * fields a renderer cannot work out for itself. Chief among them is WHY a rule is off: off
 * by pack and off by id are indistinguishable as a boolean, and each is undone by a
 * different command, so a view that collapses them tells someone their rule is off without
 * telling them how to turn it back on.
 *
 * Two others are quieter and easier to get wrong. An override naming the action a rule
 * already ships with has changed nothing, and flagging it as an override sends a person
 * hunting for a customization that does not exist. And `require_approval` is the word on
 * disk while `ask` is the word on screen — `displayAction` is the only place in the
 * package that converts between them, so any case that slips past it is a place where the
 * two spellings start drifting apart in front of users.
 *
 * The warning field is the exception to all of this: it is not about config at all, but
 * about a rule already on disk whose `match` can never fire, or — worse — always fires.
 * `guardrails add` refuses those shapes, so anything carrying one predates this command surface
 * or was hand-edited in, and the wording has to state the mechanism rather than the word
 * "warning", because a `numeric` rule at `block` freezes every command the user runs.
 */

import { describe, expect, it } from "vitest";
import { SHIPPED_CATALOG } from "../core/catalog.js";
import {
  bannedConstructWarning,
  buildRuleViews,
  displayAction,
  NUMERIC_REASON,
  packsOf,
  type RuleView,
  SCOPE_REASON,
} from "../core/rule-view.js";
import type { GuardAction, GuardConfig, GuardRule } from "../core/types.js";

/** A rule with sane defaults, so each test states only the field it is about. */
function rule(over: Partial<GuardRule> & Pick<GuardRule, "id">): GuardRule {
  return {
    category: "working-tree",
    severity: "high",
    defaultAction: "block",
    title: over.id,
    description: "fixture",
    match: { any_of: [{ kind: "execute_tool", detail_contains: ["danger"] }] },
    ...over,
  };
}

/** A config with every lever at its shipped default, so overrides read as the subject. */
function config(over: Partial<GuardConfig> = {}): GuardConfig {
  return {
    enabledPacks: undefined,
    disabledGuardrails: [],
    guardrailActionOverrides: {},
    allowlist: [],
    failOpen: true,
    crashReports: false,
    crashEndpoint: undefined,
    ...over,
  };
}

/** Fail loudly with the id when a view is missing, rather than optional-chaining past it. */
function viewOf(views: readonly RuleView[], id: string): RuleView {
  const found = views.find((v) => v.rule.id === id);
  if (found === undefined) throw new Error(`no view for ${id}`);
  return found;
}

describe("where a guardrail came from, and that it is listed at all", () => {
  it("labels the catalog `library` and the user's own guardrails `yours`, catalog first", () => {
    const views = buildRuleViews([rule({ id: "lib.a" })], [rule({ id: "mine.a" })], config());
    expect(views.map((v) => [v.rule.id, v.source])).toEqual([
      ["lib.a", "library"],
      ["mine.a", "yours"],
    ]);
  });

  it("lists a disabled guardrail too — being able to see it is what makes it re-enablable", () => {
    const views = buildRuleViews(
      [rule({ id: "lib.a" })],
      [rule({ id: "mine.a" })],
      config({ disabledGuardrails: ["lib.a", "mine.a"] }),
    );
    expect(views.map((v) => v.rule.id)).toEqual(["lib.a", "mine.a"]);
    expect(views.every((v) => v.enabled)).toBe(false);
  });

  it("carries the guardrail object through untouched, so `show` can read title and description", () => {
    const source = rule({ id: "lib.a", title: "a title", description: "a description" });
    expect(viewOf(buildRuleViews([source], [], config()), "lib.a").rule).toBe(source);
  });
});

describe("the action in force, and whether an override actually changed it", () => {
  it("an override that differs from the shipped action is reported as an override", () => {
    const views = buildRuleViews(
      [rule({ id: "lib.a", defaultAction: "block" })],
      [],
      config({ guardrailActionOverrides: { "lib.a": "warn" } }),
    );
    const v = viewOf(views, "lib.a");
    expect(v.action).toBe("warn");
    expect(v.shippedAction).toBe("block");
    expect(v.overridden).toBe(true);
  });

  it("an override EQUAL to the shipped action has changed nothing and must not claim to", () => {
    // The easy bug: `override !== undefined` alone would flag this, and `show` would
    // then tell a person a rule was customized when it is running exactly as shipped.
    const views = buildRuleViews(
      [rule({ id: "lib.a", defaultAction: "block" })],
      [],
      config({ guardrailActionOverrides: { "lib.a": "block" } }),
    );
    const v = viewOf(views, "lib.a");
    expect(v.overridden).toBe(false);
    expect(v.action).toBe("block");
    expect(v.shippedAction).toBe("block");
  });

  it("with no override, the action in force is the shipped one", () => {
    const v = viewOf(
      buildRuleViews([rule({ id: "lib.a", defaultAction: "require_approval" })], [], config()),
      "lib.a",
    );
    expect(v.action).toBe("require_approval");
    expect(v.shippedAction).toBe("require_approval");
    expect(v.overridden).toBe(false);
  });

  it("an override naming another guardrail leaves this one alone", () => {
    const v = viewOf(
      buildRuleViews(
        [rule({ id: "lib.a", defaultAction: "block" })],
        [],
        config({ guardrailActionOverrides: { "lib.b": "warn" } }),
      ),
      "lib.a",
    );
    expect(v.action).toBe("block");
    expect(v.overridden).toBe(false);
  });

  it("overrides a user guardrail as readily as a shipped one — the lever is by id, not source", () => {
    const v = viewOf(
      buildRuleViews(
        [],
        [rule({ id: "mine.a", defaultAction: "warn" })],
        config({ guardrailActionOverrides: { "mine.a": "block" } }),
      ),
      "mine.a",
    );
    expect(v.source).toBe("yours");
    expect(v.action).toBe("block");
    expect(v.overridden).toBe(true);
  });
});

describe("why a guardrail is off, not merely that it is", () => {
  const twoPacks = [
    rule({ id: "wt.a", category: "working-tree" }),
    rule({ id: "se.a", category: "secret-exposure" }),
  ];

  it("off because its pack is off", () => {
    const v = viewOf(
      buildRuleViews(twoPacks, [], config({ enabledPacks: ["secret-exposure"] })),
      "wt.a",
    );
    expect(v.enabled).toBe(false);
    expect(v.disabledBy).toBe("pack");
  });

  it("off because it was turned off by id", () => {
    const v = viewOf(
      buildRuleViews(twoPacks, [], config({ disabledGuardrails: ["wt.a"] })),
      "wt.a",
    );
    expect(v.enabled).toBe(false);
    expect(v.disabledBy).toBe("rule");
  });

  it("off BOTH ways reports `rule`, the fix that `guardrails enable <pack>` alone would miss", () => {
    const v = viewOf(
      buildRuleViews(
        twoPacks,
        [],
        config({ enabledPacks: ["secret-exposure"], disabledGuardrails: ["wt.a"] }),
      ),
      "wt.a",
    );
    expect(v.enabled).toBe(false);
    expect(v.disabledBy).toBe("rule");
  });

  it("on, with no reason to give", () => {
    const v = viewOf(
      buildRuleViews(twoPacks, [], config({ enabledPacks: ["working-tree"] })),
      "wt.a",
    );
    expect(v.enabled).toBe(true);
    expect(v.disabledBy).toBeUndefined();
  });

  it("an absent pack list is NO filter — every guardrail stays on, failing toward enforcing", () => {
    const views = buildRuleViews(
      twoPacks,
      [rule({ id: "mine.a", category: "anything" })],
      config(),
    );
    expect(views.every((v) => v.enabled)).toBe(true);
    expect(views.every((v) => v.disabledBy === undefined)).toBe(true);
  });

  it("disabling one id leaves its pack-mates running", () => {
    const views = buildRuleViews(
      [rule({ id: "wt.a" }), rule({ id: "wt.b" })],
      [],
      config({ disabledGuardrails: ["wt.a"] }),
    );
    expect(viewOf(views, "wt.b").enabled).toBe(true);
    expect(viewOf(views, "wt.b").disabledBy).toBeUndefined();
  });

  it("the pack filter reads the category, so a guardrail id in enabledPacks enables nothing", () => {
    const v = viewOf(
      buildRuleViews([rule({ id: "wt.a" })], [], config({ enabledPacks: ["wt.a"] })),
      "wt.a",
    );
    expect(v.enabled).toBe(false);
    expect(v.disabledBy).toBe("pack");
  });
});

describe("the allowlist reaches the guardrail it names and no other", () => {
  it("gives each guardrail only its own entries, in file order", () => {
    const views = buildRuleViews(
      [rule({ id: "lib.a" }), rule({ id: "lib.b" })],
      [],
      config({
        allowlist: [
          { guardrail: "lib.b", pattern: "second" },
          { guardrail: "lib.a", pattern: "first" },
          { guardrail: "lib.b", pattern: "third" },
        ],
      }),
    );
    expect(viewOf(views, "lib.a").allowlist).toEqual([{ guardrail: "lib.a", pattern: "first" }]);
    expect(viewOf(views, "lib.b").allowlist).toEqual([
      { guardrail: "lib.b", pattern: "second" },
      { guardrail: "lib.b", pattern: "third" },
    ]);
  });

  it("an entry naming a guardrail that does not exist reaches nobody", () => {
    const views = buildRuleViews(
      [rule({ id: "lib.a" })],
      [],
      config({ allowlist: [{ guardrail: "lib.gone", pattern: "*" }] }),
    );
    expect(viewOf(views, "lib.a").allowlist).toEqual([]);
  });

  it("a guardrail with no entries gets an empty list, not the whole allowlist", () => {
    const views = buildRuleViews(
      [rule({ id: "lib.a" })],
      [],
      config({ allowlist: [{ guardrail: "lib.other", pattern: "*" }] }),
    );
    expect(viewOf(views, "lib.a").allowlist).toHaveLength(0);
  });
});

describe("packsOf", () => {
  it("lists each pack once, in first-seen order", () => {
    const views = buildRuleViews(
      [rule({ id: "a", category: "working-tree" }), rule({ id: "b", category: "secret-exposure" })],
      [rule({ id: "c", category: "working-tree" }), rule({ id: "d", category: "mine" })],
      config(),
    );
    expect(packsOf(views)).toEqual(["working-tree", "secret-exposure", "mine"]);
  });

  it("includes the pack of a disabled guardrail — you cannot re-enable a pack you cannot see", () => {
    const views = buildRuleViews(
      [rule({ id: "a", category: "working-tree" })],
      [],
      config({ enabledPacks: ["secret-exposure"] }),
    );
    expect(viewOf(views, "a").enabled).toBe(false);
    expect(packsOf(views)).toEqual(["working-tree"]);
  });

  it("returns nothing for no views", () => {
    expect(packsOf([])).toEqual([]);
  });
});

describe("displayAction — the one place `require_approval` becomes `ask`", () => {
  it.each([
    ["require_approval", "ask"],
    ["block", "block"],
    ["warn", "warn"],
  ])("%s is shown as %s", (action, shown) => {
    expect(displayAction(action as GuardAction)).toBe(shown);
  });

  it("never lets the stored spelling reach a screen", () => {
    const actions: readonly GuardAction[] = ["block", "require_approval", "warn"];
    expect(actions.map(displayAction)).not.toContain("require_approval");
  });
});

describe("bannedConstructWarning — states the mechanism, not the word `warning`", () => {
  const numericCondition = {
    kind: "execute_tool",
    numeric: [{ field: "tokens", op: "lt", value: 100 }],
  };

  it.each([
    ["any_of"],
    ["all_of"],
    ["none_of"],
  ])("finds `numeric` nested under %s, where a real rule would put it", (arm) => {
    expect(bannedConstructWarning({ [arm]: [numericCondition] })).toBe(NUMERIC_REASON);
  });

  it("explains that `lt` fires on everything rather than reporting an unknown key", () => {
    expect(NUMERIC_REASON).toContain("lt");
    expect(NUMERIC_REASON).toContain("freezes every command");
    expect(NUMERIC_REASON).toContain("0 at decision time");
  });

  it("finds `scope` at the match root", () => {
    expect(bannedConstructWarning({ any_of: [], scope: { agent_in: ["claude-code"] } })).toBe(
      SCOPE_REASON,
    );
  });

  it("explains that a scoped guardrail compares against a UUID and so matches nothing", () => {
    expect(SCOPE_REASON).toContain("UUID");
    expect(SCOPE_REASON).toContain("matches nothing");
  });

  it("reports `scope` first when a match manages both", () => {
    // Precedence: `scope` is checked before the condition walk. Either reason
    // is true of this rule; what matters is that exactly one is reported, every time.
    expect(bannedConstructWarning({ any_of: [numericCondition], scope: {} })).toBe(SCOPE_REASON);
  });

  it("says nothing about a clean match", () => {
    expect(
      bannedConstructWarning({ any_of: [{ kind: "execute_tool", detail_contains: ["rm -rf /"] }] }),
    ).toBeUndefined();
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["an array", []],
    ["a string", "any_of"],
    ["a number", 7],
  ])("says nothing about %s rather than throwing", (_label, match) => {
    expect(bannedConstructWarning(match)).toBeUndefined();
  });

  it("finds nothing to warn about in the whole shipped catalog", () => {
    for (const r of SHIPPED_CATALOG) {
      expect(bannedConstructWarning(r.match)).toBeUndefined();
    }
  });
});

describe("the warning travels with the view", () => {
  it("marks the hand-edited guardrail and leaves its clean neighbors alone", () => {
    const banned = rule({
      id: "mine.numeric",
      // `parsePolicyPredicate` permits this even though `guardrails add` refuses it, so a rule
      // like this can already be sitting in guardrails.json.
      match: {
        any_of: [{ kind: "execute_tool", numeric: [{ field: "tokens", op: "lt", value: 1 }] }],
      },
    });
    const views = buildRuleViews([rule({ id: "lib.a" })], [banned], config());
    expect(viewOf(views, "mine.numeric").warning).toBe(NUMERIC_REASON);
    expect(viewOf(views, "lib.a").warning).toBeUndefined();
  });

  it("marks a scoped guardrail too, and warning is independent of enabled", () => {
    const scoped = rule({
      id: "mine.scoped",
      match: {
        any_of: [{ kind: "execute_tool", detail_contains: ["x"] }],
        scope: { agent_in: ["claude-code"] },
      } as unknown as GuardRule["match"],
    });
    const views = buildRuleViews([], [scoped], config({ disabledGuardrails: ["mine.scoped"] }));
    const v = viewOf(views, "mine.scoped");
    expect(v.warning).toBe(SCOPE_REASON);
    expect(v.enabled).toBe(false);
  });
});

describe("the shipped catalog under a real config", () => {
  it("joins packs, ids, overrides and the allowlist into one consistent picture", () => {
    const views = buildRuleViews(
      SHIPPED_CATALOG,
      [],
      config({
        enabledPacks: ["destructive-data", "secret-exposure"],
        disabledGuardrails: ["se.env-print"],
        guardrailActionOverrides: { "dd.rm-rf-absolute": "warn" },
        allowlist: [{ guardrail: "dd.rm-rf-absolute", pattern: "rm -rf /tmp/scratch" }],
      }),
    );
    expect(views).toHaveLength(SHIPPED_CATALOG.length);

    // Every working-tree rule is off for the same reason, and it is the pack.
    for (const id of ["wt.reset-hard", "block-force-push", "require-approval-rm-rf"]) {
      expect(viewOf(views, id).disabledBy, id).toBe("pack");
    }

    const rmrf = viewOf(views, "dd.rm-rf-absolute");
    expect(rmrf.enabled).toBe(true);
    expect(rmrf.action).toBe("warn");
    expect(rmrf.shippedAction).toBe("block");
    expect(rmrf.overridden).toBe(true);
    expect(rmrf.allowlist).toEqual([
      { guardrail: "dd.rm-rf-absolute", pattern: "rm -rf /tmp/scratch" },
    ]);

    // Disabled individually rather than by pack — `guardrails list` must be able to
    // say WHICH, because "turn it back on" is a different command for each.
    const envPrint = viewOf(views, "se.env-print");
    expect(envPrint.disabledBy).toBe("rule");
    expect(envPrint.allowlist).toEqual([]);

    // A rule in an enabled pack, untouched by any override, reads as shipped.
    const envFile = viewOf(views, "block-env-file-read");
    expect(envFile.enabled).toBe(true);
    expect(displayAction(envFile.action)).toBe("warn");
    expect(envFile.overridden).toBe(false);
  });

  it("names every pack in the catalog once, in catalog order", () => {
    const views = buildRuleViews(SHIPPED_CATALOG, [], config());
    expect(packsOf(views)).toEqual([
      "working-tree",
      "destructive-data",
      "prod-infra",
      "secret-exposure",
      "rce-supply-chain",
      "safety-bypass",
      "privilege-supply-chain",
      "file-scope",
    ]);
  });
});
