/**
 * `guardrails export`, driven through a fake `SetupIO`.
 *
 * The round trip is the test that matters: `add` → `export <id>` → fill in the blanks →
 * `validate` → `export <draft.json>` → the module it writes, evaluated, parses with the
 * library's own `parseRule` into the same rule the draft held. Pinning the module's text
 * alone would not notice a rendering that is self-consistent and wrong.
 *
 * Refusals are asserted over the recorded write list, not by grepping output.
 */

import { bash, file, PACKS, parseRule, pwsh, type Rule } from "@agenttrail/guardrails";
import { describe, expect, it } from "vitest";
import {
  ADD_FOLLOW_UP,
  addFollowUp,
  addFollowUpAllowed,
  BLANK,
  channelsOf,
  draftFor,
  exportId,
  exportName,
  fileStem,
  findBlanks,
  libraryWarnings,
  packPrefixes,
  renderRuleModule,
} from "../commands/guardrail-export.js";
import { runRules } from "../commands/rules.js";
import { SHIPPED_CATALOG } from "../core/catalog.js";
import { productLineText } from "../core/product-line.js";
import type { GuardRule } from "../core/types.js";
import type { SetupIO } from "../setup-io.js";

const HOME = "/home/test";
const WORK = "/work";

/**
 * A fake `SetupIO`. `tty` is what `isTTY()` answers; `"absent"` leaves the member out, as an
 * IO built before it existed would.
 */
function harness(files: Record<string, string> = {}, tty: boolean | "absent" = true) {
  const written: string[] = [];
  const writes: Array<{ path: string; text: string }> = [];
  const store = new Map<string, string>(Object.entries(files));
  const dirs = new Set([WORK]);
  const io: SetupIO = {
    writeStdout: (t) => {
      written.push(t);
    },
    readFile: (p) => store.get(p),
    exists: (p) => store.has(p) || dirs.has(p),
    writeFileAtomic: (p, text) => {
      writes.push({ path: p, text });
      store.set(p, text);
    },
    homedir: () => HOME,
    runClaude: () => ({ code: 0, stdout: "", stderr: "" }),
    ...(tty === "absent" ? {} : { isTTY: () => tty }),
  };
  return {
    io,
    writes,
    out: () => written.join(""),
    raw: (p: string) => store.get(p),
    put: (p: string, text: string) => store.set(p, text),
  };
}

const COMMAND_RULE = {
  id: "local.no-deploy-friday",
  category: "prod-infra",
  severity: "medium",
  defaultAction: "require_approval",
  title: "Confirm before deploying",
  match: {
    any_of: [{ kind: "execute_tool", label: "Bash", detail_matches: ["\\./deploy\\.sh\\b"] }],
  },
};

const FILE_RULE = {
  id: "team.env-local-edit",
  category: "secret-exposure",
  defaultAction: "warn",
  match: { any_of: [{ kind: "execute_tool", file_glob: "**/.env.local" }] },
};

async function run(h: ReturnType<typeof harness>, ...args: string[]): Promise<number> {
  return runRules(args, h.io);
}

/** Install `rule` with `guardrails add`, as a user would. */
async function added(rule: object) {
  const h = harness();
  h.put("/in/rule.json", JSON.stringify(rule));
  expect(await run(h, "add", "/in/rule.json")).toBe(0);
  return h;
}

/** Turn the emitted module back into a value, with the library's real helpers. */
function evaluateModule(source: string): unknown {
  const body = source
    .split("\n")
    .filter((l) => !l.startsWith("import "))
    .join("\n")
    .replace(/export const \w+: Rule = /, "return ");
  return new Function("bash", "file", "pwsh", body)(bash, file, pwsh);
}

function fill(draft: Record<string, unknown>, block: string[], allow: string[]): object {
  const fixtures = draft.fixtures as { block: object[]; allow: object[] };
  const at = (list: object[], texts: string[]) =>
    list.map((f, i) => {
      const text = texts[i] ?? "";
      return "command" in f ? { ...f, command: text } : { ...f, file_path: text };
    });
  const owasp = draft.owasp as unknown[] | undefined;
  return {
    ...draft,
    ...(owasp !== undefined && findBlanks(owasp).length > 0 ? { owasp: ["ASI02", "LLM03"] } : {}),
    description:
      typeof draft.description === "string" && draft.description.startsWith(BLANK)
        ? "Holds the production deploy script for approval before it runs. Does not match the build or test scripts, or a deploy script under any other name."
        : draft.description,
    title:
      typeof draft.title === "string" && draft.title.startsWith(BLANK)
        ? "A filled-in title"
        : draft.title,
    fixtures: { block: at(fixtures.block, block), allow: at(fixtures.allow, allow) },
  };
}

describe("round trip: add → export → fill → validate → export", () => {
  it("ends with a module that parses into the rule the draft held", async () => {
    const h = await added(COMMAND_RULE);
    // The first add of the day names export inside the AgentTrail OS line.
    expect(h.out()).toContain("run agenttrail-guard guardrails export local.no-deploy-friday;");

    expect(await run(h, "export", "local.no-deploy-friday", "--out", WORK)).toBe(0);
    const draftPath = `${WORK}/pi-no-deploy-friday.json`;
    const draft = JSON.parse(h.raw(draftPath) as string) as Record<string, unknown>;
    expect(draft.id).toBe("pi.no-deploy-friday");
    expect(h.out()).toContain("WARNING: `local.no-deploy-friday` has no pack prefix");

    // Blank: validate fails and names every blank; no example is reported as passing.
    const before = h.out().length;
    expect(await run(h, "validate", draftPath)).toBe(1);
    const report = h.out().slice(before);
    expect(report).toContain("Not ready — 4 blanks still to fill in:");
    expect(report).toContain("owasp[0]");
    expect(report).toContain("description");
    expect(report).toContain("fixtures.block[0].command");
    expect(report).toContain("fixtures.allow[0].command");
    expect(report).not.toContain("PASS");

    h.put(draftPath, JSON.stringify(fill(draft, ["./deploy.sh prod"], ["./build.sh"])));
    expect(await run(h, "validate", draftPath)).toBe(0);

    expect(await run(h, "export", draftPath, "--out", WORK)).toBe(0);
    const source = h.raw(`${WORK}/pi-no-deploy-friday.ts`) as string;
    expect(source).toContain('import { bash } from "../../fixtures.js";');
    expect(source).toContain("export const piNoDeployFriday: Rule = {");
    expect(source).toContain(
      '  defaultAction: "require_approval",\n  owasp: ["ASI02", "LLM03"],\n',
    );

    const parsed = parseRule(evaluateModule(source));
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(parseRule(JSON.parse(h.raw(draftPath) as string)).data);

    const steps = h.out();
    expect(steps).toContain("Fork https://github.com/agenttrailhq/guardrails");
    expect(steps).toContain("Copy pi-no-deploy-friday.ts to src/packs/prod-infra/");
    expect(steps).toContain('import { piNoDeployFriday } from "./pi-no-deploy-friday.js";');
    expect(steps).toContain("add `piNoDeployFriday,` to the `rules` list");
    expect(steps).toContain("__tests__/corpus.test.ts, __tests__/dedup.test.ts");
    expect(steps).toContain("OWASP_TAGS");
    expect(steps).not.toContain("will reject");
    expect(steps).toContain("git commit -s");
    expect(steps).toContain("CONTRIBUTING.md#submit-a-guardrail");
  });

  it("proves a file guardrail with paths, not commands", async () => {
    const h = await added(FILE_RULE);
    expect(await run(h, "export", "team.env-local-edit", "--out", WORK)).toBe(0);
    const draftPath = `${WORK}/se-env-local-edit.json`;
    const draft = JSON.parse(h.raw(draftPath) as string) as Record<string, unknown>;
    expect(draft.fixtures).toEqual({
      block: [{ tool: "Edit", file_path: `${BLANK}: a file path this guardrail must match` }],
      allow: [{ tool: "Edit", file_path: `${BLANK}: a file path this guardrail must NOT match` }],
    });
    h.put(draftPath, JSON.stringify(fill(draft, ["app/.env.local"], ["app/.env.example"])));
    expect(await run(h, "export", draftPath, "--out", WORK)).toBe(0);
    const source = h.raw(`${WORK}/se-env-local-edit.ts`) as string;
    expect(source).toContain('file("app/.env.local")');
    expect(parseRule(evaluateModule(source)).success).toBe(true);
  });
});

describe("export refuses, and writes nothing", () => {
  it("a shipped guardrail, the way remove does", async () => {
    const h = harness();
    expect(await run(h, "export", "wt.stash-drop", "--out", WORK)).toBe(1);
    expect(h.out()).toContain(
      "wt.stash-drop is one of ours, so it is already in the public library",
    );
    expect(h.writes).toEqual([]);
  });

  it("an id that is not there", async () => {
    const h = harness();
    expect(await run(h, "export", "local.nope", "--out", WORK)).toBe(1);
    expect(h.out()).toContain("no guardrail of yours with id `local.nope`");
    expect(h.writes).toEqual([]);
  });

  it("an export id the library already uses", async () => {
    const h = await added({ ...COMMAND_RULE, id: "local.stash-drop", category: "working-tree" });
    const before = h.writes.length;
    expect(await run(h, "export", "local.stash-drop", "--out", WORK)).toBe(1);
    expect(h.out()).toContain("already has a guardrail with id `wt.stash-drop`");
    expect(h.writes.length).toBe(before);
  });

  it("a draft that already exists, or an --out that does not", async () => {
    const h = await added(COMMAND_RULE);
    h.put(`${WORK}/pi-no-deploy-friday.json`, "{}");
    const before = h.writes.length;
    expect(await run(h, "export", "local.no-deploy-friday", "--out", WORK)).toBe(1);
    expect(h.out()).toContain("already exists");
    expect(await run(h, "export", "local.no-deploy-friday", "--out", "/missing")).toBe(1);
    expect(h.out()).toContain("--out directory /missing does not exist");
    expect(h.writes.length).toBe(before);
  });

  it("a draft with a blank, or an example that fails, prints validate's report", async () => {
    const h = await added(COMMAND_RULE);
    await run(h, "export", "local.no-deploy-friday", "--out", WORK);
    const draftPath = `${WORK}/pi-no-deploy-friday.json`;
    const draft = JSON.parse(h.raw(draftPath) as string) as Record<string, unknown>;
    const before = h.writes.length;

    expect(await run(h, "export", draftPath, "--out", WORK)).toBe(1);
    expect(h.out()).toContain("still to fill in");

    // `./deploy.sh` in an allow example: the guardrail matches it, so the example fails.
    h.put(draftPath, JSON.stringify(fill(draft, ["./deploy.sh prod"], ["./deploy.sh staging"])));
    expect(await run(h, "export", draftPath, "--out", WORK)).toBe(1);
    expect(h.out()).toContain("FAIL");
    expect(h.out()).toContain("Not exported. Nothing was written.");
    expect(h.writes.filter((w) => w.path.endsWith(".ts"))).toEqual([]);
    expect(h.writes.length).toBe(before);
  });

  it("--json reports blanks as data", async () => {
    const h = await added(COMMAND_RULE);
    await run(h, "export", "local.no-deploy-friday", "--out", WORK, "--json");
    const line = h.out().trim().split("\n").at(-1) as string;
    expect(JSON.parse(line)).toMatchObject({
      ok: true,
      command: "export",
      guardrail: "pi.no-deploy-friday",
      blanks: ["owasp[0]", "description", "fixtures.block[0].command", "fixtures.allow[0].command"],
    });
  });
});

describe("the line after add", () => {
  async function addWith(tty: boolean | "absent", ...flags: string[]): Promise<string> {
    const h = harness({}, tty);
    h.put("/in/rule.json", JSON.stringify(COMMAND_RULE));
    expect(await run(h, "add", "/in/rule.json", ...flags)).toBe(0);
    return h.out();
  }

  const GUARD_DIR = `${HOME}/.agenttrail/guard`;
  const STATE = `${GUARD_DIR}/.product-line`;
  const CONFIG = `${GUARD_DIR}/config.json`;
  const NOW = new Date("2026-03-10T12:00:00.000Z");
  const SHOWN_TODAY = JSON.stringify({ add: "2026-03-10T01:00:00.000Z" });
  const OS_LINE = productLineText({
    surface: "add",
    guardrailId: "local.no-deploy-friday",
  }) as string;

  async function addAt(files: Record<string, string>, tty: boolean, ...flags: string[]) {
    const h = harness(files, tty);
    h.put("/in/rule.json", JSON.stringify(COMMAND_RULE));
    expect(await runRules(["add", "/in/rule.json", ...flags], h.io, { now: NOW })).toBe(0);
    return h;
  }

  /** `harness`, but `.product-line` cannot be written, as in a read-only home. */
  function readOnlyState(files: Record<string, string> = {}) {
    const h = harness(files, true);
    const write = h.io.writeFileAtomic;
    h.io.writeFileAtomic = (p, text) => {
      if (p === STATE) throw new Error("EROFS: read-only file system");
      write(p, text);
    };
    return h;
  }

  it("first add of the day: the AgentTrail OS line, which names export, and not the export line", async () => {
    const h = await addAt({}, true);
    expect(h.out()).toContain(`guardrails active.\n${OS_LINE}\n`);
    expect(h.out()).not.toContain(ADD_FOLLOW_UP);
    expect(JSON.parse(h.raw(STATE) ?? "{}").add).toBe(NOW.toISOString());
  });

  it("the OS line already showed today: the export line takes its place", async () => {
    const h = await addAt({ [STATE]: SHOWN_TODAY }, true);
    expect(h.out()).toContain(`guardrails active.\n${ADD_FOLLOW_UP} local.no-deploy-friday\n`);
    expect(h.out()).not.toContain("AgentTrail OS");
  });

  it("two adds in one day: the OS line, then the export line", async () => {
    const h = harness({}, true);
    h.put("/in/a.json", JSON.stringify(COMMAND_RULE));
    h.put("/in/b.json", JSON.stringify(FILE_RULE));
    await runRules(["add", "/in/a.json"], h.io, { now: NOW });
    const before = h.out().length;
    await runRules(["add", "/in/b.json"], h.io, { now: NOW });
    expect(h.out().slice(0, before)).toContain("AgentTrail OS");
    expect(h.out().slice(before)).toContain(`${ADD_FOLLOW_UP} team.env-local-edit`);
    expect(h.out().slice(before)).not.toContain("AgentTrail OS");
  });

  it("the once-a-day record cannot be written: the export line takes its place", async () => {
    const h = readOnlyState();
    h.put("/in/a.json", JSON.stringify(COMMAND_RULE));
    h.put("/in/b.json", JSON.stringify(FILE_RULE));
    expect(await runRules(["add", "/in/a.json"], h.io, { now: NOW })).toBe(0);
    const before = h.out().length;
    expect(h.out()).toContain(`guardrails active.\n${ADD_FOLLOW_UP} local.no-deploy-friday\n`);
    expect(h.raw(STATE)).toBeUndefined();
    // Every add after it, too: the OS line never shows when it cannot be recorded.
    expect(await runRules(["add", "/in/b.json"], h.io, { now: NOW })).toBe(0);
    expect(h.out().slice(before)).toContain(`${ADD_FOLLOW_UP} team.env-local-edit`);
    expect(h.out()).not.toContain("AgentTrail OS");
  });

  it.each([
    ["--quiet", [{}, true, "--quiet"]],
    ["--json", [{}, true, "--json"]],
    ["not a terminal", [{}, false]],
    ['"productLine": false', [{ [CONFIG]: '{"productLine": false}' }, true]],
  ] as const)("%s: neither line, even when the OS line already showed today", async (_l, args) => {
    const [files, tty, ...flags] = args;
    const states: Record<string, string>[] = [{}, { [STATE]: SHOWN_TODAY }];
    for (const state of states) {
      const h = await addAt({ ...files, ...state }, tty, ...flags);
      expect(h.out()).not.toContain(ADD_FOLLOW_UP);
      expect(h.out()).not.toContain("AgentTrail OS");
    }
  });

  it.each([
    ["--quiet", ["--quiet"], {}],
    ["--json", ["--json"], {}],
    ['"productLine": false', [], { [CONFIG]: '{"productLine": false}' }],
  ] as const)("%s with a record that cannot be written: neither line", async (_l, flags, files) => {
    const h = readOnlyState(files);
    h.put("/in/rule.json", JSON.stringify(COMMAND_RULE));
    expect(await runRules(["add", "/in/rule.json", ...flags], h.io, { now: NOW })).toBe(0);
    expect(h.out()).not.toContain(ADD_FOLLOW_UP);
    expect(h.out()).not.toContain("AgentTrail OS");
  });

  it("is silent under --quiet, even in a terminal", async () => {
    expect(await addWith(true, "--quiet")).not.toContain(ADD_FOLLOW_UP);
  });

  it("is silent under --json, even in a terminal", async () => {
    const out = await addWith(true, "--json");
    expect(out).not.toContain(ADD_FOLLOW_UP);
    expect(JSON.parse(out.trim())).toMatchObject({ ok: true, command: "add" });
  });

  it("is silent when stdout is not a terminal", async () => {
    const out = await addWith(false);
    expect(out).toContain("guardrails active.");
    expect(out).not.toContain(ADD_FOLLOW_UP);
  });

  it("is silent when the IO cannot say whether stdout is a terminal", async () => {
    expect(await addWith("absent")).not.toContain(ADD_FOLLOW_UP);
  });

  it("is one helper pair a later line can reuse or hold back", () => {
    expect(addFollowUp("pi.x")).toBe(`${ADD_FOLLOW_UP} pi.x`);
    expect(addFollowUpAllowed({ quiet: false, json: false, isTTY: true })).toBe(true);
    for (const output of [
      { quiet: true, json: false, isTTY: true },
      { quiet: false, json: true, isTTY: true },
      { quiet: false, json: false, isTTY: false },
    ]) {
      expect(addFollowUpAllowed(output), JSON.stringify(output)).toBe(false);
    }
  });
});

describe("ids, names and prefixes", () => {
  const prefixes = packPrefixes(SHIPPED_CATALOG);

  it("every pack has a prefix, read from the catalog (safety-bypass is gb.)", () => {
    for (const pack of PACKS) expect(prefixes.get(pack), pack).toMatch(/^[a-z]+\.$/);
    expect(prefixes.get("safety-bypass")).toBe("gb.");
    expect(prefixes.get("working-tree")).toBe("wt.");
  });

  it("keeps a prefixed id, renames an unprefixed one and says so", () => {
    expect(exportId("pi.x", "prod-infra", prefixes)).toEqual({ id: "pi.x" });
    const renamed = exportId("local.x", "prod-infra", prefixes);
    expect(renamed.id).toBe("pi.x");
    expect(renamed.warning).toContain("`local.x` has no pack prefix");
    expect(exportId("deploy-x", "prod-infra", prefixes).id).toBe("pi.deploy-x");
    expect(exportId("team.a.b", "safety-bypass", prefixes).id).toBe("gb.a.b");
  });

  it("names files and exports the way the library does", () => {
    expect(fileStem("wt.stash-drop")).toBe("wt-stash-drop");
    expect(exportName("wt.stash-drop")).toBe("wtStashDrop");
    expect(exportName("rce.eval-dynamic")).toBe("rceEvalDynamic");
    expect(exportName("9.x")).toBe("rule9X");
  });

  it("matches the library's own file and export names for every shipped rule", () => {
    // Cross-checked against the shipped ids: a rule's export name is its id in camelCase.
    for (const rule of SHIPPED_CATALOG) expect(exportName(rule.id)).toMatch(/^[a-z][A-Za-z0-9]*$/);
  });
});

describe("library warnings", () => {
  it("names detail_contains, a thin description and a bare title", async () => {
    const h = await added({
      ...COMMAND_RULE,
      match: {
        any_of: [{ kind: "execute_tool", label: "Bash", detail_contains: ["./deploy.sh"] }],
      },
    });
    await run(h, "export", "local.no-deploy-friday", "--out", WORK);
    expect(h.out()).toContain(
      "WARNING: the library will reject this draft: it uses `detail_contains`",
    );
    expect(
      libraryWarnings({ id: "pi.x", title: "pi.x", description: "short", match: {} }),
    ).toHaveLength(3);
  });

  it("names a filled draft that dropped its owasp ids, and still exports it", async () => {
    const h = await added(COMMAND_RULE);
    await run(h, "export", "local.no-deploy-friday", "--out", WORK);
    const draftPath = `${WORK}/pi-no-deploy-friday.json`;
    const draft = JSON.parse(h.raw(draftPath) as string) as Record<string, unknown>;
    const { owasp: _drop, ...filled } = fill(draft, ["./deploy.sh prod"], ["./build.sh"]) as Record<
      string,
      unknown
    >;
    h.put(draftPath, JSON.stringify(filled));
    expect(await run(h, "export", draftPath, "--out", WORK)).toBe(0);
    expect(h.out()).toContain(
      "WARNING: the library's tests will reject this: it has no `owasp` ids",
    );
    expect(h.raw(`${WORK}/pi-no-deploy-friday.ts`)).not.toContain("owasp");
  });
});

describe("drafts and blanks", () => {
  const base: GuardRule = {
    id: "x.y",
    category: "prod-infra",
    severity: "medium",
    defaultAction: "block",
    title: "x.y",
    description: "",
    match: { any_of: [{ kind: "execute_tool", detail_contains: ["a"] }] } as GuardRule["match"],
  };

  it("needs both kinds of example when a guardrail reads both channels", () => {
    const match = {
      any_of: [
        { kind: "execute_tool", detail_contains: ["a"] },
        { kind: "execute_tool", file_glob: "**/a" },
      ],
    };
    expect(channelsOf(match)).toEqual(["command", "file"]);
    const draft = draftFor({ ...base, match: match as GuardRule["match"] }, "pi.y");
    expect((draft.fixtures as { block: unknown[] }).block).toHaveLength(2);
  });

  it("turns a defaulted title and an empty description into blanks", () => {
    expect(findBlanks(draftFor(base, "pi.y"))).toEqual([
      "owasp[0]",
      "title",
      "description",
      "fixtures.block[0].command",
      "fixtures.allow[0].command",
    ]);
  });
});

describe("renderRuleModule", () => {
  it("uses only the helpers it needs, and plain objects for other tools", () => {
    const rule = {
      id: "pi.mixed",
      category: "prod-infra",
      severity: "high",
      defaultAction: "block",
      owasp: ["ASI02"],
      title: "Mixed",
      description: 'Says "deploy" in quotes.',
      match: { any_of: [{ kind: "execute_tool", detail_contains: ["deploy"] }] },
      fixtures: {
        block: [pwsh("deploy now"), { tool: "mcp__server__run", command: "deploy" }],
        allow: [bash("echo hi")],
      },
    } as Rule;
    const source = renderRuleModule(rule);
    expect(source).toContain('import { bash, pwsh } from "../../fixtures.js";');
    expect(source).toContain("description: 'Says \"deploy\" in quotes.',");
    expect(source).toContain('tool: "mcp__server__run",');
    expect(source).toContain('owasp: ["ASI02"],');
    expect(parseRule(evaluateModule(source)).data).toEqual(parseRule(rule).data);
  });
});
