import { describe, expect, it } from "vitest";
import { correctSingleBraceLabels, findSingleBraceLabels } from "../core/label-braces.js";
import { createCompiledLabelMatcher } from "../engine/matchers.js";

describe("the trap is real", () => {
  it("`{Bash}` does not match Bash, while `Bash` and `{Bash,PowerShell}` do", () => {
    expect(createCompiledLabelMatcher("{Bash}")("Bash")).toBe(false);
    expect(createCompiledLabelMatcher("Bash")("Bash")).toBe(true);
    expect(createCompiledLabelMatcher("{Bash,PowerShell}")("Bash")).toBe(true);
  });
});

describe("findSingleBraceLabels", () => {
  it("finds a one-element brace group in every composition arm", () => {
    const match = {
      any_of: [{ kind: "execute_tool", label: "{Bash}" }],
      all_of: [{ kind: "execute_tool", label: "mcp__{github}__*" }],
      none_of: [{ kind: "execute_tool", label: "{Read}" }],
    };
    expect(findSingleBraceLabels(match)).toEqual([
      { path: "match.any_of[0].label", label: "{Bash}", corrected: "Bash", rewrite: true },
      {
        path: "match.all_of[0].label",
        label: "mcp__{github}__*",
        corrected: "mcp__github__*",
        rewrite: true,
      },
      { path: "match.none_of[0].label", label: "{Read}", corrected: "Read", rewrite: true },
    ]);
  });

  it.each([
    ["a plain value", "Bash"],
    ["an alternation", "{Bash,PowerShell}"],
    ["an alternation with an empty branch", "{Bash,}"],
    ["a numeric range", "tool{1..3}"],
    ["an escaped brace", "\\{Bash\\}"],
    ["a glob", "mcp__*"],
    ["an empty group", "{}"],
    ["an empty group in a label", "mcp__{}x"],
    ["a group of spaces", "{ }"],
    ["a brace inside a bracket expression", "[{a}]"],
    ["a group closed by an escaped brace", "{Bash\\}"],
  ])("leaves %s alone", (_name, label) => {
    expect(findSingleBraceLabels({ any_of: [{ kind: "execute_tool", label }] })).toEqual([]);
  });

  it("corrects every one-element group in one label", () => {
    expect(findSingleBraceLabels({ any_of: [{ label: "mcp__{x}__{y}" }] })).toEqual([
      {
        path: "match.any_of[0].label",
        label: "mcp__{x}__{y}",
        corrected: "mcp__x__y",
        rewrite: true,
      },
    ]);
  });

  it("trims spaces around the value", () => {
    expect(findSingleBraceLabels({ any_of: [{ label: "{ Bash }" }] })).toEqual([
      { path: "match.any_of[0].label", label: "{ Bash }", corrected: "Bash", rewrite: true },
    ]);
  });

  it("unwraps nested one-element groups completely", () => {
    expect(findSingleBraceLabels({ any_of: [{ label: "{{Bash}}" }] })).toEqual([
      { path: "match.any_of[0].label", label: "{{Bash}}", corrected: "Bash", rewrite: true },
    ]);
  });

  it("flags a group next to an escaped bracket", () => {
    expect(findSingleBraceLabels({ any_of: [{ label: "\\[{a}\\]" }] })).toEqual([
      { path: "match.any_of[0].label", label: "\\[{a}\\]", corrected: "\\[a\\]", rewrite: true },
    ]);
  });

  it("unwraps a one-element group nested in an alternation", () => {
    // picomatch reads `{a,{b}}` as `a` or a literal `{b}`.
    expect(findSingleBraceLabels({ any_of: [{ label: "{a,{b}}" }] })).toEqual([
      { path: "match.any_of[0].label", label: "{a,{b}}", corrected: "{a,b}", rewrite: true },
    ]);
  });

  it.each([
    ["{*}", "*"],
    ["{mcp__*}", "mcp__*"],
    ["{Bas?}", "Bas?"],
    ["{[BP]ash}", "[BP]ash"],
    ["{Bash}{*}", "Bash*"],
    ["{!Bash}", "!Bash"],
    ["{!(Bash)}", "!(Bash)"],
    ["{!}", "!"],
    ["{@(Bash|Edit)}", "@(Bash|Edit)"],
    ["{+(Bash)}", "+(Bash)"],
    ["{(\\w)+}", "(\\w)+"],
    ["{\\S\\S\\S\\S}", "\\S\\S\\S\\S"],
    ["{Bash|Edit}", "Bash|Edit"],
  ])("finds %s but marks it not to be rewritten, because %s is not a plain tool name", (label, corrected) => {
    expect(findSingleBraceLabels({ any_of: [{ label }] })).toEqual([
      { path: "match.any_of[0].label", label, corrected, rewrite: false },
    ]);
  });

  it("stays linear on a long run of unclosed brackets and braces", () => {
    const start = performance.now();
    findSingleBraceLabels({ any_of: [{ label: "[".repeat(50_000) }] });
    findSingleBraceLabels({ any_of: [{ label: "{".repeat(50_000) }] });
    expect(performance.now() - start).toBeLessThan(1_000);
  });

  it("is total on shapes that are not a match object", () => {
    for (const value of [undefined, null, 1, "x", [], { any_of: "x" }, { any_of: [null, 1] }]) {
      expect(findSingleBraceLabels(value)).toEqual([]);
    }
  });
});

describe("correctSingleBraceLabels", () => {
  it("returns a corrected copy and leaves the input unchanged", () => {
    const match = { any_of: [{ kind: "execute_tool", label: "{Bash}", detail_contains: ["x"] }] };
    const { match: corrected, fixes } = correctSingleBraceLabels(match);
    expect(corrected).toEqual({
      any_of: [{ kind: "execute_tool", label: "Bash", detail_contains: ["x"] }],
    });
    expect(match.any_of[0]?.label).toBe("{Bash}");
    expect(fixes).toHaveLength(1);
  });

  it("leaves a wildcard group as written and reports it as a warning", () => {
    const match = {
      any_of: [
        { kind: "execute_tool", label: "{*}", detail_contains: ["x"] },
        { kind: "execute_tool", label: "{Bash}", detail_contains: ["y"] },
      ],
    };
    const { match: corrected, fixes, warnings } = correctSingleBraceLabels(match);
    expect(corrected).toEqual({
      any_of: [
        { kind: "execute_tool", label: "{*}", detail_contains: ["x"] },
        { kind: "execute_tool", label: "Bash", detail_contains: ["y"] },
      ],
    });
    expect(fixes.map((f) => f.label)).toEqual(["{Bash}"]);
    expect(warnings.map((f) => f.label)).toEqual(["{*}"]);
  });

  it("returns the input itself when only a wildcard group is found", () => {
    const match = { any_of: [{ kind: "execute_tool", label: "{*}" }] };
    const result = correctSingleBraceLabels(match);
    expect(result.match).toBe(match);
    expect(result.fixes).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });

  it("returns the input itself when there is nothing to correct", () => {
    const match = { any_of: [{ kind: "execute_tool", label: "Bash" }] };
    expect(correctSingleBraceLabels(match)).toEqual({ match, fixes: [], warnings: [] });
    expect(correctSingleBraceLabels(match).match).toBe(match);
  });
});
