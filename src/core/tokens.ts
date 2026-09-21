/**
 * Token totals for `scan`, summed straight off the transcript.
 *
 * ── Running totals, computed directly ────────────────────────────────────────
 * `scan` needs running totals over a whole corpus, so the arithmetic is done directly
 * on numbers: `tok()` below, and the presence-not-value discrimination on the cache
 * split. Nothing here spawns a process or reads the repository.
 *
 * ── The one rule that must not be relaxed ───────────────────────────────────
 * `cache_creation_input_tokens` (flat, the vendor's separately-reported aggregate) and
 * `cache_creation.ephemeral_5m + ephemeral_1h` (the per-bucket split) are **never
 * asserted equal**. Real transcripts contain turns with a flat `0` while
 * `ephemeral_1h` is non-zero. So they are
 * summed into SEPARATE fields and reported as separate facts: the aggregate is the
 * count of record, the split is authoritative when present, and neither is derived
 * from the other. An implementation that computed one from the other would look
 * tidier and would be wrong on real data.
 *
 * ── And the absence of a split is a fact too ─────────────────────────────────
 * `turnsWithSplit` exists so a renderer can tell "no turn reported a split" from "the
 * split was 0". Only the first justifies withholding the row. Discriminate on the
 * PRESENCE of the nested object — `{5m:0, 1h:0}` is
 * an exact answer and must be carried, not treated as missing.
 */

import type { Usage } from "./transcript/transcript-types.js";

/**
 * Non-negative integer from a possibly-undefined usage field.
 *
 * Byte-identical semantics to `otlp.ts`'s `tok()`, including the `> 0` guard, which
 * also filters `NaN` and negatives — a transcript is untrusted input and a negative
 * token count must not subtract from a total.
 */
function tok(n: number | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Running token totals across every turn `scan` read. */
export interface TokenTotals {
  /** Uncached input tokens. */
  readonly input: number;
  readonly output: number;
  /**
   * Cache READ, CUMULATIVE. The cached prefix is served from an existing cache entry and
   * re-charged on every turn, so this counts the same tokens many times over a session —
   * it is a total of what the model billed for, not of distinct input. Every renderer
   * labels it with that qualifier so it is not misread as fresh consumption.
   */
  readonly cacheRead: number;
  /** Cache WRITE, the vendor's flat aggregate. The stored count of record. */
  readonly cacheCreation: number;
  /** Cache WRITE at the 5-minute bucket, over turns that reported a split. */
  readonly cacheCreation5m: number;
  /** Cache WRITE at the 1-hour bucket, over turns that reported a split. */
  readonly cacheCreation1h: number;
  /** How many turns carried the nested split. `0` means "nobody reported one". */
  readonly turnsWithSplit: number;
  /** How many turns were summed. */
  readonly turns: number;
}

/** The identity for a fold over zero turns. */
export const EMPTY_TOKEN_TOTALS: TokenTotals = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
  cacheCreation5m: 0,
  cacheCreation1h: 0,
  turnsWithSplit: 0,
  turns: 0,
};

/** Add one turn's `usage` to a running total. Pure; never mutates its argument. */
export function addUsage(totals: TokenTotals, usage: Usage | undefined): TokenTotals {
  const u = usage ?? {};
  const hasSplit = u.cache_creation !== undefined;
  return {
    input: totals.input + tok(u.input_tokens),
    output: totals.output + tok(u.output_tokens),
    cacheRead: totals.cacheRead + tok(u.cache_read_input_tokens),
    cacheCreation: totals.cacheCreation + tok(u.cache_creation_input_tokens),
    cacheCreation5m:
      totals.cacheCreation5m + (hasSplit ? tok(u.cache_creation?.ephemeral_5m_input_tokens) : 0),
    cacheCreation1h:
      totals.cacheCreation1h + (hasSplit ? tok(u.cache_creation?.ephemeral_1h_input_tokens) : 0),
    turnsWithSplit: totals.turnsWithSplit + (hasSplit ? 1 : 0),
    turns: totals.turns + 1,
  };
}

/** Sum a sequence of `usage` records. */
export function sumUsage(usages: Iterable<Usage | undefined>): TokenTotals {
  let totals = EMPTY_TOKEN_TOTALS;
  for (const usage of usages) totals = addUsage(totals, usage);
  return totals;
}

/**
 * Every token the model was billed for, across all four categories.
 *
 * The four are disjoint in the Anthropic accounting `usage` reports: `input_tokens`
 * counts only the uncached prefix, so adding cache reads and cache writes to it
 * double-counts nothing. The per-bucket split is deliberately NOT added — it is a
 * breakdown of `cacheCreation`, not a fifth category, and adding it would inflate the
 * headline by the size of the cache writes.
 */
export function totalTokens(t: TokenTotals): number {
  return t.input + t.output + t.cacheRead + t.cacheCreation;
}

/**
 * Format a token count for a human: `31.3B`, `8.4M`, `312.0K`, `947`.
 *
 * The `B` tier exists because cache reads are re-charged every turn, so a long session
 * accumulates tokens far faster than intuition suggests: without it, a real machine's
 * total prints as `31250.2M`, which no reader parses at a glance.
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.floor(n));
}

/** Group digits for exact counts: `1,203`. Never used for tokens — see `formatTokens`. */
export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  return Math.floor(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
