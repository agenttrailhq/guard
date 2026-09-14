/**
 * `~/.agenttrail/guard/config.json`.
 *
 * FAIL-OPEN READING. A missing file, unreadable file, malformed JSON, or a field of
 * the wrong type all resolve to a usable default rather than an error. The hook must
 * never fail to run because config is broken — that would turn a typo in a JSON file
 * into "the agent is frozen".
 *
 * Note which way each default fails:
 *   - `enabledPacks` defaults to `undefined` = NO pack filter = every rule enabled.
 *     A malformed packs list must not silently disable enforcement.
 *   - `allowlist` defaults to empty, and a malformed one is DISCARDED. A broken
 *     allowlist must never suppress a rule by accident — it fails toward enforcing.
 */

import type { AllowlistEntry, GuardAction, GuardConfig } from "./types.js";

/**
 * The three spellings `guardrailActionOverrides` accepts, and the ONLY three.
 *
 * EXPORTED for `core/config-report.ts`, which tells the user when their override was
 * dropped. It is exported rather than duplicated because a reporter with its own copy
 * of this set would eventually disagree with the parser about what is valid — and then
 * report an override as accepted while `parseOverrides` silently discards it, which is
 * the exact bug the reporter exists to surface, one level up.
 *
 * Note the absence of `ask`: that is the CLI verb and Claude Code's prompt word, not the
 * stored action. `guardrails set-action <id> ask` translates at the boundary and writes
 * `require_approval` here.
 */
export const VALID_ACTIONS: ReadonlySet<string> = new Set(["block", "require_approval", "warn"]);

/** The config used when there is no file, or the file is unusable. */
export const DEFAULT_CONFIG: GuardConfig = {
  enabledPacks: undefined,
  disabledGuardrails: [],
  guardrailActionOverrides: {},
  allowlist: [],
  failOpen: true,
  crashReports: false,
  crashEndpoint: undefined,
};

function parseAllowlist(raw: unknown): AllowlistEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: AllowlistEntry[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const { guardrail, pattern } = item as Record<string, unknown>;
    if (typeof guardrail === "string" && guardrail.length > 0 && typeof pattern === "string") {
      out.push({ guardrail, pattern });
    }
  }
  return out;
}

/**
 * Rule ids disabled one at a time.
 *
 * A malformed list is DISCARDED rather than partially honored — same posture as
 * `parseAllowlist`, and for the same reason: a broken disable list must fail toward
 * enforcing. Non-string entries are dropped individually; the surviving ids still apply,
 * because dropping the whole list because of one bad entry would silently re-enable
 * rules the user did turn off.
 */
function parseDisabledRules(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is string => typeof id === "string" && id.length > 0);
}

function parseOverrides(raw: unknown): Record<string, GuardAction> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, GuardAction> = {};
  for (const [id, action] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof action === "string" && VALID_ACTIONS.has(action)) {
      out[id] = action as GuardAction;
    }
  }
  return out;
}

function parsePacks(raw: unknown): readonly string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const packs = raw.filter((p): p is string => typeof p === "string");
  // An array that held nothing usable is treated as "no filter", not "nothing enabled".
  return packs.length > 0 ? packs : undefined;
}

/**
 * Parse config text. Never throws.
 *
 * @param text - the raw file contents, or `undefined` when the file is absent.
 */
/**
 * The eight packs seeded into a fresh `config.json`.
 *
 * Written EXPLICITLY rather than left absent, even though absent means "no filter =
 * every pack enabled" and is the same behavior today. The file is meant to be
 * hand-edited, and a user cannot turn off a pack they cannot see the name of.
 *
 * `safety-bypass` holds the rules that catch a SAFETY CONTROL being switched off —
 * pre-commit hooks, branch protection, host-key checking. A config naming a pack that
 * does not exist enables nothing, and `inspectConfig` reports it as an unknown pack.
 */
export const DEFAULT_ENABLED_PACKS: readonly string[] = [
  "working-tree",
  "destructive-data",
  "prod-infra",
  "secret-exposure",
  "rce-supply-chain",
  "safety-bypass",
  "privilege-supply-chain",
  "file-scope",
];

/**
 * The seed `config.json` text written by `init`.
 *
 * Kept beside `parseConfig` on purpose: the writer and the reader must agree on the
 * shape, and a round-trip test pins that they do.
 */
export function serializeDefaultConfig(): string {
  return `${JSON.stringify(
    {
      version: 1,
      enabledPacks: DEFAULT_ENABLED_PACKS,
      disabledGuardrails: [],
      guardrailActionOverrides: {},
      allowlist: [],
      failOpen: true,
      crashReports: false,
    },
    null,
    2,
  )}\n`;
}

/**
 * Apply a mutation to `config.json` TEXT, preserving everything this module does not
 * know about.
 *
 * ── Why this does not serialize a `GuardConfig` ──────────────────────────────
 * The obvious writer is `JSON.stringify(config)`. It is wrong here, and quietly:
 * `parseConfig` keeps exactly the seven keys it understands and drops the rest, so
 * `parse -> mutate -> stringify` would DELETE any key a newer build wrote, any key an
 * older build wrote, and anything the user added by hand. `guardrails allow` would silently
 * destroy a `crashEndpoint`. So the mutation is applied to the RAW parsed object and the
 * raw object is what gets written back.
 *
 * The caller must have established that the text parses (`rules` refuses to mutate a
 * `config.json` it could not read, rather than overwriting it); a text that does not
 * parse is treated as absent and the default shape is written.
 *
 * Two-space indent and a trailing newline, matching `serializeDefaultConfig`, so a file
 * this touches stays as readable as the one `init` seeded.
 */
export function updateConfigText(
  text: string | undefined,
  mutate: (draft: Record<string, unknown>) => void,
): string {
  let draft: Record<string, unknown>;
  try {
    const raw: unknown = text === undefined ? undefined : JSON.parse(text);
    draft =
      raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? { ...(raw as Record<string, unknown>) }
        : (JSON.parse(serializeDefaultConfig()) as Record<string, unknown>);
  } catch {
    draft = JSON.parse(serializeDefaultConfig()) as Record<string, unknown>;
  }
  mutate(draft);
  return `${JSON.stringify(draft, null, 2)}\n`;
}

export function parseConfig(text: string | undefined): GuardConfig {
  if (text === undefined) return DEFAULT_CONFIG;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return DEFAULT_CONFIG;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_CONFIG;
  const obj = raw as Record<string, unknown>;
  return {
    enabledPacks: parsePacks(obj.enabledPacks),
    disabledGuardrails: parseDisabledRules(obj.disabledGuardrails),
    guardrailActionOverrides: parseOverrides(obj.guardrailActionOverrides),
    allowlist: parseAllowlist(obj.allowlist),
    failOpen: obj.failOpen !== false,
    crashReports: obj.crashReports === true,
    // A non-string, or an empty string, is "not configured" — never a partial URL.
    // `resolveEndpoint` re-validates the scheme; this only decides presence.
    crashEndpoint:
      typeof obj.crashEndpoint === "string" && obj.crashEndpoint.length > 0
        ? obj.crashEndpoint
        : undefined,
  };
}
