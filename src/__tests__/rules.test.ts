/**
 * Compile-once, and the "one bad rule must not disable the other 55" property.
 *
 * The compile-once assertion is the one that protects the 10s budget: with a 56-rule
 * catalog and no internal watchdog by design, compiling inside the per-rule loop is
 * the only thing that could push a call toward the ceiling.
 */

import { describe, expect, it, vi } from "vitest";
import { SHIPPED_CATALOG } from "../core/catalog.js";
import { buildGuardSpanContext } from "../core/normalize.js";
import { compileCatalog } from "../core/rules.js";
import type { GuardAction, GuardRule } from "../core/types.js";
import * as evaluator from "../engine/evaluator.js";

function rule(id: string, category = "test", action: GuardAction = "block"): GuardRule {
  return {
    id,
    category,
    severity: "high",
    defaultAction: action,
    title: id,
    description: "fixture",
    match: { any_of: [{ kind: "execute_tool", detail_contains: ["danger"] }] },
  };
}

describe("compile ONCE at process start", () => {
  it("calls compilePolicy exactly once per guardrail, however many calls follow", () => {
    const spy = vi.spyOn(evaluator, "compilePolicy");
    spy.mockClear();

    const catalog = compileCatalog([rule("a"), rule("b"), rule("c")]);
    expect(spy).toHaveBeenCalledTimes(3);

    // Evaluate many times — compilation must not happen again.
    const ctx = buildGuardSpanContext({ tool: "Bash", args: { full_command: "danger" } });
    for (let i = 0; i < 50; i++) {
      for (const entry of catalog) entry.evaluate(ctx);
    }
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });

  it("returns reusable closures rather than recompiling per evaluation", () => {
    const catalog = compileCatalog([rule("a")]);
    const first = catalog[0]?.evaluate;
    expect(first).toBe(catalog[0]?.evaluate);
  });
});

describe("a malformed guardrail is skipped, not fatal", () => {
  it("drops the bad guardrail and keeps the rest", () => {
    const bad: GuardRule = {
      ...rule("r.bad"),
      // `any_of: []` violates the DSL (min 1), so compilation of this predicate is
      // the failure path we want — and it must not take the catalog down with it.
      match: { any_of: [] } as never,
    };
    const catalog = compileCatalog([bad, rule("r.good")]);
    expect(catalog.map((c) => c.rule.id)).toContain("r.good");
    expect(() => compileCatalog([bad])).not.toThrow();
  });

  it("an empty catalog compiles to an empty list without throwing", () => {
    expect(compileCatalog([])).toEqual([]);
  });
});

describe("config shapes the compiled catalog", () => {
  it("enabledPacks filters by category", () => {
    const catalog = compileCatalog([rule("a", "keep"), rule("b", "drop")], {
      enabledPacks: ["keep"],
      guardrailActionOverrides: {},
    });
    expect(catalog.map((c) => c.rule.id)).toEqual(["a"]);
  });

  it("an ABSENT pack list means no filter — every guardrail stays enabled", () => {
    // Fails toward enforcing: a missing/unusable packs list must never silently
    // disable the catalog.
    const catalog = compileCatalog([rule("a", "x"), rule("b", "y")], {
      enabledPacks: undefined,
      guardrailActionOverrides: {},
    });
    expect(catalog).toHaveLength(2);
  });

  it("guardrailActionOverrides changes the effective action", () => {
    const catalog = compileCatalog([rule("a", "test", "block")], {
      enabledPacks: undefined,
      guardrailActionOverrides: { a: "warn" },
    });
    expect(catalog[0]?.action).toBe("warn");
  });

  it("an override for an unrelated guardrail id leaves this one alone", () => {
    const catalog = compileCatalog([rule("a", "test", "block")], {
      enabledPacks: undefined,
      guardrailActionOverrides: { somethingElse: "warn" },
    });
    expect(catalog[0]?.action).toBe("block");
  });
});

describe("the shipped catalog is well-formed", () => {
  it("every guardrail compiles", () => {
    expect(compileCatalog(SHIPPED_CATALOG)).toHaveLength(SHIPPED_CATALOG.length);
  });

  it("has no duplicate ids", () => {
    const ids = SHIPPED_CATALOG.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses no banned `scope` construct (it can never match)", () => {
    for (const r of SHIPPED_CATALOG) {
      expect(JSON.stringify(r)).not.toContain('"scope"');
    }
  });

  it("uses no banned numeric conditions (`lt` fires on everything)", () => {
    for (const r of SHIPPED_CATALOG) {
      expect(JSON.stringify(r)).not.toContain('"numeric"');
    }
  });

  it("never puts a command matcher and a file matcher in one condition", () => {
    for (const r of SHIPPED_CATALOG) {
      for (const group of [r.match.any_of, r.match.all_of, r.match.none_of]) {
        for (const cond of group ?? []) {
          const hasCommand =
            cond.detail_contains !== undefined || cond.detail_matches !== undefined;
          expect(hasCommand && cond.file_glob !== undefined).toBe(false);
        }
      }
    }
  });

  it("every guardrail states its coverage limits in the description", () => {
    for (const r of SHIPPED_CATALOG) {
      // The guardrails package's own corpus test checks the same convention more strictly.
      // This one guards the wiring: if `core/catalog.ts` were ever swapped for a small
      // placeholder catalog with thin descriptions, it would red here.
      expect(r.description.length).toBeGreaterThan(120);
      expect(r.description.toLowerCase()).toMatch(
        /does not|deliberately not|misses|missed|cannot|known miss|not caught|not matched|not flagged|ceiling/,
      );
    }
  });
});
