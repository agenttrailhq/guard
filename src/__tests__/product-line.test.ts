/**
 * The AgentTrail OS line: its wording, its limits, and the two places it must never reach.
 *
 * The commands' own tests drive each surface end to end; this file pins the constant, the
 * once-a-day rule, the off switch, and the hook. It also checks that every link to AgentTrail OS,
 * in the terminal and in the report, starts from the one site address in `core/site.ts`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runHook } from "../commands/hook.js";
import { serializeDefaultConfig } from "../core/config.js";
import { inspectConfig } from "../core/config-report.js";
import { compileAllowlist } from "../core/evaluate.js";
import {
  PRODUCT_LINE,
  type ProductLine,
  type ProductLineContext,
  type ProductLineFacts,
  productLineDue,
  productLineEnabled,
  productLineText,
  productLineUrl,
  recentDecisionCounts,
  recordProductLine,
  takeProductLine,
  writeOrFalse,
} from "../core/product-line.js";
import { PRODUCT_NOTE, renderReport } from "../core/report.js";
import { compileCatalog } from "../core/rules.js";
import { aggregateScan } from "../core/scan-report.js";
import { SITE_PAGES, SITE_URL } from "../core/site.js";
import type { GuardRule } from "../core/types.js";
import type { GuardIO } from "../io.js";
import { TEST_CATALOG } from "./scan-fixtures.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..", "..");
const NOW = new Date("2026-03-10T12:00:00.000Z");
const HOURS = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

/** Every set of facts that has a line, one per wording. */
const EVERY_LINE: readonly ProductLineFacts[] = [
  { surface: "init", agent: "claude" },
  { surface: "status", asks: 1, blocks: 1 },
  { surface: "status", asks: 0, blocks: 1 },
  { surface: "scan", agent: "claude", matches: 1, asks: 1 },
  { surface: "scan", agent: "claude", matches: 1, asks: 0 },
  { surface: "add", guardrailId: "x" },
];

describe("the wording", () => {
  it("links every surface to one destination, tagged by command", () => {
    expect(PRODUCT_LINE.destination).toBe("https://www.agenttrail.sh/agenttrail-os");
    expect(productLineUrl("init")).toBe(
      "https://www.agenttrail.sh/agenttrail-os?utm_source=guard&utm_medium=cli&utm_content=init",
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
    for (const facts of EVERY_LINE) {
      expect(productLineText(facts)).not.toMatch(/[\r\n]/);
    }
  });
});

describe("link or setup", () => {
  /** The constant with its one switch flipped. */
  const SETUP: ProductLine = { ...PRODUCT_LINE, end: "setup" };

  it("links by default", () => {
    expect(PRODUCT_LINE.end).toBe("link");
    for (const facts of EVERY_LINE) {
      expect(productLineText(facts)).toMatch(/: https:\/\/\S+$/);
    }
  });

  it("flipping `end` to setup names the setup command in every line, and changes nothing else", () => {
    for (const facts of EVERY_LINE) {
      const link = productLineText(facts) as string;
      const setup = productLineText(facts, SETUP) as string;
      expect(setup).toBe(
        `${link.slice(0, -productLineUrl(facts.surface).length)}run ${PRODUCT_LINE.setupCommand}`,
      );
      expect(setup).not.toContain(SITE_URL);
      expect(setup).not.toContain("utm_");
    }
    expect(productLineText({ surface: "init", agent: "claude" }, SETUP)).toBe(
      "Want a teammate to approve risky actions, and every session on record? AgentTrail OS (Team plan): run agenttrail setup",
    );
    // Where there is nothing to say, there is still nothing to say.
    expect(productLineText({ surface: "init", agent: "codex" }, SETUP)).toBeUndefined();
    expect(productLineText({ surface: "status", asks: 0, blocks: 0 }, SETUP)).toBeUndefined();
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

  /** The source files whose text `spells` says yes to. */
  function spelledIn(spells: (text: string) => boolean): string[] {
    return sources(join(PKG_ROOT, "src"))
      .filter((f) => spells(readFileSync(f, "utf8")))
      .map((f) => relative(PKG_ROOT, f));
  }

  /** The site's address, with or without `www.`. */
  const spellsSite = (text: string): boolean => /https?:\/\/(www\.)?agenttrail\.sh/.test(text);
  /** Any of the AgentTrail OS pages: the destination, sign-up, the comparison. */
  const spellsOsPage = (text: string): boolean =>
    [SITE_PAGES.os, SITE_PAGES.signup, SITE_PAGES.compare].some((page) => text.includes(page));

  it("only core/product-line.ts spells the product line", () => {
    expect(spelledIn((text) => text.includes("AgentTrail OS ("))).toEqual([
      "src/core/product-line.ts",
    ]);
  });

  it("only core/site.ts spells the site's address", () => {
    expect(spelledIn(spellsSite)).toEqual(["src/core/site.ts"]);
  });

  it("only core/site.ts spells an AgentTrail OS page, so the line, the report and its footer share them", () => {
    expect(spelledIn(spellsOsPage)).toEqual(["src/core/site.ts"]);
  });

  it("negative control — the detectors fire on a spelled address or page", () => {
    expect(spellsSite(`destination: "https://agenttrail.sh/agenttrail-os"`)).toBe(true);
    expect(spellsSite(`const SITE = "https://www.agenttrail.sh";`)).toBe(true);
    expect(spellsSite(`SECURITY_EMAIL = "security@agenttrail.sh"`)).toBe(false);
    expect(spellsOsPage(`link("/agenttrail-os", "footer-os", "AgentTrail OS")`)).toBe(true);
    expect(spellsOsPage(`path: "/guard-vs-os"`)).toBe(true);
    expect(spellsOsPage(`path: "/signup"`)).toBe(true);
  });

  it("the line's destination is the site's AgentTrail OS page, tagged on every surface", () => {
    expect(PRODUCT_LINE.destination).toBe(`${SITE_URL}${SITE_PAGES.os}`);
    for (const surface of ["init", "status", "scan", "add"] as const) {
      expect(productLineUrl(surface)).toBe(
        `${PRODUCT_LINE.destination}?utm_source=guard&utm_medium=cli&utm_content=${surface}`,
      );
    }
  });

  it("the report's AgentTrail OS block and its footer link the same pages on the same site", () => {
    expect(PRODUCT_NOTE.start.path).toBe(SITE_PAGES.signup);
    expect(PRODUCT_NOTE.primary.path).toBe(SITE_PAGES.os);
    expect(PRODUCT_NOTE.secondary.path).toBe(SITE_PAGES.compare);

    const result = aggregateScan(
      { sessions: [], quarantined: 0, notRead: 0, projects: 0, agent: "claude" },
      compileCatalog(TEST_CATALOG),
      compileAllowlist([]),
    );
    const html = renderReport(result, {
      version: "0.0.0",
      generatedAt: new Date("2026-03-10T12:00:00.000Z"),
    });
    const links = [...html.matchAll(/href="(https?:[^"]+)"/g)]
      .map((m) => new URL((m[1] ?? "").replaceAll("&amp;", "&")))
      .filter((url) => spellsOsPage(url.pathname))
      .map((url) => `${url.origin}${url.pathname} ${url.searchParams.get("utm_content")}`)
      .sort();
    expect(links).toEqual(
      [
        `${PRODUCT_LINE.destination} footer-os`,
        `${PRODUCT_LINE.destination} os-demo`,
        `${SITE_URL}${SITE_PAGES.compare} footer-compare`,
        `${SITE_URL}${SITE_PAGES.compare} os-compare`,
        `${SITE_URL}${SITE_PAGES.signup} os-signup`,
      ].sort(),
    );
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
  const FORBIDDEN = [
    PRODUCT_LINE.destination,
    PRODUCT_LINE.setupCommand,
    "AgentTrail OS",
    "Team plan",
    "agenttrail-os",
  ];

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
