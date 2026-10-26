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
import { escapeHtml, type RenderOptions, type ReportMeta, renderReport } from "../core/report.js";
import { LOGO_LOCKUP_SVG, LOGO_MARK_SVG } from "../core/report-brand.js";
import { compileCatalog } from "../core/rules.js";
import { aggregateScan, type ScanResult } from "../core/scan-report.js";
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
import {
  LOCAL_FIX_CATEGORIES,
  TEST_ONLY_BUILDERS,
  VERIFIED_META,
  VERIFIED_RESULT,
} from "./verified-corpus.js";

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

/** The fixture's library rules with OWASP ids, as shipped guardrails carry them. */
const RM_RF: GuardRule = { ...RULE_RM_RF, owasp: ["ASI02", "LLM03"] };
const ENV_FILE: GuardRule = { ...RULE_ENV_FILE, owasp: ["LLM02"] };
const GIT_CHECKOUT: GuardRule = { ...RULE_GIT_CHECKOUT, owasp: ["ASI02"] };
const LIBRARY = TEST_CATALOG.map((rule) =>
  rule === RULE_RM_RF
    ? RM_RF
    : rule === RULE_ENV_FILE
      ? ENV_FILE
      : rule === RULE_GIT_CHECKOUT
        ? GIT_CHECKOUT
        : rule,
);

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
            bash("./deploy.sh production", "11"),
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
    // A reader that counts what it could not use, so "What was not evaluated" is rendered.
    capabilities: { tokens: true, skips: true },
    skipped: {
      unparseableLines: 1,
      truncatedLastLines: 0,
      unknownRecords: 0,
      turnsEndedWithError: 1,
      unreadableFiles: 0,
    },
  },
  compileCatalog([...LIBRARY, OWN_RULE]),
  compileAllowlist([]),
  // The fixture's own library: the user's rule is not in it.
  new Set([RM_RF, ENV_FILE, GIT_CHECKOUT]),
);

/**
 * The page with its constant parts replaced: the bundled library's version line, and the
 * bodies of the stylesheet, the script and the logo, which are pinned by their own tests
 * (`report.test.ts` for the styles and logo, the policy hash for the script). What is left
 * is the markup this corpus produces.
 */
function render(
  variant: "document" | "artifact",
  result: ScanResult = RESULT,
  options: RenderOptions = {},
): string {
  const line = formatCatalogStamp(catalogStamp(), META.generatedAt);
  return renderReport(result, META, { ...options, variant })
    .split(line)
    .join("guardrail library vX.Y.Z")
    .split(escapeHtml(line))
    .join("guardrail library vX.Y.Z")
    .replace(/<style>[\s\S]*?<\/style>/, "<style>(stylesheet)</style>")
    .replace(/<script>[\s\S]*?<\/script>/, "<script>(script)</script>")
    .replace(/script-src 'sha256-[^']+'/, "script-src 'sha256-(hash)'")
    .split(LOGO_LOCKUP_SVG)
    .join('<svg class="lockup">(logo)</svg>')
    .split(LOGO_MARK_SVG)
    .join('<svg class="mark">(mark)</svg>');
}

describe("the golden report", () => {
  it("the corpus reaches every section", () => {
    expect(RESULT.riskyByAction).toEqual({ block: 3, require_approval: 5, warn: 1 });
    const html = render("document");
    for (const part of [
      'id="would-do"',
      '<div class="hint">',
      'id="fix-first"',
      '<article class="card">',
      'id="owasp"',
      '<ul class="owasp-ids"',
      'id="risk-filter"',
      'id="findings"',
      'id="repeats"',
      'id="next-steps"',
      'id="share"',
      'id="privacy"',
      'id="redaction"',
      'id="scanned"',
      'id="not-evaluated"',
      'id="tokens"',
      'id="os"',
      "<footer>",
    ]) {
      expect(html, part).toContain(part);
    }
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

  it("replaces the library's version line, so a library release leaves the golden pages alone", () => {
    for (const variant of ["document", "artifact"] as const) {
      expect(render(variant)).not.toMatch(/guardrail library v\d/);
      expect(render(variant)).toContain("guardrail library vX.Y.Z");
    }
  });

  it.each(LEAKS)("the golden pages carry no $name", ({ pattern }) => {
    expect(scanned(render("document"))).not.toMatch(pattern);
    expect(scanned(render("artifact"))).not.toMatch(pattern);
  });
});

/**
 * The verified report, from the synthetic verified corpus: the real secrets card, and test-only
 * cards for the categories with no check in this build. Rendered at the golden pages' own time.
 */
describe("the golden verified report", () => {
  const OPTIONS: RenderOptions = {
    cardBuilders: TEST_ONLY_BUILDERS,
    localFixCategories: LOCAL_FIX_CATEGORIES,
  };
  const verified = (variant: "document" | "artifact"): string =>
    render(variant, VERIFIED_RESULT, OPTIONS);

  it("the corpus reaches every verified section, at the golden pages' time", () => {
    expect(VERIFIED_META.generatedAt).toEqual(META.generatedAt);
    const html = verified("document");
    for (const part of [
      'data-template="secrets.headline"',
      'class="lead totals"',
      'id="found"',
      'id="also-checked"',
      'id="what-happened"',
      'class="card verified v-act"',
      'class="card verified v-review"',
      'class="card verified v-clean"',
      'class="card verified v-could-not-check"',
      'class="card verified v-not-checked"',
      'class="note fixes-file"',
    ]) {
      expect(html, part).toContain(part);
    }
  });

  it("the standalone page matches the golden file", async () => {
    await expect(verified("document")).toMatchFileSnapshot(
      "__snapshots__/report-verified.golden.html",
    );
  });

  it("the artifact matches its golden file", async () => {
    await expect(verified("artifact")).toMatchFileSnapshot(
      "__snapshots__/report-verified-artifact.golden.html",
    );
  });

  it.each(LEAKS)("the verified golden pages carry no $name", ({ pattern }) => {
    expect(scanned(verified("document"))).not.toMatch(pattern);
    expect(scanned(verified("artifact"))).not.toMatch(pattern);
  });
});
