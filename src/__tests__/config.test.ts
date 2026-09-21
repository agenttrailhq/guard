/**
 * Config parsing, which is a fail-open surface in both directions.
 *
 * Two defaults deserve their own attention, because they fail in OPPOSITE
 * directions and both are deliberate:
 *   - a broken `disabledPacks` is DISCARDED (every pack stays on), because a typo
 *     must never silently disable enforcement;
 *   - a broken `allowlist` entry is DISCARDED, because a malformed suppression must
 *     never silently switch a rule off.
 * Both fail toward enforcing. Nothing here fails toward blocking the user.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  parseConfig,
  serializeDefaultConfig,
  updateConfigText,
} from "../core/config.js";
import { configPath, eventsPath, guardDir, userRulesPath } from "../core/paths.js";

describe("parseConfig — never throws, always usable", () => {
  it.each([
    ["absent file", undefined],
    ["empty string", ""],
    ["not JSON", "{{{"],
    ["JSON null", "null"],
    ["JSON array", "[1,2]"],
    ["JSON string", '"hello"'],
    ["JSON number", "42"],
  ])("%s → defaults", (_label, text) => {
    expect(() => parseConfig(text as string | undefined)).not.toThrow();
    expect(parseConfig(text as string | undefined)).toEqual(DEFAULT_CONFIG);
  });

  it("reads a well-formed config", () => {
    const cfg = parseConfig(
      JSON.stringify({
        version: 1,
        disabledPacks: ["file-scope"],
        guardrailActionOverrides: { "wt.reset-hard": "ask" },
        allowlist: [{ guardrail: "wt.checkout-discard", pattern: "git checkout -- ./generated/*" }],
        failOpen: true,
        crashReports: false,
      }),
    );
    expect(cfg.disabledPacks).toEqual(["file-scope"]);
    expect(cfg.allowlist).toHaveLength(1);
  });
});

describe("disabledPacks fails toward ENFORCING", () => {
  it.each([
    ["not an array", '{"disabledPacks":"working-tree"}'],
    ["an object", '{"disabledPacks":{"working-tree":true}}'],
    ["array of non-strings", '{"disabledPacks":[1,2,3]}'],
    ["absent", "{}"],
  ])("%s → nothing disabled (every pack enabled)", (_l, text) => {
    expect(parseConfig(text).disabledPacks).toEqual([]);
  });

  it("keeps only the string entries from a mixed array", () => {
    expect(parseConfig('{"disabledPacks":["a",2,"b"]}').disabledPacks).toEqual(["a", "b"]);
  });
});

describe("enabledPacks, written by older releases, is not read", () => {
  it.each([
    ["a trimmed list", '{"enabledPacks":["working-tree"]}'],
    ["an empty list", '{"enabledPacks":[]}'],
    ["a full list", '{"enabledPacks":["working-tree","file-scope"]}'],
  ])("%s disables nothing — every pack stays on", (_l, text) => {
    // The safe direction: a pack a user once trimmed out of this list comes back on,
    // rather than a pack shipped after their install staying off.
    expect(parseConfig(text)).toEqual(parseConfig("{}"));
  });

  it("does not override a disabledPacks beside it", () => {
    expect(
      parseConfig('{"enabledPacks":["file-scope"],"disabledPacks":["file-scope"]}').disabledPacks,
    ).toEqual(["file-scope"]);
  });
});

describe("the allowlist fails toward ENFORCING", () => {
  it.each([
    ["not an array", '{"allowlist":{}}'],
    ["entries missing a rule", '{"allowlist":[{"pattern":"*"}]}'],
    ["entries missing a pattern", '{"allowlist":[{"guardrail":"r"}]}'],
    ["entries with an empty rule id", '{"allowlist":[{"guardrail":"","pattern":"*"}]}'],
    ["null entries", '{"allowlist":[null]}'],
    ["non-string fields", '{"allowlist":[{"guardrail":1,"pattern":2}]}'],
  ])("%s → nothing is suppressed", (_l, text) => {
    expect(parseConfig(text).allowlist).toEqual([]);
  });

  it("keeps the valid entries from a partly-broken list", () => {
    const cfg = parseConfig(
      '{"allowlist":[null,{"guardrail":"ok","pattern":"*"},{"guardrail":1}]}',
    );
    expect(cfg.allowlist).toEqual([{ guardrail: "ok", pattern: "*" }]);
  });
});

describe("guardrailActionOverrides", () => {
  it("accepts only the three real actions", () => {
    const cfg = parseConfig(
      '{"guardrailActionOverrides":{"a":"block","b":"require_approval","c":"warn","d":"nonsense","e":7}}',
    );
    expect(cfg.guardrailActionOverrides).toEqual({ a: "block", b: "require_approval", c: "warn" });
  });

  it("ignores a non-object", () => {
    expect(parseConfig('{"guardrailActionOverrides":["a"]}').guardrailActionOverrides).toEqual({});
  });
});

describe("flags", () => {
  it("crashReports is OFF unless explicitly true (opt-in)", () => {
    expect(parseConfig("{}").crashReports).toBe(false);
    expect(parseConfig('{"crashReports":"yes"}').crashReports).toBe(false);
    expect(parseConfig('{"crashReports":true}').crashReports).toBe(true);
  });

  it("disabledPacks defaults to [] and discards malformed entries", () => {
    expect(parseConfig("{}").disabledPacks).toEqual([]);
    expect(parseConfig('{"disabledPacks":"nope"}').disabledPacks).toEqual([]);
    // Non-string and empty entries are dropped; the good ones survive (fail toward enforcing).
    expect(parseConfig('{"disabledPacks":["file-scope",7,""]}').disabledPacks).toEqual([
      "file-scope",
    ]);
  });
});

describe("the seed config records what is OFF, never what is on", () => {
  it("writes an empty disabledPacks and no pack list", () => {
    // A seed that listed the packs would freeze the install at today's library: a pack
    // shipped later would be missing from the list, and so never load.
    const seed = JSON.parse(serializeDefaultConfig());
    expect(seed.disabledPacks).toEqual([]);
    expect(seed).not.toHaveProperty("enabledPacks");
    expect(parseConfig(serializeDefaultConfig()).disabledPacks).toEqual([]);
  });
});

describe("paths live under ~/.agenttrail/guard", () => {
  it.each([
    ["dir", guardDir("/home/x"), "/home/x/.agenttrail/guard"],
    ["config", configPath("/home/x"), "/home/x/.agenttrail/guard/config.json"],
    ["rules", userRulesPath("/home/x"), "/home/x/.agenttrail/guard/guardrails.json"],
    ["events", eventsPath("/home/x"), "/home/x/.agenttrail/guard/events.jsonl"],
  ])("%s", (_l, actual, expected) => {
    expect(actual).toBe(expected);
  });
});

describe("disabledGuardrails — the per-rule off switch", () => {
  it("round-trips through the seed config and the parser", () => {
    // The writer and the reader must agree on the shape; `serializeDefaultConfig`
    // writes the key explicitly rather than omitting it, for the same reason
    // `disabledPacks` is explicit: the file is meant to be hand-edited, and a user
    // cannot turn off a rule using a key they cannot see.
    expect(parseConfig(serializeDefaultConfig()).disabledGuardrails).toEqual([]);
    expect(JSON.parse(serializeDefaultConfig())).toHaveProperty("disabledGuardrails");
  });

  it("keeps the ids it can use", () => {
    expect(
      parseConfig(JSON.stringify({ disabledGuardrails: ["a.b", "c.d"] })).disabledGuardrails,
    ).toEqual(["a.b", "c.d"]);
  });

  it.each([
    ["not an array", { disabledGuardrails: "a.b" }],
    ["an object", { disabledGuardrails: { "a.b": true } }],
    ["null", { disabledGuardrails: null }],
  ])("DISCARDS %s — a broken disable list must fail toward enforcing", (_name, raw) => {
    expect(parseConfig(JSON.stringify(raw)).disabledGuardrails).toEqual([]);
  });

  it("drops only the unusable entries, keeping the rest", () => {
    // Dropping the whole list because of one bad entry would silently re-enable rules
    // the user really did turn off.
    expect(
      parseConfig(JSON.stringify({ disabledGuardrails: ["a.b", 42, "", null, "c.d"] }))
        .disabledGuardrails,
    ).toEqual(["a.b", "c.d"]);
  });

  it("is absent from an old config without disabling anything", () => {
    // Forward/backward compatibility runs the safe way: a file written by an older
    // build simply disables nothing.
    expect(parseConfig(JSON.stringify({ version: 1 })).disabledGuardrails).toEqual([]);
  });
});

describe("updateConfigText preserves what the parser does not understand", () => {
  it("keeps unknown keys, so a mutation cannot silently delete a setting", () => {
    // `parseConfig` keeps only the keys it knows, so a serialize-from-config writer
    // would drop `crashEndpoint` and anything a newer build wrote. This is why
    // mutations go through the RAW object.
    const text = JSON.stringify({
      version: 1,
      crashEndpoint: "https://x.test/e",
      somethingFromTheFuture: { a: 1 },
    });
    const next = JSON.parse(
      updateConfigText(text, (d) => {
        d.disabledGuardrails = ["a.b"];
      }),
    );
    expect(next.crashEndpoint).toBe("https://x.test/e");
    expect(next.somethingFromTheFuture).toEqual({ a: 1 });
    expect(next.disabledGuardrails).toEqual(["a.b"]);
  });

  it("starts from the seed shape when there is no file", () => {
    const next = JSON.parse(
      updateConfigText(undefined, (d) => {
        d.disabledGuardrails = ["a.b"];
      }),
    );
    expect(next.version).toBe(1);
    expect(next.disabledPacks).toEqual([]);
    expect(next).not.toHaveProperty("enabledPacks");
  });

  it("ends with a newline and two-space indent, like the seeded file", () => {
    const out = updateConfigText(undefined, () => {});
    expect(out.endsWith("\n")).toBe(true);
    expect(out).toContain('\n  "version": 1');
  });
});

/**
 * Unrecognized keys are IGNORED, key by key, asserted so it is a decision rather than
 * an accident.
 *
 * `ruleActionOverrides`, `disabledRules` and `allowlist[].rule` are not this format's
 * names (`guardrailActionOverrides`, `disabledGuardrails`, `allowlist[].guardrail`), so
 * `parseConfig`'s fail-open posture drops each one. Every one of those defaults fails
 * TOWARD ENFORCING: an ignored `disabledRules` leaves guardrails running rather than
 * switching them off, an ignored `allowlist` suppresses nothing, and an ignored
 * `ruleActionOverrides` leaves each guardrail on its shipped action. That is the right
 * direction for a security tool to be wrong in, and it is why "silently ignored" is
 * acceptable here and would not be if the defaults leaned the other way.
 */
describe("a config with unrecognized key names is ignored, not migrated", () => {
  const UNRECOGNIZED = JSON.stringify({
    version: 1,
    ruleActionOverrides: { "wt.reset-hard": "warn" },
    disabledRules: ["dd.rm-rf-absolute"],
    allowlist: [{ rule: "wt.reset-hard", pattern: "**" }],
  });

  it("drops every unrecognized key back to its default", () => {
    const cfg = parseConfig(UNRECOGNIZED);
    expect(cfg.guardrailActionOverrides).toEqual({});
    expect(cfg.disabledGuardrails).toEqual([]);
    expect(cfg.allowlist).toEqual([]);
  });

  it("leaves the whole config indistinguishable from an empty one", () => {
    // Not three separate assertions dressed up: the point is that NOTHING in the file
    // survives, so a user who never re-ran the tool gets shipped behaviour end to end.
    expect(parseConfig(UNRECOGNIZED)).toEqual(parseConfig("{}"));
  });

  it("keeps the old allowlist entry out even when the new key is also present", () => {
    // A hand-merged file is the realistic shape. The old entry must not sneak through
    // on the back of a valid one — `parseAllowlist` drops entries individually.
    const mixed = JSON.stringify({
      allowlist: [
        { rule: "wt.reset-hard", pattern: "**" },
        { guardrail: "dd.rm-rf-absolute", pattern: "rm -rf /tmp/**" },
      ],
    });
    expect(parseConfig(mixed).allowlist).toEqual([
      { guardrail: "dd.rm-rf-absolute", pattern: "rm -rf /tmp/**" },
    ]);
  });
});
