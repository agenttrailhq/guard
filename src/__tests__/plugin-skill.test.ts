// cspell:words artifactt
/**
 * The plugin's `share-report` skill: prose Claude Code follows, holding one command.
 *
 * No compiler reads a SKILL.md, so a renamed `scan` flag or a moved bundle would leave the
 * skill telling Claude to run a command that fails — in a user's session, not here. These
 * tests parse the skill's command with the scan command's own flag parser, and pin the
 * frontmatter properties the skill's safety depends on.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseScanFlags } from "../commands/scan.js";
import { compileAllowlist } from "../core/evaluate.js";
import { renderReport } from "../core/report.js";
import { compileCatalog } from "../core/rules.js";
import { aggregateScan } from "../core/scan-report.js";
import { TEST_CATALOG } from "./scan-fixtures.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILL = join(PKG_ROOT, "plugin", "skills", "share-report", "SKILL.md");
/** Claude Code's own substitution, written literally in the skill — not a JS placeholder. */
const PLUGIN_ROOT = ["$", "{CLAUDE_PLUGIN_ROOT}"].join("");
const TEXT = readFileSync(SKILL, "utf8");

/** The frontmatter as key → single-line value. */
function frontmatter(markdown: string): Record<string, string> {
  const lines = markdown.split("\n");
  const end = lines.indexOf("---", 1);
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const at = line.indexOf(":");
    if (at > 0) fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return fields;
}

/** A command line split into arguments, honouring single and double quotes. */
function argv(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
}

/** Every fenced code block's body. */
function fences(markdown: string): string[] {
  return [...markdown.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => (m[1] ?? "").trim());
}

const FIELDS = frontmatter(TEXT);
const COMMANDS = fences(TEXT).filter((block) => block.includes("guard-scan.mjs"));
/** Everything after the quoted script path: the arguments `scan` itself receives. */
const SCAN_ARGS = argv(COMMANDS[0]?.split('guard-scan.mjs"')[1] ?? "").filter((a) => a !== "");

describe("the skill's frontmatter", () => {
  it("opens the file, where Claude Code looks for it", () => {
    expect(TEXT.startsWith("---\n")).toBe(true);
  });

  it("is named share-report, so it is /agenttrail-guard:share-report", () => {
    expect(FIELDS.name).toBe("share-report");
  });

  it("keeps its description and trigger text inside the length Claude Code reads", () => {
    const length = (FIELDS.description ?? "").length + (FIELDS.when_to_use ?? "").length;
    expect(length).toBeGreaterThan(100);
    expect(length).toBeLessThanOrEqual(1536);
  });

  it("pre-approves no tool, so Claude Code's own prompt before publishing stays", () => {
    expect(FIELDS).not.toHaveProperty("allowed-tools");
    expect(TEXT).not.toMatch(/allowed-tools/);
  });

  it("injects no shell output into the prompt", () => {
    expect(TEXT).not.toContain("```!");
    expect(TEXT).not.toMatch(/!`/);
  });
});

describe("the skill's command", () => {
  it("is exactly one command, running the plugin's own scan bundle", () => {
    expect(COMMANDS).toHaveLength(1);
    expect(COMMANDS[0]).toContain(`node "${PLUGIN_ROOT}/scripts/guard-scan.mjs"`);
    expect(existsSync(join(PKG_ROOT, "plugin", "scripts", "guard-scan.mjs"))).toBe(true);
  });

  it("uses only flags scan accepts, and the ones publishing depends on", () => {
    const flags = parseScanFlags(SCAN_ARGS);
    expect(flags.unknown).toBeUndefined();
    expect(flags).toMatchObject({
      agent: "claude",
      review: false,
      artifact: true,
      noOpen: true,
      json: false,
    });
    expect(flags.out).toBe("<dir>/agenttrail-guard-report.html");
  });

  it("negative control — a misspelled flag in the same command is caught", () => {
    const mangled = SCAN_ARGS.map((a) => (a === "--artifact" ? "--artifactt" : a));
    expect(parseScanFlags(mangled).unknown).toBe("--artifactt");
  });

  it("does not run --review, which would print raw MCP payload values into the chat", () => {
    // `--review` discloses each MCP call's actual values so a person at a terminal can
    // judge them; the report itself carries only `<value>`. Run by the skill, those
    // values would land in the conversation, so the skill's command must not ask for it.
    expect(COMMANDS[0]).not.toContain("--review");
    expect(COMMANDS[0]?.startsWith('node "')).toBe(true);
    expect(TEXT).toContain("Do not add `--review`");
  });

  it("names the section it tells Claude to quote, and a Claude Code report has it", () => {
    expect(TEXT).toContain('"Before you share this"');
    const result = aggregateScan(
      { sessions: [], quarantined: 0, notRead: 0, projects: 0 },
      compileCatalog(TEST_CATALOG),
      compileAllowlist([]),
    );
    const page = renderReport(
      result,
      { version: "0.0.0", generatedAt: new Date(0) },
      {
        variant: "artifact",
      },
    );
    expect(page).toContain("<h2>Before you share this</h2>");
  });
});

describe("the plugin version", () => {
  it("matches the package, because Claude Code refreshes a plugin only when it changes", () => {
    const plugin = JSON.parse(
      readFileSync(join(PKG_ROOT, "plugin", ".claude-plugin", "plugin.json"), "utf8"),
    );
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
    expect(plugin.version).toBe(pkg.version);
  });
});
