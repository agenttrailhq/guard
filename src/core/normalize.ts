/**
 * Path normalization + the span the evaluator sees.
 *
 * ── Why this module has its own `normalizeSpanAttributes` ────────────────────
 * The alias from `full_command` to `detail` is a few lines, and defining it here keeps
 * every schema module out of the hook bundle: the guard is a FRESH NODE PROCESS on
 * every tool call against a 10s ceiling, so it cannot afford to parse a validator it
 * never calls. (`../engine/evaluator` and `../engine/verdict` are safe to import —
 * every schema import in their closure is type-only.)
 *
 * ── Why the alias matters ───────────────────────────────────────────────────
 * `detail` is what EVERY command rule reads (`detail_contains` and `detail_matches` in
 * `engine/matchers.ts`). If this function stops aliasing, the guard sees no `detail`
 * and **every command rule silently stops matching**. `normalize.test.ts` therefore
 * checks it EXHAUSTIVELY — every combination of present / empty / absent for both
 * keys, both branches, and the non-mutation guarantee.
 */

import type { Timestamp, UUID } from "../engine/common.js";
import type { SpanContext } from "../engine/evaluator.js";
import type { Span } from "../engine/trace.js";
import type { MappedCall } from "./types.js";

/** The evaluator ignores the uuid id fields; NIL satisfies the branded `Span` type. */
const NIL_UUID = "00000000-0000-0000-0000-000000000000" as UUID;

/** A fixed epoch timestamp — `startedAt` is not read by any matcher. */
const EPOCH = "1970-01-01T00:00:00.000Z" as Timestamp;

/**
 * Windows sends backslash separators even under Git Bash, and a forward-slash
 * pattern never matches one — silently, with the tool call proceeding
 * (`hooks.md:1563-1565`). Our rules are all forward-slash globs (`**\/.env*`), so
 * without this every file rule is dead on an entire platform.
 *
 * Applied HERE, at span synthesis, so `mapper.ts` keeps the path exactly as Claude
 * Code sent it while matching still sees the normalized form.
 */
export function normalizePathSeparators(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Expose the tool command under the `detail` key the matchers read.
 *
 * Aliased ONLY when `detail` is absent and `full_command` is present; the source map
 * is never mutated (shallow copy), so raw attributes are preserved.
 *
 * Note the checks are `=== undefined` / `!== undefined`, NOT truthiness. An EMPTY
 * STRING `detail` is present and blocks the alias; an empty-string `full_command` is
 * present and gets aliased. Writing this with `!attributes.detail` would pass a
 * casual test and diverge exactly there — which is why `normalize.test.ts` enumerates
 * the empty-string cases explicitly.
 */
export function normalizeSpanAttributes(
  attributes: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  if (attributes.detail === undefined && attributes.full_command !== undefined) {
    return { ...attributes, detail: attributes.full_command };
  }
  return attributes;
}

/**
 * Synthesize the `SpanContext` the evaluator consumes.
 *
 * `kind: "execute_tool"`, `label: tool_name`, numeric fields 0 and `failed: false` —
 * the action has not run yet. Scope ids are NIL: `scope` is BANNED from guard rules
 * because `agent_in` compares literally against a UUID and so can never match
 * a vendor slug; NIL is what an unattributed span carries, so behavior is identical.
 *
 * `file_path` is separator-normalized here; `full_command` is not (a command's
 * backslashes are content, not a path).
 */
export function buildGuardSpanContext(mapped: MappedCall): SpanContext {
  const attributes: Record<string, string> = {};
  if (mapped.args.full_command !== undefined) {
    attributes.full_command = mapped.args.full_command;
  }
  if (mapped.args.file_path !== undefined) {
    attributes.file_path = normalizePathSeparators(mapped.args.file_path);
  }

  const span: Span = {
    id: NIL_UUID,
    traceId: NIL_UUID,
    orgId: NIL_UUID,
    parentSpanId: null,
    kind: "execute_tool",
    label: mapped.tool,
    startedAt: EPOCH,
    durationMs: 0,
    tokens: 0,
    cachedTokens: 0,
    failed: false,
    attributes: normalizeSpanAttributes(attributes),
  };

  return { span, agentId: NIL_UUID, projectId: NIL_UUID, developerId: null };
}
