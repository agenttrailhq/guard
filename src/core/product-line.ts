/**
 * The one line about AgentTrail OS that `init`, `status`, `scan` and `guardrails add` may
 * print after their own output.
 *
 * ── One constant ─────────────────────────────────────────────────────────────
 * `PRODUCT_LINE` holds the destination and every wording. Changing where the line points
 * is a change to `destination` and nothing else; `product-line.test.ts` pins the text and
 * checks that no other source file spells the destination.
 *
 * ── When it is printed ───────────────────────────────────────────────────────
 * Only when all of these hold, and the caller decides the first one:
 *   - stdout is a terminal, and the command was not given `--quiet` or `--json`;
 *   - `config.json` does not say `"productLine": false`;
 *   - there is something to say from the user's own numbers (`productLineText`);
 *   - that command has not printed it in the last `intervalHours` hours.
 * The last showing is recorded in `.product-line` BEFORE the line is returned. When the
 * record cannot be written the line is withheld, so a read-only home never sees it on
 * every run.
 *
 * ── Never on the hook path ───────────────────────────────────────────────────
 * Nothing in the hook bundle imports this module (`bundle-graph.test.ts`), and it imports
 * nothing that does I/O or reaches the network: the caller passes its own read and write.
 */

import { formatCount } from "./tokens.js";

/** The commands that can print the line. Also the `utm_content` of its URL. */
export type ProductLineSurface = "init" | "status" | "scan" | "add";

/** The apps AgentTrail OS works with. Codex gets no line until it does. */
const SUPPORTED_AGENTS: ReadonlySet<string> = new Set(["claude", "cursor"]);

const plural = (n: number, one: string, many: string): string =>
  `${formatCount(n)} ${n === 1 ? one : many}`;

/** The destination, the wording, and the limits. The only place any of them is written. */
export const PRODUCT_LINE = {
  destination: "https://agenttrail.sh/agenttrail-os",
  utm: "utm_source=guard&utm_medium=cli",
  /** `config.json` key. Only `false` turns the line off. */
  configKey: "productLine",
  /** At most one showing per command in this many hours. */
  intervalHours: 24,
  /** How far back `status` counts decisions. */
  statusWindowDays: 7,
  text: {
    init: (url: string): string =>
      `Want a teammate to approve risky actions, and every session on record? AgentTrail OS (Team plan): ${url}`,
    statusAsks: (asks: number, url: string): string =>
      `This week guard asked about ${plural(asks, "action", "actions")}. In AgentTrail OS a teammate approves them from the app (Team plan): ${url}`,
    statusBlocks: (blocks: number, url: string): string =>
      `Guard blocked ${plural(blocks, "action", "actions")} this week. AgentTrail OS finds the failures agents repeat and suggests the guardrail that stops them: ${url}`,
    scanAsks: (asks: number, url: string): string =>
      `${formatCount(asks)} of these would have waited for a teammate's approval in AgentTrail OS (Team plan), not a prompt: ${url}`,
    scanMatches: (url: string): string =>
      `AgentTrail OS finds the failures agents repeat and suggests the guardrail that stops them: ${url}`,
    add: (id: string, url: string): string =>
      `Share it: with everyone, run agenttrail-guard guardrails export ${id}; with your team, AgentTrail OS syncs guardrails to every teammate (Team plan): ${url}`,
  },
} as const;

/** The destination as one surface links it. */
export function productLineUrl(surface: ProductLineSurface): string {
  return `${PRODUCT_LINE.destination}?${PRODUCT_LINE.utm}&utm_content=${surface}`;
}

/** What each surface knows that the line may be grounded in. */
export type ProductLineFacts =
  | { readonly surface: "init"; readonly agent: string }
  | { readonly surface: "status"; readonly asks: number; readonly blocks: number }
  | {
      readonly surface: "scan";
      readonly agent: string;
      readonly matches: number;
      readonly asks: number;
    }
  | { readonly surface: "add"; readonly guardrailId: string };

/**
 * The line for these facts, or `undefined` when there is nothing grounded to say: a Codex
 * install or scan, a `status` with no ask or block this week, a scan that matched nothing.
 */
export function productLineText(facts: ProductLineFacts): string | undefined {
  const url = productLineUrl(facts.surface);
  const t = PRODUCT_LINE.text;
  switch (facts.surface) {
    case "init":
      return SUPPORTED_AGENTS.has(facts.agent) ? t.init(url) : undefined;
    case "status":
      if (facts.asks > 0) return t.statusAsks(facts.asks, url);
      if (facts.blocks > 0) return t.statusBlocks(facts.blocks, url);
      return undefined;
    case "scan":
      if (!SUPPORTED_AGENTS.has(facts.agent) || facts.matches === 0) return undefined;
      return facts.asks > 0 ? t.scanAsks(facts.asks, url) : t.scanMatches(url);
    case "add":
      return t.add(facts.guardrailId, url);
    default:
      return undefined;
  }
}

/**
 * Is the line switched on in this `config.json` text?
 *
 * Off only for a literal `false`. A missing or unreadable file, malformed JSON, or any
 * other value leaves it on; `inspectConfig` reports a value that is not a boolean.
 */
export function productLineEnabled(configText: string | undefined): boolean {
  if (configText === undefined) return true;
  try {
    const raw: unknown = JSON.parse(configText);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return true;
    return (raw as Record<string, unknown>)[PRODUCT_LINE.configKey] !== false;
  } catch {
    return true;
  }
}

/** The recorded last showing per surface. Anything unreadable reads as "never shown". */
function readState(text: string | undefined): Record<string, unknown> {
  if (text === undefined) return {};
  try {
    const raw: unknown = JSON.parse(text);
    return raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
  } catch {
    return {};
  }
}

/** Has `surface` gone `intervalHours` without a showing? */
export function productLineDue(
  stateText: string | undefined,
  surface: ProductLineSurface,
  now: Date,
): boolean {
  const last = readState(stateText)[surface];
  if (typeof last !== "string") return true;
  const at = Date.parse(last);
  // An unparseable or future stamp would otherwise silence the line forever.
  if (Number.isNaN(at) || at > now.getTime()) return true;
  return now.getTime() - at >= PRODUCT_LINE.intervalHours * 3_600_000;
}

/** The state text with `surface` shown at `now`. Other surfaces' stamps are kept. */
export function recordProductLine(
  stateText: string | undefined,
  surface: ProductLineSurface,
  now: Date,
): string {
  const state = readState(stateText);
  state[surface] = now.toISOString();
  return `${JSON.stringify(state, null, 2)}\n`;
}

/** What a command hands over so this module never does I/O of its own. */
export interface ProductLineContext {
  /** stdout is a terminal, and neither `--quiet` nor `--json` was given. */
  readonly interactive: boolean;
  /** The `config.json` text the command already read. */
  readonly configText: string | undefined;
  /** Where the last showing is recorded. */
  readonly statePath: string;
  readonly now: Date;
  readFile(path: string): string | undefined;
  /** Returns whether the write stuck. Must not throw. */
  writeFile(path: string, text: string): boolean;
}

/** Adapt a writer that throws on failure to `ProductLineContext.writeFile`. */
export function writeOrFalse(
  write: (path: string, text: string) => void,
): (path: string, text: string) => boolean {
  return (path, text) => {
    try {
      write(path, text);
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * The line to print now, with no trailing newline, or `undefined`.
 *
 * Records the showing before returning it, and returns nothing when it cannot.
 */
export function takeProductLine(
  ctx: ProductLineContext,
  facts: ProductLineFacts,
): string | undefined {
  if (!ctx.interactive || !productLineEnabled(ctx.configText)) return undefined;
  const text = productLineText(facts);
  if (text === undefined) return undefined;
  const state = ctx.readFile(ctx.statePath);
  if (!productLineDue(state, facts.surface, ctx.now)) return undefined;
  if (!ctx.writeFile(ctx.statePath, recordProductLine(state, facts.surface, ctx.now))) {
    return undefined;
  }
  return text;
}

/** Asks and blocks from Claude Code and Cursor in the last `statusWindowDays` days. */
export function recentDecisionCounts(
  records: readonly { readonly ts: string; readonly decision: string; readonly agent: string }[],
  now: Date,
): { asks: number; blocks: number } {
  const since = now.getTime() - PRODUCT_LINE.statusWindowDays * 86_400_000;
  let asks = 0;
  let blocks = 0;
  for (const r of records) {
    if (!SUPPORTED_AGENTS.has(r.agent)) continue;
    const at = Date.parse(r.ts);
    if (Number.isNaN(at) || at < since || at > now.getTime()) continue;
    if (r.decision === "ask") asks++;
    else if (r.decision === "deny") blocks++;
  }
  return { asks, blocks };
}
