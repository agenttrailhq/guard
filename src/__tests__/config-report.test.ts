/**
 * What `config.json` lost, and whether anything says so.
 *
 * `parseConfig` is fail-open by design — a field it cannot use resolves to a default
 * rather than an error, so a typo in a JSON file never freezes the agent. The price is
 * silence, and the loudest case of that silence is
 * `{"guardrailActionOverrides": {"wt.reset-hard": "ask"}}`: `ask` is the word the CLI accepts
 * and the word Claude Code shows at the prompt, but the stored spelling is
 * `require_approval`, so the override is discarded, the rule goes on blocking, and
 * nothing anywhere mentions it.
 *
 * So these tests hold the reporter to naming the setting and the fix rather than to
 * counting problems: a message a person cannot act on is worth the same as no message.
 * They hold it just as hard to staying quiet, because a reporter that fires on a healthy
 * file — the one `init` itself writes — teaches people to ignore it. And wherever a loss
 * is reported, the same test checks against `parseConfig` that the loss really happened,
 * so the report can neither invent a problem nor understate one. `inspectConfig` explains
 * the parse; it must never change it.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  DEFAULT_ENABLED_PACKS,
  parseConfig,
  serializeDefaultConfig,
} from "../core/config.js";
import { inspectConfig } from "../core/config-report.js";

/** The problem reported for one key path, or `undefined` when that path was not reported. */
function problemAt(text: string, where: string, knownPacks?: readonly string[]) {
  return inspectConfig(text, knownPacks).problems.find((p) => p.where === where);
}

/** Every key path reported, in report order. */
function reportedPaths(text: string, knownPacks?: readonly string[]): string[] {
  return inspectConfig(text, knownPacks).problems.map((p) => p.where);
}

describe("the `ask` override — the silent loss this module exists for", () => {
  const ASK = '{"guardrailActionOverrides":{"wt.reset-hard":"ask"}}';

  it("names the guardrail, the stored spelling, and what the guardrail is doing instead", () => {
    const { problems } = inspectConfig(ASK);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.where).toBe("guardrailActionOverrides.wt.reset-hard");
    expect(problems[0]?.reason).toContain("require_approval");
    expect(problems[0]?.reason).toContain("ask");
    expect(problems[0]?.reason).toContain("still using its shipped action");
  });

  it("is telling the truth — the parser really did drop it", () => {
    // The report and the parse are checked against each other on purpose: a reporter
    // that fires where nothing was lost is as misleading as one that stays quiet.
    expect(parseConfig(ASK).guardrailActionOverrides).toEqual({});
  });

  it("does not blame the user for a typo when they wrote the word we taught them", () => {
    const asked = problemAt(ASK, "guardrailActionOverrides.wt.reset-hard");
    const nonsense = problemAt(
      '{"guardrailActionOverrides":{"wt.reset-hard":"off"}}',
      "guardrailActionOverrides.wt.reset-hard",
    );
    expect(asked?.reason).toContain("the word you type");
    expect(nonsense?.reason).not.toContain("the word you type");
    expect(nonsense?.reason).toContain("not one of block, require_approval, warn");
    expect(nonsense?.reason).toContain('"off"');
  });

  it("quotes a non-string action rather than printing [object Object]", () => {
    expect(
      problemAt('{"guardrailActionOverrides":{"a":7}}', "guardrailActionOverrides.a")?.reason,
    ).toContain("found 7");
    expect(
      problemAt('{"guardrailActionOverrides":{"a":null}}', "guardrailActionOverrides.a")?.reason,
    ).toContain("found null");
  });

  it("names each bad override separately instead of summarizing a count", () => {
    const text = '{"guardrailActionOverrides":{"a":"ask","b":"block","c":"nope"}}';
    expect(reportedPaths(text)).toEqual([
      "guardrailActionOverrides.a",
      "guardrailActionOverrides.c",
    ]);
  });

  it("says nothing about the three actions the parser accepts", () => {
    const text = '{"guardrailActionOverrides":{"a":"block","b":"require_approval","c":"warn"}}';
    expect(inspectConfig(text).problems).toEqual([]);
    expect(parseConfig(text).guardrailActionOverrides).toEqual({
      a: "block",
      b: "require_approval",
      c: "warn",
    });
  });

  it("reports the whole block, once, when the value is not an object of ids", () => {
    const p = problemAt('{"guardrailActionOverrides":["a"]}', "guardrailActionOverrides");
    expect(p?.reason).toContain("the whole block was ignored");
    expect(reportedPaths('{"guardrailActionOverrides":["a"]}')).toEqual([
      "guardrailActionOverrides",
    ]);
  });
});

describe("enabledPacks — including the empty list, which reads backwards", () => {
  it("says an empty list means EVERY pack, not none, and points at the real off switch", () => {
    const p = problemAt('{"enabledPacks":[]}', "enabledPacks");
    expect(p?.reason).toContain("every pack is active, not none");
    expect(p?.reason).toContain("uninstall");
    // And that is what the parser did with it: no filter at all.
    expect(parseConfig('{"enabledPacks":[]}').enabledPacks).toBeUndefined();
  });

  it("names an unknown pack and lists the ones that exist", () => {
    const p = problemAt(
      '{"enabledPacks":["working-tree","working-trees"]}',
      "enabledPacks.working-trees",
      ["working-tree", "secret-exposure"],
    );
    expect(p?.reason).toContain("enables nothing");
    expect(p?.reason).toContain("Known packs: working-tree, secret-exposure.");
  });

  it("skips the unknown-pack check entirely when no pack list is supplied", () => {
    // Omitting `knownPacks` must mean "cannot check", not "every pack is unknown".
    expect(inspectConfig('{"enabledPacks":["working-trees"]}').problems).toEqual([]);
  });

  it("stays quiet on a list of packs that all exist", () => {
    expect(inspectConfig('{"enabledPacks":["working-tree"]}', ["working-tree"]).problems).toEqual(
      [],
    );
  });

  it("reports a non-array as leaving every pack active", () => {
    expect(problemAt('{"enabledPacks":"working-tree"}', "enabledPacks")?.reason).toContain(
      "every pack is active",
    );
  });

  it("quotes a non-string entry so the user can find it in the file", () => {
    expect(problemAt('{"enabledPacks":["working-tree",7]}', "enabledPacks")?.reason).toContain(
      "entry 7 is not a string",
    );
  });
});

describe("allowlist — a dropped entry suppresses nothing", () => {
  it("says the thing it meant to allow is still being matched", () => {
    const text = '{"allowlist":[{"pattern":"git reset --hard"}]}';
    const p = problemAt(text, "allowlist[0]");
    expect(p?.reason).toContain("{guardrail, pattern}");
    expect(p?.reason).toContain("still being matched");
    expect(parseConfig(text).allowlist).toEqual([]);
  });

  it("indexes by position in the file, so the good entries do not shift it", () => {
    const text =
      '{"allowlist":[{"guardrail":"ok","pattern":"*"},null,{"guardrail":"","pattern":"*"}]}';
    expect(reportedPaths(text)).toEqual(["allowlist[1]", "allowlist[2]"]);
    expect(parseConfig(text).allowlist).toEqual([{ guardrail: "ok", pattern: "*" }]);
  });

  it("reports the whole list when it is not an array", () => {
    expect(problemAt('{"allowlist":{}}', "allowlist")?.reason).toContain(
      "the whole list was ignored",
    );
  });

  it("stays quiet on a well-formed list", () => {
    expect(inspectConfig('{"allowlist":[{"guardrail":"a","pattern":"*"}]}').problems).toEqual([]);
  });
});

describe("disabledGuardrails — a dropped id leaves the guardrail running", () => {
  it("says so, and quotes the entry it could not use", () => {
    const text = '{"disabledGuardrails":["wt.reset-hard",7]}';
    const p = problemAt(text, "disabledGuardrails[1]");
    expect(p?.reason).toContain("7 is not a guardrail id");
    expect(p?.reason).toContain("is still running");
    expect(parseConfig(text).disabledGuardrails).toEqual(["wt.reset-hard"]);
  });

  it("treats an empty string as no id at all", () => {
    expect(problemAt('{"disabledGuardrails":[""]}', "disabledGuardrails[0]")?.reason).toContain(
      "is not a guardrail id",
    );
  });

  it("reports the whole list when it is not an array", () => {
    expect(
      problemAt('{"disabledGuardrails":"wt.reset-hard"}', "disabledGuardrails")?.reason,
    ).toContain("nothing is disabled by it");
  });

  it("stays quiet on a well-formed list", () => {
    expect(inspectConfig('{"disabledGuardrails":["wt.reset-hard"]}').problems).toEqual([]);
  });
});

describe("a file that could not be read at all", () => {
  it("reports the parse error once and does not go on to blame the fields", () => {
    const { problems } = inspectConfig('{"guardrailActionOverrides":{"a":"ask"},');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.where).toBe("config.json");
    expect(problems[0]?.reason).toContain("not valid JSON");
    expect(problems[0]?.reason).toContain("shipped defaults are in force");
  });

  it.each([
    ["JSON null", "null"],
    ["a JSON array", "[1,2]"],
    ["a JSON string", '"hello"'],
    ["a JSON number", "42"],
  ])("%s is reported as not being an object", (_label, text) => {
    const { problems } = inspectConfig(text);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.where).toBe("config.json");
    expect(problems[0]?.reason).toContain("expected a JSON object");
  });

  it("says nothing at all when there is no file — absent is not broken", () => {
    const { config, problems } = inspectConfig(undefined);
    expect(problems).toEqual([]);
    expect(config).toEqual(DEFAULT_CONFIG);
  });
});

describe("the reporter explains the parse and never changes it", () => {
  const SAMPLES: ReadonlyArray<readonly [string, string | undefined]> = [
    ["absent file", undefined],
    ["empty string", ""],
    ["not JSON", "{{{"],
    ["JSON null", "null"],
    ["a JSON array", "[1,2]"],
    ["an empty object", "{}"],
    ["the ask override", '{"guardrailActionOverrides":{"wt.reset-hard":"ask"}}'],
    ["an empty pack list", '{"enabledPacks":[]}'],
    ["an unknown pack", '{"enabledPacks":["working-trees"]}'],
    ["a half-broken allowlist", '{"allowlist":[{"guardrail":"a","pattern":"*"},null]}'],
    ["a half-broken disable list", '{"disabledGuardrails":["a",7]}'],
    ["every flag set", '{"failOpen":false,"crashReports":true,"crashEndpoint":"https://x.test/c"}'],
    ["the file init writes", serializeDefaultConfig()],
  ];

  it.each(SAMPLES)("%s → config is exactly parseConfig's answer", (_label, text) => {
    expect(inspectConfig(text, DEFAULT_ENABLED_PACKS).config).toEqual(parseConfig(text));
  });
});

describe("silence on a healthy file", () => {
  it("the config `init` writes reports no problems", () => {
    // The seed file is the one every new user starts with. If the reporter has anything
    // to say about it, either the writer and the reader disagree or the reporter always
    // fires — and a reporter that always fires is one nobody reads.
    expect(inspectConfig(serializeDefaultConfig(), DEFAULT_ENABLED_PACKS).problems).toEqual([]);
  });

  it("a hand-written file using every key it knows reports no problems", () => {
    const text = JSON.stringify({
      version: 1,
      enabledPacks: ["working-tree", "secret-exposure"],
      disabledGuardrails: ["wt.force-push"],
      guardrailActionOverrides: { "wt.reset-hard": "require_approval" },
      allowlist: [{ guardrail: "dd.rm-rf-absolute", pattern: "rm -rf /tmp/scratch" }],
      failOpen: true,
      crashReports: false,
      crashEndpoint: "https://crash.example.test/v1",
    });
    expect(inspectConfig(text, ["working-tree", "secret-exposure"]).problems).toEqual([]);
  });

  it("an unknown key the guard does not read is not a problem to report", () => {
    // `updateConfigText` preserves keys this build does not understand; reporting them
    // would train users to delete a setting a newer build wrote.
    expect(inspectConfig('{"futureSetting":{"a":1}}').problems).toEqual([]);
  });
});

/**
 * What a config using unrecognized key names looks like to the reporter.
 *
 * `parseConfig` drops every key it does not know back to its default. The question this
 * reporter answers is whether the user is TOLD, and for this config it is told about one
 * of the three keys, by accident of shape.
 *
 * A config carrying `ruleActionOverrides`, `disabledRules` and `allowlist[].rule`
 * produces exactly ONE problem, `allowlist[0]`. The two unknown top-level keys are
 * silent, because `inspectConfig` walks the keys it knows and an unrecognized key is
 * not a problem — the same rule that lets a newer build's setting survive an older one
 * (`futureSetting`, above). The allowlist entry is reported only because it fails the
 * generic `{guardrail, pattern}` shape check.
 *
 * The silence is acceptable because of the DIRECTION every dropped key fails in — an
 * ignored `disabledRules` leaves guardrails running, an ignored `allowlist` suppresses
 * nothing, and an ignored `ruleActionOverrides` leaves the shipped action in force. A
 * user who loses settings this way loses them toward enforcement, never away from it.
 */
describe("a config.json with unrecognized key names", () => {
  const UNRECOGNIZED = JSON.stringify({
    version: 1,
    ruleActionOverrides: { "wt.reset-hard": "warn" },
    disabledRules: ["dd.rm-rf-absolute"],
    allowlist: [{ rule: "wt.reset-hard", pattern: "**" }],
  });

  it("reports the old allowlist entry, and only that", () => {
    expect(inspectConfig(UNRECOGNIZED).problems).toEqual([
      {
        where: "allowlist[0]",
        reason:
          "is not a {guardrail, pattern} object — it was dropped, so whatever it meant to allow is still being matched.",
      },
    ]);
  });

  it("says nothing about the two unrecognized top-level keys", () => {
    const paths = reportedPaths(
      JSON.stringify({ ruleActionOverrides: { a: "block" }, disabledRules: ["b.c"] }),
    );
    expect(paths).toEqual([]);
  });
});
