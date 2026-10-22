/**
 * The key set of `scan --json`, pinned at every level of the output.
 *
 * `scan --json` is a documented output with no schema version, so a key added, renamed or
 * removed is a change for whoever reads it. Pinning the keys of the envelope, the result, a
 * finding, an example shape, a recurring row, the token totals, a tally row and the skipped
 * block makes every such change an edit to this file. `owasp`, on each finding and on the
 * result, is the latest addition.
 */

import { describe, expect, it } from "vitest";
import { SHIPPED_CATALOG } from "../core/catalog.js";
import { compileAllowlist } from "../core/evaluate.js";
import { renderJson } from "../core/report.js";
import { compileCatalog } from "../core/rules.js";
import { aggregateScan, type ScanCorpus } from "../core/scan-report.js";
import { bash, session, toolUse, turn } from "./scan-fixtures.js";

const META = { version: "0.0.0-test", generatedAt: new Date("2026-10-01T00:00:00.000Z") };

type Json = Record<string, unknown>;

/** `scan --json` for a corpus, parsed back. */
function jsonOf(corpus: ScanCorpus): Json & { result: Json } {
  const result = aggregateScan(corpus, compileCatalog(SHIPPED_CATALOG), compileAllowlist([]));
  return JSON.parse(renderJson(result, META)) as Json & { result: Json };
}

const keys = (value: unknown) => Object.keys(value as object).sort();

/** The same command twice, so there is a recurring row; one more that matches nothing. */
const CALLS = [bash("git reset --hard", "1"), bash("git reset --hard", "2"), bash("ls -la", "3")];

const claude = jsonOf({
  sessions: [session([turn(CALLS, { input_tokens: 10, output_tokens: 5 })])],
  quarantined: 0,
  projects: 1,
  notRead: 0,
});

/** A reader that counts what it skipped, as the Cursor and Codex readers do. */
const withSkips = jsonOf({
  agent: "cursor",
  capabilities: { tokens: false, skips: true },
  sessions: [session([turn([...CALLS, toolUse("SomethingNew", {}, "4")])])],
  quarantined: 0,
  projects: 1,
  notRead: 0,
});

const RESULT_KEYS = [
  "agent",
  "findings",
  "notRead",
  "owasp",
  "projects",
  "quarantined",
  "recurring",
  "riskyActions",
  "sessions",
  "skippedLines",
  "tokens",
  "toolCalls",
];

describe("scan --json keys", () => {
  it("pins the envelope, and the catalog stamp is a string", () => {
    expect(keys(claude)).toEqual(["catalog", "generatedAt", "result", "tool", "version"]);
    expect(typeof claude.catalog).toBe("string");
  });

  it("pins the result", () => {
    expect(keys(claude.result)).toEqual(RESULT_KEYS);
  });

  it("pins a finding and its example shapes", () => {
    const [finding] = claude.result.findings as Json[];
    expect(keys(finding)).toEqual([
      "action",
      "count",
      "examples",
      "owasp",
      "ruleId",
      "severity",
      "title",
    ]);
    const [example] = (finding as { examples: Json[] }).examples;
    expect(keys(example)).toEqual(["count", "text"]);
  });

  it("pins a recurring row", () => {
    const [row] = claude.result.recurring as Json[];
    expect(row).toBeDefined();
    expect(keys(row)).toEqual(["count", "ruleId", "text", "title"]);
  });

  it("pins the token totals", () => {
    expect(claude.result.tokens).not.toBeNull();
    expect(keys(claude.result.tokens)).toEqual([
      "cacheCreation",
      "cacheCreation1h",
      "cacheCreation5m",
      "cacheRead",
      "input",
      "output",
      "turns",
      "turnsWithSplit",
    ]);
  });

  it("pins an OWASP tally row", () => {
    const [row] = claude.result.owasp as Json[];
    expect(row).toBeDefined();
    expect(keys(row)).toEqual(["callCount", "guardrailCount", "id", "ruleMatches"]);
  });

  it("pins the extra `skipped` block a counting reader adds, and nothing else", () => {
    expect(keys(withSkips.result)).toEqual([...RESULT_KEYS, "skipped"].sort());
    expect(withSkips.result.tokens).toBeNull();
    const skipped = withSkips.result.skipped as Json & { unmappedTools: Json[] };
    expect(keys(skipped)).toEqual([
      "notActions",
      "truncatedLastLines",
      "turnsEndedWithError",
      "unknownRecords",
      "unmappedTools",
      "unparseableLines",
      "unreadableFiles",
    ]);
    const [tool] = skipped.unmappedTools;
    expect(tool).toBeDefined();
    expect(keys(tool)).toEqual(["count", "name"]);
  });
});
