/**
 * The whole report, rendered from one synthetic corpus, held as a golden file.
 *
 * Any change to the page shows up as a diff of `__snapshots__/report.golden.html`, which is
 * reviewed like code: `vitest -u` rewrites it. The corpus is made up, and the golden file is
 * held to the same leak patterns as every committed fixture.
 *
 * The bundled guardrail library's version line is replaced with a fixed one, so a library
 * release does not change the golden file. The line is replaced as written in the data block
 * and as escaped in the page, which differ when a library published after the fixed date adds
 * a note with an apostrophe in it.
 */

import { describe, expect, it } from "vitest";
import { catalogStamp, formatCatalogStamp } from "../core/catalog-stamp.js";
import { compileAllowlist } from "../core/evaluate.js";
import { escapeHtml, type ReportMeta, renderReport } from "../core/report.js";
import { compileCatalog } from "../core/rules.js";
import { aggregateScan } from "../core/scan-report.js";
import type { GuardRule } from "../core/types.js";
import { LEAKS, scanned } from "./fixture-hygiene.js";
import {
  bash,
  RULE_ENV_FILE,
  RULE_GIT_CHECKOUT,
  RULE_RM_RF,
  session,
  TEST_CATALOG,
  toolUse,
  turn,
} from "./scan-fixtures.js";

const META: ReportMeta = { version: "9.9.9", generatedAt: new Date("2026-10-01T09:00:00.000Z") };

/** A guardrail the user wrote, to show how one is kept apart from the library. */
const OWN_RULE: GuardRule = {
  id: "team.deploy-script",
  category: "team",
  severity: "high",
  defaultAction: "require_approval",
  title: "Ask before running the deploy script",
  description: "Written by the team.",
  match: {
    any_of: [{ kind: "execute_tool", label: "Bash", detail_contains: ["./deploy.sh"] }],
  },
};

const RESULT = aggregateScan(
  {
    sessions: [
      session([
        turn(
          [
            bash("rm -rf /Users/sample/app/build", "1"),
            bash("rm -rf /Users/sample/app/dist", "2"),
            bash("rm -rf /Users/sample/app/coverage", "3"),
            toolUse("Read", { file_path: "/srv/app/.env" }, "4"),
            toolUse("Read", { file_path: "/srv/app/.env.local" }, "5"),
            bash("git checkout -- src/a.ts", "6"),
            bash("./deploy.sh staging", "7"),
            bash("./deploy.sh staging", "8"),
            bash("npm test", "9"),
            bash("ls -la", "10"),
          ],
          {
            input_tokens: 1200,
            output_tokens: 340,
            cache_read_input_tokens: 98_000,
            cache_creation_input_tokens: 4200,
            cache_creation: { ephemeral_5m_input_tokens: 4000, ephemeral_1h_input_tokens: 200 },
          },
        ),
      ]),
    ],
    quarantined: 1,
    notRead: 0,
    projects: 2,
  },
  compileCatalog([...TEST_CATALOG, OWN_RULE]),
  compileAllowlist([]),
  // The fixture's own library: the user's rule is not in it.
  new Set([RULE_RM_RF, RULE_ENV_FILE, RULE_GIT_CHECKOUT]),
);

/** The page with the bundled library's version line fixed. */
function render(variant: "document" | "artifact"): string {
  const line = formatCatalogStamp(catalogStamp(), META.generatedAt);
  return renderReport(RESULT, META, { variant })
    .split(line)
    .join("guardrail library vX.Y.Z")
    .split(escapeHtml(line))
    .join("guardrail library vX.Y.Z");
}

describe("the golden report", () => {
  it("the corpus reaches every section", () => {
    expect(RESULT.riskyByAction).toEqual({ block: 3, require_approval: 4, warn: 1 });
    expect(RESULT.recurring.length).toBeGreaterThan(0);
    expect(RESULT.findings.map((f) => f.source).sort()).toEqual([
      "library",
      "library",
      "library",
      "yours",
    ]);
  });

  it("the standalone page matches the golden file", async () => {
    await expect(render("document")).toMatchFileSnapshot("__snapshots__/report.golden.html");
  });

  it("the artifact matches its golden file", async () => {
    await expect(render("artifact")).toMatchFileSnapshot(
      "__snapshots__/report-artifact.golden.html",
    );
  });

  it.each(LEAKS)("the golden pages carry no $name", ({ pattern }) => {
    expect(scanned(render("document"))).not.toMatch(pattern);
    expect(scanned(render("artifact"))).not.toMatch(pattern);
  });
});
