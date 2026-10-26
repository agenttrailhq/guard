/**
 * No test-only code ships. The synthetic verified corpus and its test-only card builders exist
 * for tests and previews; the plugin bundles must not carry them, or any template id they use.
 *
 * Read from the checked-in bundles, which CI rebuilds and compares, so a bundle that picked up
 * a test-only import fails here.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

/** What only test code holds. */
const MARKERS = [
  "test-only.",
  "TEST_ONLY_BUILDERS",
  "verified-corpus",
  "claimCard",
  "testFacts",
  "hostileCard",
] as const;

const BUNDLES = ["plugin/scripts/guard-scan.mjs", "plugin/scripts/guard-hook.mjs"] as const;

describe("no test-only code is in the shipped bundles", () => {
  it.each(BUNDLES)("%s carries none of it", (bundle) => {
    const text = readFileSync(join(ROOT, bundle), "utf8");
    expect(text.length).toBeGreaterThan(10_000);
    for (const marker of MARKERS) expect(text, marker).not.toContain(marker);
  });

  it("negative control: the test corpus does carry the markers", () => {
    const corpus = readFileSync(join(HERE, "verified-corpus.ts"), "utf8");
    for (const marker of ["test-only.", "TEST_ONLY_BUILDERS", "testFacts"]) {
      expect(corpus).toContain(marker);
    }
  });
});
