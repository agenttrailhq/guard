/**
 * The bundled catalog's version and publication date.
 *
 * The guard has no update check and no network path for rules: a user's
 * rules are frozen on the day they installed. Someone who installed in January is
 * still running January's library in June — including false positives since fixed and
 * dangerous patterns since added. One line of output, no network, makes that staleness
 * visible.
 *
 * ── It is the BUNDLED catalog's version, not the guard's ─────────────────────
 * The guard bundles `@agenttrail/guardrails` at build time (`tsup.config.ts` inlines
 * everything), so that package's version is what determines which rules a user has.
 * The guard's own `VERSION` answers a different question: a guard patch release can
 * ship an unchanged catalog, and two guard versions can carry identical rules.
 *
 * ── Why the `/guardrails` SUBPATH and not the package root ────────────────────────
 * Same reason `core/catalog.ts` gives: the root re-exports the guardrails schema,
 * which value-imports zod, and `built-artifact.test.ts` asserts the hook bundle
 * carries no `ZodType`. This module is not on the hook path today, but importing the
 * zod-free entry costs nothing, matches that module, and keeps "never import a
 * package's bare barrel in code that reaches the hook bundle" true by construction.
 *
 * ── Zero network, by construction rather than by promise ─────────────────────
 * Both constants are ordinary compiled-in values inlined by the build. There is no
 * fetch here and no import that could reach one; `no-network.test.ts` holds that line
 * for `commands/*` and the hook entry.
 *
 * ── Where the surfaces are ───────────────────────────────────────────────────
 * Three commands print this line: `init` (`commands/init.ts`), `status`
 * (`commands/status.ts`), and `scan` (`core/report.ts`'s footer, rendered into both
 * the terminal summary and the HTML report).
 */

import { CATALOG_PUBLISHED_AT, CATALOG_VERSION } from "@agenttrail/guardrails/guardrails";

/** A bundled-catalog stamp. `publishedAt` is an ISO-8601 instant when present. */
export interface CatalogStamp {
  readonly version: string;
  /** Absent when a release could not source a real date. Never approximated. */
  readonly publishedAt?: string | undefined;
}

/** The bundled catalog's stamp, compiled in beside the catalog itself. */
export function catalogStamp(): CatalogStamp {
  return { version: CATALOG_VERSION, publishedAt: CATALOG_PUBLISHED_AT };
}

/** A day, in milliseconds. */
const DAY_MS = 86_400_000;

/**
 * Render the stamp as one human line.
 *
 * With no stamp it says so plainly rather than omitting the line — a silently missing
 * row reads as "there is no catalog", which is a different and wronger claim. The same
 * reasoning governs every degraded case below: each states what is known and declines
 * to state what is not.
 *
 * ── The age is elapsed 24-hour periods, not calendar days ────────────────────
 * `publishedAt` is a UTC instant and the reader's timezone is unknown, so counting
 * calendar days would need a timezone to count in and would be off by one for half the
 * world. Elapsed duration needs none and is what "62 days ago" means to a reader.
 *
 * ── A future publish date states the date and no age ─────────────────────────
 * A negative age means the machine's clock is behind the build — clock skew, a
 * mis-set date, or a bad stamp. Clamping it to "published today" would be a small
 * lie that grows with the error, and "in 3 days" is not an age. So the date itself
 * is printed, which is sourced, and the age is omitted, which is not.
 */
export function formatCatalogStamp(stamp: CatalogStamp | undefined, now: Date): string {
  if (stamp === undefined) return "guardrail library: version not yet stamped";

  const label = `guardrail library v${stamp.version}`;
  if (stamp.publishedAt === undefined) return `${label} (publication date not recorded)`;

  const published = Date.parse(stamp.publishedAt);
  if (Number.isNaN(published)) return `${label} (publication date not recorded)`;

  const elapsed = now.getTime() - published;
  if (elapsed < 0) {
    const date = new Date(published).toISOString().slice(0, 10);
    return `${label}, published ${date} (this machine's clock reads earlier)`;
  }

  const days = Math.floor(elapsed / DAY_MS);
  if (days === 0) return `${label}, published today`;
  return `${label}, published ${days} day${days === 1 ? "" : "s"} ago`;
}
