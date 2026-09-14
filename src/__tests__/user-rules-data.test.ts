// cspell:words alsogood nocat nokind unvouched
/**
 * The two user-rule loaders, and the one-directional invariant between them.
 *
 * `loadUserRules` (zod, CLI) produces the messages. `parseUserRulesData` (structural,
 * hook) decides what actually runs. The invariant is:
 *
 *   **everything the strict validator accepts, the structural loader also admits.**
 *
 * That direction is what stops `guardrails add` writing a rule the hook silently drops. The
 * converse is deliberately allowed — a hand-edited rule the hook admits and the
 * validator rejects is running and not vouched for, and `status` reports the gap rather
 * than picking one of the two numbers.
 *
 * It is a property over a shared corpus rather than a pair of hand-picked cases,
 * because a one-directional invariant asserted on two examples is how the two drift.
 */

import { describe, expect, it } from "vitest";
import { loadUserRules } from "../core/user-rules.js";
import { parseUserRulesData } from "../core/user-rules-data.js";

const MATCH = {
  any_of: [{ kind: "execute_tool", label: "Bash", detail_contains: ["./deploy.sh"] }],
};

/**
 * One corpus, fed to both loaders. Includes the shapes that actually occur: the
 * valid example, a common mistaken form, hand-edit mistakes, and the constructs
 * `parsePolicyPredicate` permits but the guardrail format bans.
 */
const CORPUS: { name: string; rule: unknown }[] = [
  {
    name: "valid, fully specified",
    rule: {
      id: "a.b",
      category: "prod-infra",
      severity: "medium",
      defaultAction: "block",
      title: "t",
      description: "d",
      match: MATCH,
    },
  },
  {
    name: "valid, minimal",
    rule: { id: "a.min", category: "prod-infra", defaultAction: "warn", match: MATCH },
  },
  {
    name: "valid, require_approval",
    rule: { id: "a.ra", category: "prod-infra", defaultAction: "require_approval", match: MATCH },
  },
  {
    name: "stale doc example — `ask` and no category",
    rule: { id: "a.stale", severity: "medium", defaultAction: "ask", title: "t", match: MATCH },
  },
  {
    name: "`ask` but with a category",
    rule: { id: "a.ask", category: "prod-infra", defaultAction: "ask", match: MATCH },
  },
  { name: "missing category", rule: { id: "a.nocat", defaultAction: "block", match: MATCH } },
  { name: "missing id", rule: { category: "prod-infra", defaultAction: "block", match: MATCH } },
  {
    name: "empty id",
    rule: { id: "", category: "prod-infra", defaultAction: "block", match: MATCH },
  },
  {
    name: "match is not an object",
    rule: { id: "a.m", category: "prod-infra", defaultAction: "block", match: "nope" },
  },
  {
    name: "match missing any_of/all_of",
    rule: { id: "a.empty", category: "prod-infra", defaultAction: "block", match: {} },
  },
  {
    name: "condition with no `kind` — admitted by shape, refused by the schema",
    rule: {
      id: "a.nokind-cond",
      category: "prod-infra",
      defaultAction: "block",
      match: { any_of: [{}] },
    },
  },
  {
    name: "numeric (banned by the guardrail format, permitted by the engine)",
    rule: {
      id: "a.num",
      category: "prod-infra",
      defaultAction: "block",
      match: {
        any_of: [{ kind: "execute_tool", numeric: [{ field: "tokens", op: "lt", value: 1 }] }],
      },
    },
  },
  { name: "not an object", rule: "a string" },
  { name: "null", rule: null },
];

describe("the invariant: strict ⊆ structural", () => {
  it.each(
    CORPUS.map((c) => [c.name, c.rule] as const),
  )("%s — anything loadUserRules accepts, parseUserRulesData admits", (_name, rule) => {
    const text = JSON.stringify([rule]);
    const strict = loadUserRules(text).valid.map((r) => r.id);
    const structural = parseUserRulesData(text).map((r) => r.id);
    for (const id of strict) {
      expect(
        structural,
        `${id} passed the strict validator but the hook would not load it — \`guardrails add\` would write a rule that silently does nothing`,
      ).toContain(id);
    }
  });

  it("holds over the whole corpus at once, not only one guardrail at a time", () => {
    // A per-rule pass can hide an ordering or index bug that only shows with a mixed
    // file, which is what a real `guardrails.json` is.
    const text = JSON.stringify(CORPUS.map((c) => c.rule));
    const strict = new Set(loadUserRules(text).valid.map((r) => r.id));
    const structural = new Set(parseUserRulesData(text).map((r) => r.id));
    for (const id of strict) expect(structural).toContain(id);
  });

  it("the gap is non-empty — the property is not vacuously true", () => {
    // If the two loaders ever agreed exactly, the assertions above would still pass
    // while proving nothing about the direction. This names a real member of the gap.
    //
    // `any_of: [{}]` has a populated positive arm, so the hook admits it, while the
    // strict schema rejects the condition for having no `kind`. `compilePolicy`
    // then refuses it inside `compileCatalog`'s per-rule try/catch, so it is running,
    // unvouched-for, and inert — which is the safe direction and why `status` reports
    // it rather than hiding it. (`match: {}` is discarded by the structural loader.)
    const text = JSON.stringify(CORPUS.map((c) => c.rule));
    const strict = new Set(loadUserRules(text).valid.map((r) => r.id));
    const structural = parseUserRulesData(text).map((r) => r.id);
    const unvouched = structural.filter((id) => !strict.has(id));
    expect(unvouched).toContain("a.nokind-cond");
    // And a match that selects nothing is not admitted at all.
    expect(structural).not.toContain("a.empty");
  });

  it("a `numeric` guardrail is accepted by BOTH loaders — the engine permits it", () => {
    // Worth pinning, because it is the reason `guardrails add` needs its own stricter check
    // and `guardrails list` needs a warning row. `parsePolicyPredicate` has a `numeric` key,
    // so nothing on the hook path rejects a rule that fires on every command.
    const text = JSON.stringify([
      {
        id: "a.num",
        category: "prod-infra",
        defaultAction: "block",
        match: {
          any_of: [{ kind: "execute_tool", numeric: [{ field: "tokens", op: "lt", value: 1 }] }],
        },
      },
    ]);
    expect(loadUserRules(text).valid.map((r) => r.id)).toEqual(["a.num"]);
    expect(parseUserRulesData(text).map((r) => r.id)).toEqual(["a.num"]);
  });
});

describe("parseUserRulesData fails toward keeping the shipped catalog", () => {
  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["whitespace", "   \n"],
    ["not JSON", "{oh no"],
    ["not an array", '{"id":"a.b"}'],
    ["array of junk", "[1, null, true, []]"],
  ])("%s yields no rules rather than throwing", (_name, text) => {
    expect(parseUserRulesData(text as string | undefined)).toEqual([]);
  });

  it("keeps the good guardrails in a file that also holds bad ones", () => {
    // The whole reason a bad rule is skipped rather than fatal: one typo must not
    // disable everything else the user wrote.
    const text = JSON.stringify([
      { id: "a.good", category: "prod-infra", defaultAction: "block", match: MATCH },
      { id: "", category: "prod-infra", defaultAction: "block", match: MATCH },
      { id: "a.alsogood", category: "prod-infra", defaultAction: "warn", match: MATCH },
    ]);
    expect(parseUserRulesData(text).map((r) => r.id)).toEqual(["a.good", "a.alsogood"]);
  });

  it("defaults the optional fields the same way loadUserRules does", () => {
    // Both loaders feed the same `GuardRule` shape into `compileCatalog`; a divergence
    // in defaulting would make `status` describe a rule differently from how it runs.
    const text = JSON.stringify([
      { id: "a.b", category: "prod-infra", defaultAction: "block", match: MATCH },
    ]);
    const [structural] = parseUserRulesData(text);
    const [strict] = loadUserRules(text).valid;
    expect(structural?.severity).toBe(strict?.severity);
    expect(structural?.title).toBe(strict?.title);
    expect(structural?.description).toBe(strict?.description);
  });

  it("rejects an `ask` spelling, exactly as the strict loader does", () => {
    // The one place the two MUST agree: `ask` is not a stored action anywhere.
    const text = JSON.stringify([
      { id: "a.ask", category: "prod-infra", defaultAction: "ask", match: MATCH },
    ]);
    expect(parseUserRulesData(text)).toEqual([]);
    expect(loadUserRules(text).valid).toEqual([]);
  });
});

describe("a match that selects nothing is DISCARDED, not promoted to match-everything", () => {
  /**
   * Fail-DANGEROUS otherwise, in a package whose every other failure mode is fail-open.
   * `evaluate` ANDs the arms it recognizes, so a match carrying none of them has nothing
   * to fail and is satisfied by every call. A rule meant to catch one command would
   * become "block every Bash command on this machine".
   */
  const R = (match: unknown) =>
    JSON.stringify([
      { id: "usr.x", category: "prod-infra", defaultAction: "block", title: "t", match },
    ]);

  it.each([
    ["an empty object", {}],
    // The realistic one: conditions at the top level instead of nested under `any_of`,
    // which is what someone writes from a half-remembered schema.
    ["top-level conditions, no any_of", { tool_in: ["Bash"], detail_contains: ["x"] }],
    ["an empty any_of", { any_of: [] }],
    ["an empty all_of", { all_of: [] }],
    ["any_of that is not an array", { any_of: { kind: "execute_tool" } }],
    // A pure negation selects every call that does NOT match, which at `block` denies
    // everything. The strict schema refuses it for the same reason.
    ["none_of alone", { none_of: [{ kind: "execute_tool" }] }],
  ])("%s is dropped", (_name, match) => {
    expect(parseUserRulesData(R(match))).toEqual([]);
  });

  it.each([
    ["any_of with a condition", { any_of: [{ kind: "execute_tool", label: "Bash" }] }],
    ["all_of with a condition", { all_of: [{ kind: "execute_tool", label: "Bash" }] }],
    // Legal and deliberately KEPT: the strict schema accepts it, so dropping it here
    // would break the invariant in the dangerous direction. `guardrails list` warns instead.
    ["a kind-only condition", { any_of: [{ kind: "execute_tool" }] }],
  ])("%s is kept", (_name, match) => {
    expect(parseUserRulesData(R(match)).map((r) => r.id)).toEqual(["usr.x"]);
  });

  it("the strict validator rejects the dropped shapes too, so `validate` names them", () => {
    // The discard must be VISIBLE. If the strict validator accepted any of these, the
    // rule would vanish from enforcement with nothing reporting why.
    for (const match of [{}, { tool_in: ["Bash"], detail_contains: ["x"] }, { any_of: [] }]) {
      const result = loadUserRules(R(match));
      expect(result.valid).toEqual([]);
      expect(result.invalid).toHaveLength(1);
    }
  });

  it("the invariant still holds over the widened corpus", () => {
    // Tightening the structural loader must not overshoot into rejecting something the
    // strict validator accepts — that is the direction that makes `guardrails add` write a
    // rule the hook drops.
    const extra = [
      {},
      { tool_in: ["Bash"] },
      { any_of: [] },
      { none_of: [{ kind: "execute_tool" }] },
      { any_of: [{ kind: "execute_tool" }] },
      { all_of: [{ kind: "execute_tool", file_glob: "**/.env" }] },
    ];
    for (const match of extra) {
      const text = R(match);
      const strict = loadUserRules(text).valid.map((r) => r.id);
      const structural = parseUserRulesData(text).map((r) => r.id);
      for (const id of strict) {
        expect(
          structural,
          `${JSON.stringify(match)} passes strict but the hook drops it`,
        ).toContain(id);
      }
    }
  });
});
