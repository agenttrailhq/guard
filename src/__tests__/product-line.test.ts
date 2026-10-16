/**
 * The AgentTrail OS line: its wording, its limits, and the two places it must never reach.
 *
 * The commands' own tests drive each surface end to end; this file pins the constant, the
 * once-a-day rule, the off switch, and the hook.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runHook } from "../commands/hook.js";
import { serializeDefaultConfig } from "../core/config.js";
import { inspectConfig } from "../core/config-report.js";
import {
  PRODUCT_LINE,
  type ProductLineContext,
  productLineDue,
  productLineEnabled,
  productLineText,
  productLineUrl,
  recentDecisionCounts,
  recordProductLine,
  takeProductLine,
  writeOrFalse,
} from "../core/product-line.js";
import type { GuardRule } from "../core/types.js";
import type { GuardIO } from "../io.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..", "..");
const NOW = new Date("2026-03-10T12:00:00.000Z");
const HOURS = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

describe("the wording", () => {
  it("links every surface to one destination, tagged by command", () => {
    expect(PRODUCT_LINE.destination).toBe("https://agenttrail.sh/agenttrail-os");
    expect(productLineUrl("init")).toBe(
      "https://agenttrail.sh/agenttrail-os?utm_source=guard&utm_medium=cli&utm_content=init",
    );
    expect(productLineUrl("add")).toContain("utm_content=add");
  });

  it("init: one line for Claude Code and Cursor, none for Codex", () => {
    const line = `Want a teammate to approve risky actions, and every session on record? AgentTrail OS (Team plan): ${productLineUrl("init")}`;
    expect(productLineText({ surface: "init", agent: "claude" })).toBe(line);
    expect(productLineText({ surface: "init", agent: "cursor" })).toBe(line);
    expect(productLineText({ surface: "init", agent: "codex" })).toBeUndefined();
  });

  it("status: asks first, then blocks, then nothing", () => {
    const url = productLineUrl("status");
    expect(productLineText({ surface: "status", asks: 3, blocks: 2 })).toBe(
      `This week guard asked about 3 actions. In AgentTrail OS a teammate approves them from the app (Team plan): ${url}`,
    );
    expect(productLineText({ surface: "status", asks: 1, blocks: 0 })).toContain(
      "asked about 1 action.",
    );
    expect(productLineText({ surface: "status", asks: 0, blocks: 2 })).toBe(
      `Guard blocked 2 actions this week. AgentTrail OS finds the failures agents repeat and suggests the guardrail that stops them: ${url}`,
    );
    expect(productLineText({ surface: "status", asks: 0, blocks: 1 })).toContain(
      "Guard blocked 1 action this week.",
    );
    expect(productLineText({ surface: "status", asks: 0, blocks: 0 })).toBeUndefined();
  });

  it("scan: the would-ask count when there is one, the approved pitch sentence otherwise", () => {
    const url = productLineUrl("scan");
    expect(productLineText({ surface: "scan", agent: "claude", matches: 9, asks: 4 })).toBe(
      `4 of these would have waited for a teammate's approval in AgentTrail OS (Team plan), not a prompt: ${url}`,
    );
    expect(productLineText({ surface: "scan", agent: "cursor", matches: 9, asks: 0 })).toBe(
      `AgentTrail OS finds the failures agents repeat and suggests the guardrail that stops them: ${url}`,
    );
    expect(
      productLineText({ surface: "scan", agent: "claude", matches: 0, asks: 0 }),
    ).toBeUndefined();
    expect(
      productLineText({ surface: "scan", agent: "codex", matches: 9, asks: 4 }),
    ).toBeUndefined();
  });

  it("guardrails add: one line with both ways to share", () => {
    expect(productLineText({ surface: "add", guardrailId: "my.rule" })).toBe(
      `Share it: with everyone, run agenttrail-guard guardrails export my.rule; with your team, AgentTrail OS syncs guardrails to every teammate (Team plan): ${productLineUrl("add")}`,
    );
  });

  it("every line is one line", () => {
    for (const facts of [
      { surface: "init", agent: "claude" },
      { surface: "status", asks: 1, blocks: 1 },
      { surface: "status", asks: 0, blocks: 1 },
      { surface: "scan", agent: "claude", matches: 1, asks: 1 },
      { surface: "scan", agent: "claude", matches: 1, asks: 0 },
      { surface: "add", guardrailId: "x" },
    ] as const) {
      expect(productLineText(facts)).not.toMatch(/[\r\n]/);
    }
  });
});

describe("one constant", () => {
  /** Every non-test source file under `src/`. */
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sources(path);
      return path.endsWith(".ts") ? [path] : [];
    });
  }

  it("only core/product-line.ts spells the destination or the product name", () => {
    const spelled = sources(join(PKG_ROOT, "src"))
      .filter((f) => {
        const text = readFileSync(f, "utf8");
        return text.includes("agenttrail.sh/agenttrail-os") || text.includes("AgentTrail OS (");
      })
      .map((f) => relative(PKG_ROOT, f));
    expect(spelled).toEqual(["src/core/product-line.ts"]);
  });
});

describe("the off switch", () => {
  it("is on unless config.json says false", () => {
    expect(productLineEnabled(undefined)).toBe(true);
    expect(productLineEnabled(serializeDefaultConfig())).toBe(true);
    expect(productLineEnabled('{"productLine": true}')).toBe(true);
    expect(productLineEnabled('{"productLine": false}')).toBe(false);
  });

  it("fails open to on for anything it cannot read, and status names a wrong value", () => {
    expect(productLineEnabled("not json")).toBe(true);
    expect(productLineEnabled("[]")).toBe(true);
    expect(productLineEnabled('{"productLine": "no"}')).toBe(true);
    expect(inspectConfig('{"productLine": "no"}').problems.map((p) => p.where)).toEqual([
      "productLine",
    ]);
    expect(inspectConfig('{"productLine": false}').problems).toEqual([]);
  });

  it("init seeds the switch, set to on, so it is visible in the file", () => {
    expect(JSON.parse(serializeDefaultConfig()).productLine).toBe(true);
  });
});

describe("at most once a day per command", () => {
  it("is due with no record, a day after the last showing, or on a bad stamp", () => {
    expect(productLineDue(undefined, "status", NOW)).toBe(true);
    expect(productLineDue(JSON.stringify({ status: HOURS(23) }), "status", NOW)).toBe(false);
    expect(productLineDue(JSON.stringify({ status: HOURS(24) }), "status", NOW)).toBe(true);
    expect(productLineDue(JSON.stringify({ status: HOURS(25) }), "status", NOW)).toBe(true);
    expect(productLineDue("not json", "status", NOW)).toBe(true);
    expect(productLineDue(JSON.stringify({ status: "yesterday" }), "status", NOW)).toBe(true);
    // A stamp from the future would otherwise silence the line until that date.
    expect(productLineDue(JSON.stringify({ status: HOURS(-48) }), "status", NOW)).toBe(true);
  });

  it("counts each command on its own", () => {
    const state = JSON.stringify({ scan: HOURS(1) });
    expect(productLineDue(state, "scan", NOW)).toBe(false);
    expect(productLineDue(state, "status", NOW)).toBe(true);
    const next = JSON.parse(recordProductLine(state, "status", NOW));
    expect(next).toEqual({ scan: HOURS(1), status: NOW.toISOString() });
  });
});

describe("takeProductLine", () => {
  function context(over: Partial<ProductLineContext> & { files?: Map<string, string> } = {}) {
    const files = over.files ?? new Map<string, string>();
    const ctx: ProductLineContext = {
      interactive: true,
      configText: undefined,
      statePath: "/h/.product-line",
      now: NOW,
      readFile: (p) => files.get(p),
      writeFile: (p, t) => {
        files.set(p, t);
        return true;
      },
      ...over,
    };
    return { ctx, files };
  }
  const STATUS = { surface: "status", asks: 2, blocks: 0 } as const;

  it("returns the line and records the showing; the second run is quiet", () => {
    const { ctx, files } = context();
    expect(takeProductLine(ctx, STATUS)).toBe(productLineText(STATUS));
    expect(JSON.parse(files.get("/h/.product-line") ?? "{}").status).toBe(NOW.toISOString());
    expect(takeProductLine(ctx, STATUS)).toBeUndefined();
  });

  it("is withheld when not interactive, when switched off, or with nothing to say", () => {
    expect(takeProductLine(context({ interactive: false }).ctx, STATUS)).toBeUndefined();
    expect(
      takeProductLine(context({ configText: '{"productLine": false}' }).ctx, STATUS),
    ).toBeUndefined();
    expect(
      takeProductLine(context().ctx, { surface: "status", asks: 0, blocks: 0 }),
    ).toBeUndefined();
  });

  it("writes nothing when it shows nothing", () => {
    const { ctx, files } = context({ interactive: false });
    takeProductLine(ctx, STATUS);
    expect(files.size).toBe(0);
  });

  it("is withheld when the showing cannot be recorded, so it never nags every run", () => {
    const failing = writeOrFalse(() => {
      throw new Error("EROFS: read-only file system");
    });
    expect(takeProductLine(context({ writeFile: failing }).ctx, STATUS)).toBeUndefined();
  });
});

describe("recentDecisionCounts", () => {
  const rec = (decision: string, agent: string, hoursAgo: number) => ({
    ts: HOURS(hoursAgo),
    decision,
    agent,
  });

  it("counts Claude Code and Cursor asks and blocks from the last 7 days", () => {
    expect(
      recentDecisionCounts(
        [
          rec("ask", "claude", 1),
          rec("ask", "cursor", 100),
          rec("deny", "claude", 2),
          rec("allow", "claude", 1),
          rec("ask", "codex", 1),
          rec("deny", "codex", 1),
          rec("ask", "claude", 24 * 8),
          { ts: "", decision: "ask", agent: "claude" },
        ],
        NOW,
      ),
    ).toEqual({ asks: 2, blocks: 1 });
  });
});

describe("never in a hook answer", () => {
  const RULES: GuardRule[] = [
    {
      id: "t.block",
      category: "test",
      severity: "high",
      defaultAction: "block",
      title: "blocks danger",
      description: "",
      match: { any_of: [{ kind: "execute_tool", detail_contains: ["danger"] }] },
    },
    {
      id: "t.ask",
      category: "test",
      severity: "high",
      defaultAction: "require_approval",
      title: "asks about risky",
      description: "",
      match: { any_of: [{ kind: "execute_tool", detail_contains: ["risky"] }] },
    },
    {
      id: "t.warn",
      category: "test",
      severity: "low",
      defaultAction: "warn",
      title: "warns on caution",
      description: "",
      match: { any_of: [{ kind: "execute_tool", detail_contains: ["caution"] }] },
    },
  ];

  const claude = (command: string, event = "PreToolUse") =>
    JSON.stringify({ hook_event_name: event, tool_name: "Bash", tool_input: { command } });
  const cursor = (command: string) =>
    JSON.stringify({ hook_event_name: "beforeShellExecution", command });
  const codex = (command: string) =>
    JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
      turn_id: "01a0c22e-0000-4000-8000-000000000001",
      model: "m",
      tool_use_id: "exec-1",
    });

  const CASES = ["danger", "risky", "caution", "safe"].flatMap((command) => [
    ["claude", claude(command)] as const,
    ["cursor", cursor(command)] as const,
    ["codex", codex(command)] as const,
  ]);
  const EXTRA = [
    ["claude", JSON.stringify({ hook_event_name: "SessionStart" })] as const,
    ["claude", "not json"] as const,
  ];

  /** Every fragment of every line, so no partial copy can slip through either. */
  const FORBIDDEN = [PRODUCT_LINE.destination, "AgentTrail OS", "Team plan", "agenttrail-os"];

  it.each([...CASES, ...EXTRA])("agent %s: %s", async (agent, stdin) => {
    const written: string[] = [];
    const writes: string[] = [];
    const io: GuardIO = {
      readStdin: async () => stdin,
      writeStdout: (t) => {
        written.push(t);
      },
      // The line is switched on and has never been shown: the most permissive state.
      readFile: (p) => (p.endsWith("config.json") ? serializeDefaultConfig() : undefined),
      homedir: () => "/home/test",
      mkdirp: () => true,
      writeFileAtomic: (p) => {
        writes.push(p);
        return true;
      },
      listDir: () => [],
      deleteFile: () => true,
      appendFile: (p) => {
        writes.push(p);
        return true;
      },
      fileSize: () => 0,
    };
    await runHook(io, { catalog: RULES, agent });
    const out = written.join("");
    for (const fragment of FORBIDDEN) expect(out).not.toContain(fragment);
    expect(writes.filter((p) => p.endsWith(".product-line"))).toEqual([]);
  });

  it("the cases reach real answers, so the check above is not vacuous", async () => {
    const written: string[] = [];
    const io = {
      readStdin: async () => claude("danger"),
      writeStdout: (t: string) => {
        written.push(t);
      },
      readFile: () => undefined,
      homedir: () => "/home/test",
      mkdirp: () => true,
      writeFileAtomic: () => true,
      listDir: () => [],
      deleteFile: () => true,
      appendFile: () => true,
      fileSize: () => 0,
    } satisfies GuardIO;
    await runHook(io, { catalog: RULES, agent: "claude" });
    expect(written.join("")).toContain('"permissionDecision":"deny"');
  });

  it("the built hook bundle carries none of it", () => {
    const bundle = readFileSync(join(PKG_ROOT, "plugin", "scripts", "guard-hook.mjs"), "utf8");
    for (const fragment of FORBIDDEN) expect(bundle).not.toContain(fragment);
  });
});
