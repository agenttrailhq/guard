// cspell:words nocase
/**
 * Windows coverage, proven on the shipped path instead of simulated.
 *
 * With the engine's picomatch@4.0.4 and its `FILE_GLOB_OPTIONS`, a glob alone does not
 * match a backslash path:
 *
 *     `**​/.env*`  vs  C:\\Users\\dev\\proj\\.env   -> false
 *     `**​/.env*`  vs  C:/Users/dev/proj/.env       -> true
 *
 * The engine matches both, because it tests every form of the path
 * (`engine/path-forms.ts`), separators unified, and the guard's span already carries the
 * forward-slash form (`core/normalize.ts`). This file proves that on the genuine path:
 * `buildGuardSpanContext` into the real `evaluate()`, over the real corpus, with every
 * file guardrail's fixtures rewritten with backslashes.
 *
 * The fixtures are DERIVED from the forward-slash ones rather than written out
 * again, so the two cannot drift: a file rule that gains a fixture gains its
 * Windows case for free, and one that loses a fixture cannot leave a stale
 * Windows assertion behind.
 */

import { RULES, type Rule } from "@agenttrail/guardrails/guardrails";
import picomatch from "picomatch";
import { describe, expect, it } from "vitest";
import { buildGuardSpanContext } from "../core/normalize.js";
import type { MappedCall } from "../core/types.js";
import { evaluate } from "../engine/evaluator.js";

/** Rules that read the file channel — the only ones a separator can affect. */
const FILE_RULES: readonly Rule[] = RULES.filter((rule) =>
  [...(rule.match.any_of ?? []), ...(rule.match.all_of ?? [])].some(
    (condition) => condition.file_glob !== undefined,
  ),
);

/**
 * Rewrite a fixture path the way Claude Code sends it on Windows.
 *
 * Separator flip only — no drive letter is invented. A POSIX system path such as
 * `/etc/hosts` has no Windows equivalent to guess at, and prefixing `C:` would
 * turn a real assertion into a made-up one; the drive-prefixed case is proven
 * end-to-end against the built bundle instead (`built-artifact.test.ts`),
 * and by the explicit probe below.
 */
function toWindows(path: string): string {
  return path.replace(/\//g, "\\");
}

/** Does this rule match this path, through the guard's own normalizer? */
function matches(rule: Rule, filePath: string, tool: string): boolean {
  const mapped: MappedCall = { tool, args: { file_path: filePath } };
  return evaluate(
    { version: 1 as const, match: rule.match, action: rule.defaultAction },
    buildGuardSpanContext(mapped),
  ).matched;
}

describe("the normalizer is doing something", () => {
  it("the separator really does matter before normalization", () => {
    // Without this the whole file could be passing because backslash paths happen
    // to match anyway, and the normalizer could be deleted with nobody noticing.
    // The glob alone misses the backslash path; the engine matches it because it tests
    // the path's forms (`engine/path-forms.ts`), separators unified, as well as the raw
    // attribute. Asserted on the RAW attribute, bypassing `buildGuardSpanContext`.
    // `se.credential-file`, not a dotenv rule: `**/*.env` matches a backslash
    // path even unnormalized, because picomatch sees no separators at all and
    // lets `*` swallow the whole string. `**/.ssh/id_*` needs real structure, so
    // it is the one that actually distinguishes normalized from not.
    const rule = RULES.find((r) => r.id === "se.credential-file") as Rule;
    expect(rule).toBeDefined();
    const raw = evaluate(
      { version: 1 as const, match: rule.match, action: rule.defaultAction },
      {
        span: {
          id: "00000000-0000-0000-0000-000000000000" as never,
          traceId: "00000000-0000-0000-0000-000000000000" as never,
          orgId: "00000000-0000-0000-0000-000000000000" as never,
          parentSpanId: null,
          kind: "execute_tool",
          label: "Read",
          startedAt: "1970-01-01T00:00:00.000Z" as never,
          durationMs: 0,
          tokens: 0,
          cachedTokens: 0,
          failed: false,
          attributes: { file_path: "C:\\Users\\dev\\.ssh\\id_rsa" },
        },
        agentId: "00000000-0000-0000-0000-000000000000" as never,
        projectId: "00000000-0000-0000-0000-000000000000" as never,
        developerId: null,
      },
    );
    expect(
      picomatch("**/.ssh/id_*", { dot: true, nocase: true })("C:\\Users\\dev\\.ssh\\id_rsa"),
    ).toBe(false);
    expect(raw.matched).toBe(true);
    // ...and the same path through the guard's normalizer matches too.
    expect(matches(rule, "C:\\Users\\dev\\.ssh\\id_rsa", "Read")).toBe(true);
  });
});

describe("every file guardrail holds on Windows-shaped paths", () => {
  it("there are file guardrails to test — a sweep over nothing proves nothing", () => {
    expect(FILE_RULES.length).toBeGreaterThanOrEqual(6);
  });

  it.each(
    FILE_RULES.map((rule) => [rule.id, rule] as const),
  )("%s: every block fixture still matches with backslashes", (_id, rule) => {
    for (const fixture of rule.fixtures.block) {
      if ("command" in fixture) continue;
      const windows = toWindows(fixture.file_path);
      expect(matches(rule, windows, fixture.tool), `${rule.id} should MATCH ${windows}`).toBe(true);
    }
  });

  it.each(
    FILE_RULES.map((rule) => [rule.id, rule] as const),
  )("%s: every allow fixture still does NOT match with backslashes", (_id, rule) => {
    for (const fixture of rule.fixtures.allow) {
      if ("command" in fixture) continue;
      const windows = toWindows(fixture.file_path);
      expect(matches(rule, windows, fixture.tool), `${rule.id} should NOT match ${windows}`).toBe(
        false,
      );
    }
  });

  it("a drive-prefixed Windows path reaches a forward-slash guardrail", () => {
    // The shape Claude Code actually sends on Windows, spelled out once rather
    // than derived — the derivation above deliberately invents no drive letter.
    const cred = RULES.find((r) => r.id === "se.credential-file") as Rule;
    const ci = RULES.find((r) => r.id === "fs.ci-definition") as Rule;
    expect(matches(cred, "C:\\Users\\dev\\.aws\\credentials", "Read")).toBe(true);
    expect(matches(ci, "C:\\proj\\.github\\workflows\\ci.yml", "Edit")).toBe(true);
    expect(matches(cred, "C:\\proj\\src\\index.ts", "Edit")).toBe(false);
  });

  it("the sweep covered a real number of fixtures, not zero", () => {
    // `continue` on a command fixture means a rule with none of the right shape
    // would pass both blocks above having asserted nothing. Count what was
    // actually exercised.
    const n = FILE_RULES.reduce(
      (total, rule) =>
        total +
        [...rule.fixtures.block, ...rule.fixtures.allow].filter((f) => !("command" in f)).length,
      0,
    );
    expect(n).toBeGreaterThanOrEqual(40);
  });
});
