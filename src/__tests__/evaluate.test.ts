// cspell:words uncompilable
/**
 * The evaluate loop: per-rule allowlisting, verdict precedence, and the warn record.
 *
 * The allowlist tests are the load-bearing ones. "Silence this rule" must never
 * become "silence the guard" — a global mute is how a security tool ends up
 * installed but decorative, and the user would have no way to tell.
 */

import { describe, expect, it, vi } from "vitest";
import { compileAllowlist, evaluateCall } from "../core/evaluate.js";
import { buildGuardSpanContext } from "../core/normalize.js";
import { compileCatalog } from "../core/rules.js";
import type { GuardAction, GuardRule, MappedCall } from "../core/types.js";

function rule(
  id: string,
  action: GuardAction,
  contains: string,
  title = `the ${id} rule`,
): GuardRule {
  return {
    id,
    category: "test",
    severity: "high",
    defaultAction: action,
    title,
    description: "fixture",
    match: { any_of: [{ kind: "execute_tool", detail_contains: [contains] }] },
  };
}

function bash(command: string): MappedCall {
  return { tool: "Bash", args: { full_command: command } };
}

function run(rules: GuardRule[], mapped: MappedCall, allowlist = compileAllowlist([])) {
  return evaluateCall(compileCatalog(rules), buildGuardSpanContext(mapped), mapped, allowlist);
}

describe("verdict mapping", () => {
  it("block → deny", () => {
    expect(run([rule("r.block", "block", "danger")], bash("danger")).decision).toBe("deny");
  });

  it("require_approval → ask", () => {
    expect(run([rule("r.ask", "require_approval", "danger")], bash("danger")).decision).toBe("ask");
  });

  it("warn → allow", () => {
    expect(run([rule("r.warn", "warn", "danger")], bash("danger")).decision).toBe("allow");
  });

  it("no match → allow, with no reason and no matches", () => {
    const out = run([rule("r.block", "block", "danger")], bash("safe"));
    expect(out.decision).toBe("allow");
    expect(out.reason).toBe("");
    expect(out.matches).toEqual([]);
  });

  it("the reason names the guardrail and never echoes the command", () => {
    const out = run([rule("r.block", "block", "secret-token-value")], bash("secret-token-value"));
    expect(out.reason).toBe("agenttrail-guard blocked this: the r.block rule (guardrail r.block)");
    expect(out.reason).not.toContain("secret-token-value");
  });
});

describe("every message names the product, the guardrail and its title", () => {
  // In Cursor no reason of Cursor's own is shown, so this text, quoted back by the agent, is
  // all a user gets. It has to say which tool stopped them and which guardrail to look at —
  // and carry nothing of what they were doing.
  const COMMAND = "deploy --token hunter2-do-not-echo-me";
  const FILE = "/home/user/project/.env.production";

  const commandRule = (action: GuardAction, title: string) =>
    rule("r.msg", action, "deploy", title);

  const fileRule = (action: GuardAction, title: string): GuardRule => ({
    ...rule("r.msg", action, "unused", title),
    match: { any_of: [{ kind: "execute_tool", file_glob: "**/.env*" }] },
  });

  const CASES: [GuardAction, string, string][] = [
    ["block", "Block a production deploy", "agenttrail-guard blocked this: "],
    [
      "require_approval",
      "Ask before a production deploy",
      "agenttrail-guard needs a person to approve this: ",
    ],
    ["warn", "Production deploys are noisy", "agenttrail-guard is warning about this: "],
  ];

  it.each(CASES)("a %s message reads in full", (action, title, lead) => {
    expect(run([commandRule(action, title)], bash(COMMAND)).reason).toBe(
      `${lead}${title} (guardrail r.msg)`,
    );
  });

  it.each(CASES)("a %s message carries nothing of what it judged", (action, title) => {
    const onCommand = run([commandRule(action, title)], bash(COMMAND)).reason;
    const onFile = run([fileRule(action, title)], {
      tool: "Read",
      args: { file_path: FILE },
    }).reason;
    for (const reason of [onCommand, onFile]) {
      expect(reason).not.toContain("hunter2");
      expect(reason).not.toContain(FILE);
      expect(reason).not.toContain("production.");
      expect(reason.split("\n")).toHaveLength(1);
    }
  });

  it("names the guardrail that DECIDED, not merely the first that matched", () => {
    const out = run(
      [
        rule("r.first", "warn", "deploy", "A warning"),
        rule("r.decides", "block", "deploy", "The blocking rule"),
      ],
      bash(COMMAND),
    );
    expect(out.reason).toBe(
      "agenttrail-guard blocked this: The blocking rule (guardrail r.decides)",
    );
  });

  it("leaves the id standing alone when a guardrail has no usable title", () => {
    for (const title of ["", "   "]) {
      expect(run([commandRule("block", title)], bash(COMMAND)).reason).toBe(
        "agenttrail-guard blocked this: guardrail r.msg",
      );
    }
  });

  it("collapses a title's whitespace, because the message is one line", () => {
    // A bundled title is single-line; a user's own guardrail carries whatever they typed.
    const out = run([commandRule("block", " Block a\n  production\tdeploy ")], bash(COMMAND));
    expect(out.reason).toBe(
      "agenttrail-guard blocked this: Block a production deploy (guardrail r.msg)",
    );
  });
});

describe("strongest verdict wins", () => {
  it("block beats require_approval and warn", () => {
    const out = run(
      [rule("a", "warn", "x"), rule("b", "require_approval", "x"), rule("c", "block", "x")],
      bash("x"),
    );
    expect(out.decision).toBe("deny");
    expect(out.matches).toHaveLength(3);
  });

  it("require_approval beats warn", () => {
    const out = run([rule("a", "warn", "x"), rule("b", "require_approval", "x")], bash("x"));
    expect(out.decision).toBe("ask");
  });
});

describe("a warn keeps its identity even though the verdict discards it", () => {
  it("records the matching guardrail id despite deciding `allow`", () => {
    const out = run([rule("r.warn", "warn", "x")], bash("x"));
    expect(out.decision).toBe("allow");
    expect(out.matches).toEqual([{ ruleId: "r.warn", action: "warn" }]);
    expect(out.reason).toBe(
      "agenttrail-guard is warning about this: the r.warn rule (guardrail r.warn)",
    );
  });

  it("a warn-only result is distinguishable from no match at all", () => {
    // `strongestVerdict` returns `{verdict:"allow", policyId:null}` for BOTH, which
    // is exactly why the guard keeps its own list rather than reading the verdict.
    const warned = run([rule("r.warn", "warn", "x")], bash("x"));
    const clean = run([rule("r.warn", "warn", "x")], bash("safe"));
    expect(warned.matches).not.toHaveLength(0);
    expect(clean.matches).toHaveLength(0);
  });
});

describe("the allowlist is PER-RULE, never global", () => {
  const rules = [
    rule("r.one", "block", "danger"),
    rule("r.two", "block", "danger"),
    rule("r.three", "block", "danger"),
  ];

  it("silencing one guardrail leaves the others firing", () => {
    const allowlist = compileAllowlist([{ guardrail: "r.one", pattern: "**danger**" }]);
    const out = run(rules, bash("danger"), allowlist);
    expect(out.matches.map((m) => m.ruleId)).toEqual(["r.two", "r.three"]);
    expect(out.decision).toBe("deny");
  });

  it("silencing every guardrail individually is what it takes to reach allow", () => {
    const allowlist = compileAllowlist([
      { guardrail: "r.one", pattern: "**danger**" },
      { guardrail: "r.two", pattern: "**danger**" },
      { guardrail: "r.three", pattern: "**danger**" },
    ]);
    expect(run(rules, bash("danger"), allowlist).decision).toBe("allow");
  });

  it("an entry naming guardrail A never suppresses guardrail B on the same shape", () => {
    const allowlist = compileAllowlist([{ guardrail: "r.one", pattern: "**" }]);
    const out = run(rules, bash("danger"), allowlist);
    expect(out.matches.map((m) => m.ruleId)).not.toContain("r.one");
    expect(out.matches).toHaveLength(2);
  });

  it("only suppresses on the SHAPE it names", () => {
    const allowlist = compileAllowlist([
      { guardrail: "r.one", pattern: "git checkout -- ./generated/*" },
    ]);
    // A different command → the rule still fires.
    expect(run([rules[0] as GuardRule], bash("danger"), allowlist).decision).toBe("deny");
  });

  it("matches against the file_path channel too", () => {
    const fileRule: GuardRule = {
      ...rule("r.file", "block", "unused"),
      match: { any_of: [{ kind: "execute_tool", file_glob: "**/.env*" }] },
    };
    const mapped: MappedCall = { tool: "Read", args: { file_path: "/app/generated/.env" } };
    const allowlist = compileAllowlist([{ guardrail: "r.file", pattern: "**/generated/**" }]);
    expect(run([fileRule], mapped).decision).toBe("deny");
    expect(run([fileRule], mapped, allowlist).decision).toBe("allow");
  });

  it("an uncompilable pattern is dropped, so it cannot suppress anything by accident", () => {
    const allowlist = compileAllowlist([{ guardrail: "r.one", pattern: "[" }]);
    // Fails TOWARD enforcement: the broken entry silences nothing.
    expect(run([rules[0] as GuardRule], bash("danger"), allowlist).decision).toBe("deny");
  });
});

describe("an evaluator that throws is skipped, never propagated", () => {
  it("keeps the other guardrails working", () => {
    const catalog = compileCatalog([rule("r.ok", "block", "danger")]);
    const exploding = {
      rule: rule("r.boom", "block", "danger"),
      action: "block" as GuardAction,
      evaluate: vi.fn(() => {
        throw new Error("boom");
      }),
    };
    const mapped = bash("danger");
    const out = evaluateCall(
      [exploding, ...catalog],
      buildGuardSpanContext(mapped),
      mapped,
      compileAllowlist([]),
    );
    expect(out.decision).toBe("deny");
    expect(out.matches.map((m) => m.ruleId)).toEqual(["r.ok"]);
  });
});

describe("a call with no channel can never match", () => {
  it("allows a WebFetch-shaped call even against a match-all guardrail", () => {
    const matchAll: GuardRule = {
      ...rule("r.all", "block", "unused"),
      match: { any_of: [{ kind: "execute_tool" }] },
    };
    // `kind` alone DOES match any execute_tool span, so this proves the point the
    // other way round: the channel is what carries the content, and with no channel
    // a content rule has nothing to read.
    const out = run([matchAll], { tool: "WebFetch", args: {} });
    expect(out.decision).toBe("deny");
    const contentRule = rule("r.content", "block", "http");
    expect(run([contentRule], { tool: "WebFetch", args: {} }).decision).toBe("allow");
  });
});
