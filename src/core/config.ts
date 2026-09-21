/**
 * `~/.agenttrail/guard/config.json`.
 *
 * FAIL-OPEN READING. A missing file, unreadable file, malformed JSON, or a field of
 * the wrong type all resolve to a usable default rather than an error. The hook must
 * never fail to run because config is broken — that would turn a typo in a JSON file
 * into "the agent is frozen".
 *
 * Note which way each default fails:
 *   - `disabledPacks` defaults to empty = every pack enabled, and a malformed one is
 *     DISCARDED. A broken packs list must not silently disable enforcement.
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
  disabledGuardrails: [],
  disabledPacks: [],
  guardrailActionOverrides: {},
  allowlist: [],
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

/**
 * Packs turned off by the user. Same discard-on-malformed posture as `parseDisabledRules`:
 * a broken list fails toward enforcing, so a typo can never switch a pack off.
 */
function parseDisabledPacks(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((p): p is string => typeof p === "string" && p.length > 0);
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

/**
 * The seed `config.json` text written by `init`.
 *
 * Kept beside `parseConfig` on purpose: the writer and the reader must agree on the
 * shape, and a round-trip test pins that they do.
 *
 * Packs are recorded by what is OFF, never by what is on. Every pack in the library is
 * enabled unless it is named in `disabledPacks`, so a pack added in a later release is
 * enforced as soon as that release is installed, and the seed never lists pack names that
 * could fall out of step with the library. `status` and `guardrails list` show the
 * resolved set, so the file does not need to spell it out to stay legible.
 */
export function serializeDefaultConfig(): string {
  return `${JSON.stringify(
    {
      version: 1,
      disabledPacks: [],
      disabledGuardrails: [],
      guardrailActionOverrides: {},
      allowlist: [],
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

/**
 * Parse config text. Never throws.
 *
 * A key this module does not know is ignored. That includes `enabledPacks`, which older
 * releases wrote: it is no longer read, so a file that still carries it enforces every pack
 * not named in `disabledPacks`. `inspectConfig` reports the leftover key.
 *
 * @param text - the raw file contents, or `undefined` when the file is absent.
 */
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
    disabledGuardrails: parseDisabledRules(obj.disabledGuardrails),
    disabledPacks: parseDisabledPacks(obj.disabledPacks),
    guardrailActionOverrides: parseOverrides(obj.guardrailActionOverrides),
    allowlist: parseAllowlist(obj.allowlist),
    crashReports: obj.crashReports === true,
    // A non-string, or an empty string, is "not configured" — never a partial URL.
    // `resolveEndpoint` re-validates the scheme; this only decides presence.
    crashEndpoint:
      typeof obj.crashEndpoint === "string" && obj.crashEndpoint.length > 0
        ? obj.crashEndpoint
        : undefined,
  };
}
