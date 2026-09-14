/**
 * `core/tokens.ts` — the reimplemented token normalizer.
 *
 * The assertion that carries the most weight here is the NEGATIVE one: the flat
 * `cache_creation_input_tokens` and the per-bucket `ephemeral_5m + ephemeral_1h` are
 * never asserted equal, because on the real corpus they are not. Three turns carry a
 * flat `0` alongside a non-zero `ephemeral_1h` (a 4,257-token net delta), so
 * a test that asserted equality would pass on synthetic data and pin the wrong
 * behavior — and an implementation that derived one from the other would then look
 * correct. The divergent turn is a fixture below rather than a comment.
 */

import { describe, expect, it } from "vitest";
import {
  addUsage,
  EMPTY_TOKEN_TOTALS,
  formatCount,
  formatTokens,
  sumUsage,
  totalTokens,
} from "../core/tokens.js";
import type { Usage } from "../core/transcript/transcript-types.js";

describe("summing usage", () => {
  it("folds the four categories across turns", () => {
    const totals = sumUsage([
      { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
      { input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: 40 },
    ]);
    expect(totals.input).toBe(13);
    expect(totals.output).toBe(7);
    expect(totals.cacheRead).toBe(100);
    expect(totals.cacheCreation).toBe(40);
    expect(totals.turns).toBe(2);
  });

  it("totals all four categories and excludes the per-bucket split", () => {
    // The split is a BREAKDOWN of cacheCreation, not a fifth category. Adding it
    // would inflate the headline by the size of every cache write.
    const totals = sumUsage([
      {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 40,
        cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 10 },
      },
    ]);
    expect(totalTokens(totals)).toBe(155);
  });

  it("an empty corpus folds to the identity, not to NaN", () => {
    expect(sumUsage([])).toEqual(EMPTY_TOKEN_TOTALS);
    expect(totalTokens(EMPTY_TOKEN_TOTALS)).toBe(0);
  });

  it("a turn with no usage at all is still counted as a turn", () => {
    const totals = sumUsage([undefined, {}]);
    expect(totals.turns).toBe(2);
    expect(totalTokens(totals)).toBe(0);
  });

  it("never mutates the accumulator it is given", () => {
    const before = { ...EMPTY_TOKEN_TOTALS };
    addUsage(EMPTY_TOKEN_TOTALS, { input_tokens: 9 });
    expect(EMPTY_TOKEN_TOTALS).toEqual(before);
  });
});

describe("untrusted numbers", () => {
  it.each([
    ["a negative count", { input_tokens: -50 }],
    ["a NaN", { input_tokens: Number.NaN }],
    ["an Infinity", { input_tokens: Number.POSITIVE_INFINITY }],
    ["a string in a number field", { input_tokens: "12" as unknown as number }],
  ])("%s contributes zero rather than corrupting the total", (_label, usage: Usage) => {
    expect(sumUsage([usage]).input).toBe(0);
  });

  it("floors a fractional count instead of carrying it", () => {
    expect(sumUsage([{ output_tokens: 7.9 }]).output).toBe(7);
  });
});

describe("the cache-write split — the two are separate facts", () => {
  it("carries the real divergent turn: flat 0 with a non-zero 1h bucket", () => {
    // A real transcript shape. An implementation that derived the aggregate from the
    // buckets, or asserted them equal, is wrong on this turn.
    const totals = sumUsage([
      {
        cache_creation_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 4257 },
      },
    ]);
    expect(totals.cacheCreation).toBe(0);
    expect(totals.cacheCreation1h).toBe(4257);
    expect(totals.cacheCreation).not.toBe(totals.cacheCreation5m + totals.cacheCreation1h);
  });

  it("a present-but-zero split is carried, and counted as reported", () => {
    // Presence, not value. `{5m:0, 1h:0}` is an exact answer.
    const totals = sumUsage([
      {
        cache_creation_input_tokens: 12,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      },
    ]);
    expect(totals.turnsWithSplit).toBe(1);
    expect(totals.cacheCreation5m).toBe(0);
  });

  it("an absent split leaves turnsWithSplit at zero, which is how a renderer knows", () => {
    const totals = sumUsage([{ cache_creation_input_tokens: 12 }]);
    expect(totals.turnsWithSplit).toBe(0);
    expect(totals.cacheCreation5m).toBe(0);
    expect(totals.cacheCreation1h).toBe(0);
  });

  it("mixes reported and unreported turns without contaminating either number", () => {
    const totals = sumUsage([
      { cache_creation_input_tokens: 100 },
      {
        cache_creation_input_tokens: 50,
        cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 30 },
      },
    ]);
    expect(totals.cacheCreation).toBe(150);
    expect(totals.cacheCreation5m + totals.cacheCreation1h).toBe(50);
    expect(totals.turnsWithSplit).toBe(1);
    expect(totals.turns).toBe(2);
  });
});

describe("formatting", () => {
  it.each([
    [0, "0"],
    [947, "947"],
    [1000, "1.0K"],
    [312_000, "312.0K"],
    [8_400_000, "8.4M"],
    // The measurement that added this tier: a real machine's 224 sessions totalled
    // 31.25 billion tokens, which the M-capped formatter printed as `31250.2M`.
    [31_250_200_000, "31.3B"],
    [1_000_000_000, "1.0B"],
  ])("formatTokens(%i) is %s", (n, expected) => {
    expect(formatTokens(n)).toBe(expected);
  });

  it("formatTokens refuses a nonsense input rather than printing NaN", () => {
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(-1)).toBe("0");
  });

  it.each([
    [0, "0"],
    [7, "7"],
    [1203, "1,203"],
    [1_000_000, "1,000,000"],
  ])("formatCount(%i) is %s", (n, expected) => {
    expect(formatCount(n)).toBe(expected);
  });

  it("neither formatter can emit a currency symbol", () => {
    // The report carries no currency, and the formatters are the only place a number
    // becomes a string, so it is cheapest to prove it here as well as over the rendered
    // output.
    for (const n of [0, 999, 1_234_567]) {
      expect(formatTokens(n)).not.toMatch(/[$£€¥]/);
      expect(formatCount(n)).not.toMatch(/[$£€¥]/);
    }
  });
});
