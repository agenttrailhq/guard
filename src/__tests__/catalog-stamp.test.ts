/**
 * The bundled catalog stamp, and its age arithmetic.
 *
 * The age is the part worth testing hard. "62 days ago" computed from a publish date
 * is the classic off-by-one: a boundary that rounds the wrong way, a negative that
 * renders as "in 3 days" on a clock-skewed machine, a singular "1 days". Each of those
 * is checked below at the exact millisecond it would flip: a wrong age is worse than no
 * age.
 *
 * Every case uses epoch arithmetic on UTC instants, which is also the point: the
 * renderer counts elapsed 24-hour periods rather than calendar days, so no test here
 * needs a timezone and no user's answer depends on theirs.
 */

import { CATALOG_PUBLISHED_AT, CATALOG_VERSION } from "@agenttrail/guardrails/guardrails";
import { describe, expect, it } from "vitest";
import { type CatalogStamp, catalogStamp, formatCatalogStamp } from "../core/catalog-stamp.js";
import { compileAllowlist } from "../core/evaluate.js";
import { PRODUCT_NOTE, renderJson, renderReport } from "../core/report.js";
import { compileCatalog } from "../core/rules.js";
import { aggregateScan } from "../core/scan-report.js";
import { VERSION } from "../core/version.js";
import { TEST_CATALOG } from "./scan-fixtures.js";

const PUBLISHED = "2026-06-01T12:00:00Z";
const PUBLISHED_MS = Date.parse(PUBLISHED);
const STAMP: CatalogStamp = { version: "0.4.0", publishedAt: PUBLISHED };

/** An empty scan, built through the real aggregator so it cannot drift from the type. */
const EMPTY_RESULT = aggregateScan(
  { sessions: [], quarantined: 0, notRead: 0, projects: 0 },
  compileCatalog(TEST_CATALOG),
  compileAllowlist([]),
);

/** Render the stamp as it would read `offset` milliseconds after publication. */
function at(offset: number, stamp: CatalogStamp = STAMP): string {
  return formatCatalogStamp(stamp, new Date(PUBLISHED_MS + offset));
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("catalogStamp — what it reports", () => {
  it("reports the BUNDLED catalog's version, not the guard's own", () => {
    // The guard bundles the catalog at build time, so the catalog package's version is
    // what determines which rules a user has; the guard's version answers a different
    // question.
    expect(catalogStamp().version).toBe(CATALOG_VERSION);
  });

  it("carries the catalog package's publication date verbatim", () => {
    expect(catalogStamp().publishedAt).toBe(CATALOG_PUBLISHED_AT);
  });

  it("is a real stamp now, not the seam's `undefined`", () => {
    expect(catalogStamp()).not.toBeUndefined();
    expect(catalogStamp().publishedAt).toBeDefined();
  });

  it("renders a real age against the real clock — no degraded fallback in the shipped path", () => {
    // Guards the case where the shipped stamp is malformed: the renderer would quietly
    // fall back to "not recorded" and the feature would ship doing nothing.
    const rendered = formatCatalogStamp(catalogStamp(), new Date());
    expect(rendered).toMatch(/^guardrail library v\d+\.\d+\.\d+, published (today|\d+ days? ago)$/);
    expect(rendered).not.toContain("not recorded");
    expect(rendered).not.toContain("not yet stamped");
  });
});

describe("the age boundaries", () => {
  it("the instant of publication reads as today, not as 0 days ago", () => {
    expect(at(0)).toBe("guardrail library v0.4.0, published today");
  });

  it("one millisecond short of 24 hours is still today", () => {
    expect(at(DAY - 1)).toBe("guardrail library v0.4.0, published today");
  });

  it("exactly 24 hours is 1 day, and it is SINGULAR", () => {
    expect(at(DAY)).toBe("guardrail library v0.4.0, published 1 day ago");
  });

  it("one millisecond short of 48 hours is still 1 day", () => {
    expect(at(2 * DAY - 1)).toBe("guardrail library v0.4.0, published 1 day ago");
  });

  it("exactly 48 hours is 2 days, and it is PLURAL", () => {
    expect(at(2 * DAY)).toBe("guardrail library v0.4.0, published 2 days ago");
  });

  it("renders the documented example line at 62 days", () => {
    // Pins the exact wording of the line.
    expect(at(62 * DAY)).toBe("guardrail library v0.4.0, published 62 days ago");
  });

  it("a year reads as 365 days, not as a rounded year", () => {
    expect(at(365 * DAY)).toBe("guardrail library v0.4.0, published 365 days ago");
  });

  it("does not round up — 62 days and 23 hours is still 62 days", () => {
    expect(at(62 * DAY + 23 * HOUR)).toBe("guardrail library v0.4.0, published 62 days ago");
  });
});

describe("a publish date in the future", () => {
  it("states the date and no age, rather than clamping to today", () => {
    expect(at(-3 * DAY)).toBe(
      "guardrail library v0.4.0, published 2026-06-01 (this machine's clock reads earlier)",
    );
  });

  it("never says the guardrails were published in N days", () => {
    for (const offset of [-1, -SECOND, -HOUR, -DAY, -400 * DAY]) {
      const rendered = at(offset);
      expect(rendered).not.toMatch(/in \d+ days?/);
      expect(rendered).not.toMatch(/-\d+ days?/);
      expect(rendered).not.toContain("published today");
    }
  });

  it("takes the future branch on the very first millisecond of skew", () => {
    // The boundary between "today" and the clock-skew branch, checked from both sides.
    expect(at(0)).toContain("published today");
    expect(at(-1)).toContain("clock reads earlier");
  });

  it("prints the publication date in UTC, so the line does not depend on the reader's timezone", () => {
    // 23:59Z would render as the previous day in any negative-offset timezone if this
    // used local components. The whole date is taken from the ISO instant instead.
    const lateInTheDay: CatalogStamp = { version: "0.4.0", publishedAt: "2026-06-01T23:59:00Z" };
    expect(formatCatalogStamp(lateInTheDay, new Date("2026-05-01T00:00:00Z"))).toContain(
      "published 2026-06-01",
    );
  });
});

describe("degraded output", () => {
  it("says so in words when there is no stamp at all", () => {
    // Preserved verbatim from the seam this filled: a silently missing row
    // reads as "there is no catalog", which is a different and wronger claim.
    expect(formatCatalogStamp(undefined, new Date())).toBe(
      "guardrail library: version not yet stamped",
    );
  });

  it("keeps the version and drops the age when no date was recorded", () => {
    expect(formatCatalogStamp({ version: "0.4.0" }, new Date())).toBe(
      "guardrail library v0.4.0 (publication date not recorded)",
    );
  });

  it("keeps the version and drops the age when the date is unparseable", () => {
    expect(formatCatalogStamp({ version: "0.4.0", publishedAt: "not a date" }, new Date())).toBe(
      "guardrail library v0.4.0 (publication date not recorded)",
    );
  });

  it("never invents a plausible-looking version", () => {
    for (const stamp of [undefined, { version: "0.4.0" } as CatalogStamp]) {
      expect(formatCatalogStamp(stamp, new Date())).not.toMatch(/published \d+ days? ago/);
    }
  });
});

describe("the version printed is the catalog's, provably", () => {
  it("reads the catalog's stamp, not the guard's version", () => {
    // The guard's version and the catalog's can coincide (both `0.1.0` today), so
    // version inequality no longer proves anything. The durable proof that the stamp
    // comes from the catalog is its `publishedAt`, which no guard-side value produces:
    // a "simplification" of `catalogStamp` to read `VERSION` would drop it.
    expect(catalogStamp().version).toBe(CATALOG_VERSION);
    expect(catalogStamp().publishedAt).toBe(CATALOG_PUBLISHED_AT);
    expect(catalogStamp().publishedAt).not.toBe(VERSION);
  });
});

describe("all three surfaces read the SAME stamp", () => {
  // `status`, `scan` and `init` all print the stamp. Each renders through
  // `formatCatalogStamp(catalogStamp(), now)`, so the risk is not that one of them is
  // missing — the per-surface tests in `setup-commands.test.ts` and `report.test.ts`
  // cover that — but that one of them grows its own copy of the line and drifts.
  // These assert the shared-source property that no single-surface test can.
  // Derived from the catalog's real publish date (a day after), so the shared line is a
  // normal "1 day ago" — not the clock-skew branch, whose apostrophe would be
  // HTML-escaped in the report and defeat the byte-for-byte `toContain`.
  const now = new Date(Date.parse(CATALOG_PUBLISHED_AT) + DAY);
  const expected = formatCatalogStamp(catalogStamp(), now);

  it("the scan report footer renders exactly the shared line", () => {
    const html = renderReport(EMPTY_RESULT, { version: VERSION, generatedAt: now });
    expect(html).toContain(expected);
  });

  it("the scan --json payload carries exactly the same string, not a second shape", () => {
    const json: unknown = JSON.parse(
      renderJson(EMPTY_RESULT, { version: VERSION, generatedAt: now }),
    );
    expect((json as { catalog: string }).catalog).toBe(expected);
  });

  it("the report footer keeps the tool version and the catalog version distinct", () => {
    // They sit side by side and answer different questions. A footer that printed the
    // guard's version twice would look right and be wrong.
    const html = renderReport(EMPTY_RESULT, { version: VERSION, generatedAt: now });
    expect(html).toContain(`agenttrail-guard ${VERSION}`);
    expect(html).toContain(`guardrail library v${CATALOG_VERSION}`);
    // Both strings are present and distinct in the footer; the two versions may share a
    // number (both `0.1.0` today) without the footer collapsing them.
  });

  it("the report footer carries no product note and no prompt beside the stamp", () => {
    // A Claude Code report carries one product note, and it sits BEFORE the footer. The
    // footer says what the tool is and where the source lives: a prompt is exactly the
    // thing that would get appended to a version line, so the footer is checked on its own.
    const html = renderReport(EMPTY_RESULT, { version: VERSION, generatedAt: now });
    expect(EMPTY_RESULT.agent).toBe("claude");
    const footer = html.slice(html.indexOf("<footer"), html.indexOf("</footer>"));
    expect(footer).toContain(expected);
    expect(footer).not.toContain("product-note");
    expect(footer).not.toContain(PRODUCT_NOTE.url);
    expect(footer).not.toContain(PRODUCT_NOTE.heading);
    expect(footer).not.toMatch(/sign up|free trial|get started|upgrade|book a demo|waitlist/i);
    // The control: the note IS in the page, so the slice above is what kept it out.
    expect(html).toContain(PRODUCT_NOTE.heading);
  });
});
