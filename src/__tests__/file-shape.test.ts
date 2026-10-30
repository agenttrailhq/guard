/**
 * What a file-tool call is shown as: the tool and the kind of file, a well-known name kept, and
 * nothing else of the path, whichever surface shows it.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderSummary } from "../commands/scan.js";
import { SHIPPED_CATALOG } from "../core/catalog.js";
import { compileAllowlist } from "../core/evaluate.js";
import { FILE_KINDS, fileShapeOf, knownFileName, UNKNOWN_FILE_KIND } from "../core/file-shape.js";
import { renderJson, renderReport } from "../core/report.js";
import { compileCatalog } from "../core/rules.js";
import { aggregateScan, type ScanCorpus } from "../core/scan-report.js";
import { session, toolUse, turn } from "./scan-fixtures.js";
import { scan } from "./workers-fixtures.js";

const SHIPPED = compileCatalog(SHIPPED_CATALOG);
const NO_ALLOWLIST = compileAllowlist([]);
const META = { version: "0.0.0", generatedAt: new Date("2026-10-01T09:00:00.000Z") };

const corpusOf = (sessions: ScanCorpus["sessions"]): ScanCorpus => ({
  sessions,
  quarantined: 0,
  projects: 1,
  notRead: 0,
});

describe("knownFileName", () => {
  it.each([
    ["/w/p/vitest.config.ts", "vitest.config.ts"],
    ["/w/p/vitest.workspace.mts", "vitest.workspace.mts"],
    ["/w/p/jest.config.js", "jest.config.js"],
    ["C:\\w\\p\\package.json", "package.json"],
    ["/w/p/CLAUDE.md", "CLAUDE.md"],
    ["/home/u/.claude/projects/-w-p/memory/MEMORY.md", "MEMORY.md"],
    ["/w/p/.env", ".env"],
    ["/w/p/.env.local", ".env.local"],
    ["/w/p/.env.production", ".env.production"],
    ["/w/p/.github/workflows/release-zebra.yml", ".github/workflows/<file>.yml"],
    ["/w/p/.github/workflows/ci.yaml", ".github/workflows/<file>.yaml"],
  ])("keeps the well-known name of %s", (path, shown) => {
    expect(knownFileName(path)).toBe(shown);
  });

  it.each([
    "/w/p/zebra-client-notes.md",
    "/w/p/vitest.config.ts.bak",
    "/w/p/my-vitest.config.ts",
    "/w/p/.env.zebra-client",
    "/w/p/CLAUDE.md.orig",
    "/w/p/package.json5",
    "/w/p/.github/workflows/nested/deploy.yml",
    "/w/p/.github/workflows/notes.txt",
    "",
  ])("keeps no name of %s", (path) => {
    expect(knownFileName(path)).toBeUndefined();
  });
});

describe("fileShapeOf", () => {
  it("names the kind of file the guardrail looks for when the name is not a well-known one", () => {
    expect(fileShapeOf("Edit", "/w/p/tests/setup-zebra.ts", "ti.test-config-edit")).toBe(
      "Edit <test config>",
    );
    expect(
      fileShapeOf("Write", "/h/.claude/projects/x/memory/zebra.md", "ac.memory-store-edit"),
    ).toBe("Write <agent memory file>");
    expect(fileShapeOf("Read", "/h/.ssh/id_zebra", "se.credential-file")).toBe(
      "Read <credentials file>",
    );
    expect(fileShapeOf("Edit", "/w/p/Jenkinsfile.zebra", "fs.ci-definition")).toBe(
      "Edit <CI workflow>",
    );
  });

  it("keeps a well-known name whichever guardrail matched", () => {
    expect(fileShapeOf("Edit", "/w/p/vitest.config.ts", "ti.test-config-edit")).toBe(
      "Edit vitest.config.ts",
    );
    expect(fileShapeOf("Edit", "/w/p/.github/workflows/zebra.yml", "fs.ci-definition")).toBe(
      "Edit .github/workflows/<file>.yml",
    );
  });

  it("says `<file>` for a guardrail with no kind, such as one the user wrote", () => {
    expect(fileShapeOf("Edit", "/w/p/zebra.md", "team.zebra")).toBe(`Edit <${UNKNOWN_FILE_KIND}>`);
  });

  it("shows a tool name that is not a plain name as a file tool", () => {
    expect(fileShapeOf("Edit /zebra", "/w/p/zebra.md", "team.x")).toBe("File tool <file>");
  });

  it("has a kind for every shipped guardrail that matches by file", () => {
    const byFile = SHIPPED_CATALOG.filter((rule) =>
      JSON.stringify(rule.match).includes("file_glob"),
    );
    expect(byFile.length).toBeGreaterThan(5);
    for (const rule of byFile) expect(FILE_KINDS[rule.id], rule.id).toBeDefined();
  });
});

/** Synthetic file-tool calls, each matching one shipped guardrail, under distinctive names. */
const CALLS = [
  ["Edit", "/w/zebra-app/vitest.config.ts"],
  ["Edit", "/w/zebra-app/vitest.config.ts"],
  ["Edit", "/w/zebra-app/pytest.ini"],
  ["Edit", "/w/zebra-app/pytest.ini"],
  ["Write", "/h/.claude/projects/-w-zebra-app/memory/zebra-client-notes.md"],
  ["Write", "/h/.claude/projects/-w-zebra-app/memory/zebra-deal.md"],
  ["Edit", "/w/zebra-app/.github/workflows/zebra-release.yml"],
  ["Edit", "/w/zebra-app/.github/workflows/zebra-nightly.yml"],
  ["Read", "/h/.ssh/id_zebra_rsa.pem"],
  ["Read", "/h/zebra/keys/zebra-prod.pem"],
] as const;

const corpus = (): ScanCorpus =>
  corpusOf([
    session([
      turn(
        CALLS.map(([tool, path], i) =>
          toolUse(
            tool,
            { file_path: path, old_string: "a", new_string: "b", content: "c" },
            `t${i}`,
          ),
        ),
      ),
    ]),
  ]);

describe("repeat rows for file-tool calls", () => {
  const result = aggregateScan(corpus(), SHIPPED, NO_ALLOWLIST);

  it("split into one row per kind of file, each with its own count and guardrail", () => {
    expect(result.recurring.map((r) => [r.text, r.count, r.ruleId])).toEqual([
      ["Edit .github/workflows/<file>.yml", 2, "fs.ci-definition"],
      ["Edit <test config>", 2, "ti.test-config-edit"],
      ["Edit vitest.config.ts", 2, "ti.test-config-edit"],
      ["Read <credentials file>", 2, "se.credential-file"],
      ["Write <agent memory file>", 2, "ac.memory-store-edit"],
    ]);
  });

  it("count distinct shapes in the facts strip", () => {
    const html = renderReport(result, META);
    expect(html).toMatch(/>5<\/[a-z]+>\s*<[^>]+>Repeated command shapes</);
  });

  it("never show a name off the allowlist, a project or a user's folder, on any surface", () => {
    const outputs = [
      JSON.stringify(result),
      renderJson(result, META),
      renderReport(result, META),
      renderSummary(result, false, "/r.html"),
    ];
    for (const out of outputs) {
      for (const leak of ["zebra", "id_", "/w/", "/h/", ".pem", "pytest.ini", "memory/"]) {
        expect(out, leak).not.toContain(leak);
      }
    }
  });

  it("negative control: the leak check sees a name when it is there", () => {
    expect(JSON.stringify(corpus())).toContain("zebra");
  });
});

describe("a scan of a synthetic transcript", () => {
  /** A Claude Code transcript holding these file-tool calls. */
  function transcript(): string {
    const root = mkdtempSync(join(tmpdir(), "agenttrail-file-shape-"));
    const folder = join(root, "-synthetic-zebra");
    mkdirSync(folder, { recursive: true });
    const lines = CALLS.map(([tool, path], i) =>
      JSON.stringify({
        sessionId: "s",
        cwd: "/w/zebra-app",
        timestamp: "2026-10-01T00:00:00.000Z",
        type: "assistant",
        uuid: `a${i}`,
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: `t${i}`,
              name: tool,
              input: { file_path: path, old_string: "a", new_string: "b", content: "c" },
            },
          ],
        },
      }),
    );
    writeFileSync(join(folder, "s.jsonl"), `${lines.join("\n")}\n`);
    return root;
  }

  it("shows the kinds in the report, the summary and --json, and no name off the allowlist", async () => {
    const root = transcript();
    const page = await scan(root, ["--no-checks"]);
    const json = await scan(root, ["--json", "--no-checks"]);
    for (const shape of ["Edit &lt;test config&gt;", "Write &lt;agent memory file&gt;"]) {
      // Shapes are drawn token by token, so the spans come out first.
      expect(page.report.replace(/<span[^>]*>|<\/span>/g, "")).toContain(shape);
    }
    expect(page.stdout).toContain("Write <agent memory file>");
    expect(json.stdout).toContain('"text": "Read <credentials file>"');
    for (const out of [page.report, page.stdout, json.stdout]) {
      expect(out).not.toContain("zebra");
      expect(out).not.toContain("Edit <path>");
    }
  });
});
