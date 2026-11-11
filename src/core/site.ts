/**
 * The site's address, the pages linked from more than one place, and the one function that
 * tags a link to it.
 *
 * Every link to the site that guard prints or writes starts from `SITE_URL`: the AgentTrail OS
 * line in the terminal (`product-line.ts`), and the report's links and footer (`report.ts`).
 * Every tagged one is built by `siteUrl`. `product-line.test.ts` checks that no other source
 * file spells the site's address or these pages.
 *
 * It imports nothing and does no I/O, so the modules that print or write links can share it
 * without pulling anything into the hook (`bundle-graph.test.ts`).
 */

/** The site every link points at. The only place its address is written. */
export const SITE_URL = "https://www.agenttrail.sh";

/** Pages on the site linked from more than one place, as paths. */
export const SITE_PAGES = {
  /** AgentTrail OS: the terminal line, the report's product block and its footer. */
  os: "/agenttrail-os",
  /** AgentTrail OS sign-up. */
  signup: "/signup",
  /** How the guard and AgentTrail OS differ. */
  compare: "/guard-vs-os",
  /** How the guardrails map to OWASP. */
  owasp: "/security/owasp",
} as const;

/** Where a link was shown. `utm_source` is always `guard`. */
export interface SiteTags {
  /** `utm_medium`: `cli` in the terminal, `scan-report` in the report. */
  readonly medium: string;
  /** `utm_campaign`, when the link has one. The report sets the agent whose sessions it read. */
  readonly campaign?: string;
  /** `utm_content`: the command, or where on the page. */
  readonly content: string;
}

/**
 * A page on the site, tagged with where the link was shown. The tags go before a `#fragment`,
 * so a link to a row of a page keeps its query.
 */
export function siteUrl(path: string, tags: SiteTags): string {
  const query = [
    "utm_source=guard",
    `utm_medium=${tags.medium}`,
    ...(tags.campaign === undefined ? [] : [`utm_campaign=${tags.campaign}`]),
    `utm_content=${tags.content}`,
  ].join("&");
  const hash = path.indexOf("#");
  const base = hash === -1 ? path : path.slice(0, hash);
  const fragment = hash === -1 ? "" : path.slice(hash);
  return `${SITE_URL}${base}${base.includes("?") ? "&" : "?"}${query}${fragment}`;
}
