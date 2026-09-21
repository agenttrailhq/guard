/**
 * Telling a person what their `config.json` lost. CLI-only.
 *
 * ── A dropped field is silent ────────────────────────────────────────────────
 * `parseConfig` is FAIL-OPEN by design: a malformed field resolves to a usable default
 * rather than an error, because a typo in a JSON file must never freeze the agent. The
 * cost is that a dropped field leaves no trace. `parseOverrides` accepts only
 * `block | require_approval | warn` and discards anything else — so
 * `"guardrailActionOverrides": {"wt.reset-hard": "ask"}` vanishes, the guardrail
 * goes on blocking, and nothing anywhere says so.
 *
 * `guardrails.json` has a channel: `status` prints its invalid list with a targeted
 * hint. This module is the same channel for `config.json`. `"ask"` is the likeliest
 * wrong value, because it is the word the CLI accepts and Claude Code shows.
 *
 * ── Why a separate module rather than widening `parseConfig` ─────────────────
 * `parseConfig` is on the hook's import graph and is shared with crash reporting.
 * Changing its return type would touch every caller including `hook.ts`, for a diagnostic the hook
 * must never print — it writes exactly one JSON object to stdout and nothing else. So
 * the parser stays byte-identical and the reporting lives here, where it is consumed.
 *
 * `VALID_ACTIONS` is IMPORTED rather than re-declared. A reporter with its own copy
 * would eventually disagree with the parser about what is valid, and then report an
 * override as fine while `parseOverrides` drops it — this same bug, one level up.
 */

import { parseConfig, VALID_ACTIONS } from "./config.js";
import type { GuardConfig } from "./types.js";

/** One thing the config file says that the guard did not use, and what to do about it. */
export interface ConfigProblem {
  /** The key path, e.g. `guardrailActionOverrides.wt.reset-hard` — the thing dropped. */
  readonly where: string;
  /** One line a person can act on. Never "3 problems found". */
  readonly reason: string;
}

export interface ConfigInspection {
  readonly config: GuardConfig;
  readonly problems: readonly ConfigProblem[];
}

/**
 * The action a user most often means when they write something we do not accept.
 *
 * Worth its own branch because `ask` is not a typo — it is the word the CLI takes
 * (`guardrails set-action <id> ask`), the word `guardrails list` prints, and the word Claude Code
 * shows at the prompt. Only the STORED spelling is `require_approval`. Telling someone
 * "invalid action" when they wrote the word we taught them is not a useful answer.
 */
function actionReason(value: unknown): string {
  if (value === "ask") {
    return "`ask` is the word you type and the word Claude Code shows — the stored spelling is `require_approval`. This override was ignored and the guardrail is still using its shipped action.";
  }
  return `not one of block, require_approval, warn (found ${JSON.stringify(value)}). This override was ignored and the guardrail is still using its shipped action.`;
}

/**
 * Parse `config.json` and also report what was dropped.
 *
 * `config` is exactly what `parseConfig` returns — this adds nothing to the parse and
 * changes no behavior. It only explains it.
 *
 * @param text - the raw file contents, or `undefined` when the file is absent.
 * @param knownPacks - the pack ids that exist — the library's packs plus any category the
 *   user's own guardrails use, since those can be disabled by name too — for spotting a
 *   misspelled one. Omit to skip that check rather than report every pack as unknown.
 */
export function inspectConfig(
  text: string | undefined,
  knownPacks?: readonly string[],
): ConfigInspection {
  const config = parseConfig(text);
  const problems: ConfigProblem[] = [];
  if (text === undefined) return { config, problems };

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    problems.push({
      where: "config.json",
      reason: `not valid JSON (${(error as Error).message}) — every setting in it is being ignored and the shipped defaults are in force.`,
    });
    return { config, problems };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    problems.push({
      where: "config.json",
      reason:
        "expected a JSON object — every setting in it is being ignored and the shipped defaults are in force.",
    });
    return { config, problems };
  }
  const obj = raw as Record<string, unknown>;

  // ── guardrailActionOverrides: the silent one. ──────────────────────────────
  const overrides = obj.guardrailActionOverrides;
  if (overrides !== undefined) {
    if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
      problems.push({
        where: "guardrailActionOverrides",
        reason: "expected an object of guardrail id to action — the whole block was ignored.",
      });
    } else {
      for (const [id, action] of Object.entries(overrides as Record<string, unknown>)) {
        if (typeof action !== "string" || !VALID_ACTIONS.has(action)) {
          problems.push({ where: `guardrailActionOverrides.${id}`, reason: actionReason(action) });
        }
      }
    }
  }

  // ── enabledPacks: written by older releases, no longer read. ───────────────
  // Worth saying because the key is not inert in the reader's mind: someone who trimmed
  // it by hand to turn packs off sees those packs come back, and this is the only place
  // that tells them why.
  if (obj.enabledPacks !== undefined) {
    problems.push({
      where: "enabledPacks",
      reason:
        "is no longer read — every pack is on unless it is named in `disabledPacks`. Remove this key, and list any pack you want off under `disabledPacks` (or run `agenttrail-guard guardrails disable <pack>`).",
    });
  }

  // ── disabledPacks: a dropped entry leaves a pack on; an unknown one does nothing. ─
  const packs = obj.disabledPacks;
  if (packs !== undefined) {
    if (!Array.isArray(packs)) {
      problems.push({
        where: "disabledPacks",
        reason: "expected an array of pack names — it was ignored, so every pack is on.",
      });
    } else {
      packs.forEach((p, i) => {
        if (typeof p !== "string" || p.length === 0) {
          problems.push({
            where: `disabledPacks[${i}]`,
            reason: `${JSON.stringify(p)} is not a pack name and was ignored — that pack, if you meant one, is still on.`,
          });
        } else if (knownPacks !== undefined && !knownPacks.includes(p)) {
          problems.push({
            where: `disabledPacks.${p}`,
            reason: `is not a pack this build knows about — it disables nothing. Known packs: ${knownPacks.join(", ")}.`,
          });
        }
      });
    }
  }

  // ── allowlist: an entry with the wrong shape suppresses nothing. ───────────
  const allowlist = obj.allowlist;
  if (allowlist !== undefined) {
    if (!Array.isArray(allowlist)) {
      problems.push({
        where: "allowlist",
        reason: "expected an array of {guardrail, pattern} — the whole list was ignored.",
      });
    } else {
      allowlist.forEach((entry, i) => {
        const ok =
          entry !== null &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          typeof (entry as Record<string, unknown>).guardrail === "string" &&
          ((entry as Record<string, unknown>).guardrail as string).length > 0 &&
          typeof (entry as Record<string, unknown>).pattern === "string";
        if (!ok) {
          problems.push({
            where: `allowlist[${i}]`,
            reason:
              "is not a {guardrail, pattern} object — it was dropped, so whatever it meant to allow is still being matched.",
          });
        }
      });
    }
  }

  // ── disabledGuardrails: a non-string entry leaves a guardrail running. ─────
  const disabled = obj.disabledGuardrails;
  if (disabled !== undefined) {
    if (!Array.isArray(disabled)) {
      problems.push({
        where: "disabledGuardrails",
        reason:
          "expected an array of guardrail ids — it was ignored, so nothing is disabled by it.",
      });
    } else {
      disabled.forEach((id, i) => {
        if (typeof id !== "string" || id.length === 0) {
          problems.push({
            where: `disabledGuardrails[${i}]`,
            reason: `${JSON.stringify(id)} is not a guardrail id and was ignored — that guardrail, if you meant one, is still running.`,
          });
        }
      });
    }
  }

  return { config, problems };
}
