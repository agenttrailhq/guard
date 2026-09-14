/**
 * THE ONLY `fetch` IN THIS PACKAGE.
 *
 * It lives alone in `src/net/` so the fence in `no-network.test.ts` is a single path
 * prefix: nothing reachable from `hook-entry.ts`, and nothing reachable from any
 * `commands/*.ts` except `crash-report.ts`, may import `src/net/**`. That makes "no
 * network from `hook` or `scan`" a property of the import graph, provable by a parser
 * over every reachable module, rather than a claim about a runtime boolean.
 *
 * ── There is deliberately NO default endpoint ────────────────────────────────
 * This module defines the interface and leaves the destination configurable. A
 * placeholder URL would mean a DNS lookup to a host nobody controls, so when no
 * endpoint resolves, `--send` refuses by name and makes no call at all.
 *
 * ── No `process.exit`, on any branch ─────────────────────────────────────────
 * `built-artifact.test.ts` asserts the CLI bundle contains no `process.exit(` call.
 * A timeout, a refusal and a 500 are all ordinary return values here.
 */

import type { CrashRecord } from "../core/crash-record.js";

/** How long a send may take before it is abandoned. */
export const SEND_TIMEOUT_MS = 10_000;

/** Why a send did not happen, or how it went. */
export type SendOutcome =
  | { readonly kind: "sent" }
  | { readonly kind: "no-endpoint" }
  | { readonly kind: "disabled" }
  | { readonly kind: "failed"; readonly detail: string };

/** Injectable so tests never open a socket. Production passes `globalThis.fetch`. */
export type FetchLike = (
  input: string,
  init: RequestInit,
) => Promise<{ ok: boolean; status: number }>;

/**
 * Resolve the destination. First hit wins; `undefined` is a legitimate result.
 *
 * `--endpoint` → `AGENTTRAIL_GUARD_CRASH_ENDPOINT` → `config.crashEndpoint` → none.
 *
 * Only `http(s)` is accepted. A `file:` or `data:` URL in a config file should not
 * become a write primitive, and anything unparseable is treated as absent rather
 * than thrown — this runs on a path that must not fail.
 */
export function resolveEndpoint(
  flag: string | undefined,
  env: string | undefined,
  configured: string | undefined,
): string | undefined {
  for (const candidate of [flag, env, configured]) {
    if (typeof candidate !== "string" || candidate.length === 0) continue;
    try {
      const u = new URL(candidate);
      if (u.protocol === "http:" || u.protocol === "https:") return candidate;
    } catch {
      /* not a URL; fall through to the next source */
    }
  }
  return undefined;
}

/**
 * POST one crash record.
 *
 * The wire contract: `POST <endpoint>`, `content-type: application/json`,
 * body is exactly one `CrashRecord`. `record.v` is the schema version; a receiver
 * that does not recognise it should store and not interpret.
 *
 * `enabled` is checked here as well as at the call site. Two guards on the one
 * irreversible action in this binary is the correct amount, and a mutation test that
 * flips either one alone must go red — `crash-report.test.ts` asserts both.
 */
export async function sendCrashRecord(
  record: CrashRecord,
  opts: {
    readonly enabled: boolean;
    readonly endpoint: string | undefined;
    readonly fetchImpl: FetchLike;
  },
): Promise<SendOutcome> {
  if (!opts.enabled) return { kind: "disabled" };
  if (opts.endpoint === undefined) return { kind: "no-endpoint" };

  try {
    const res = await opts.fetchImpl(opts.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(record),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (res.ok) return { kind: "sent" };
    return { kind: "failed", detail: `HTTP ${res.status}` };
  } catch (err) {
    // A timeout, a DNS failure and an offline machine all land here and are all
    // normal. The spool is left intact so the next `--send` retries.
    return { kind: "failed", detail: err instanceof Error ? err.name : "network error" };
  }
}

/** The real transport. Named so the fence test can assert this file is the only one. */
export const realFetch: FetchLike = (input, init) => fetch(input, init);
