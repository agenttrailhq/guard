// cspell:words efgh
/**
 * The local decision log — `~/.agenttrail/guard/events.jsonl`.
 *
 * One JSON object per decision that MATCHED a rule: `{ ts, tool, decision, ruleId,
 * command, agent }`, where `agent` is the app that sent the call (`claude`, `cursor` or
 * `codex`).
 * It is what makes `status` useful — "this rule fired 14 times this week" is a count
 * over this file, and without it nobody can tell which rule is the noisy one, so the
 * allowlist pressure valve cannot work.
 *
 * **Never leaves the machine.** Nothing here transmits, and nothing reachable from
 * the hook entry can (`no-network.test.ts` proves that with a parser). Deleting the
 * file is always safe; `status --clear-history` empties it.
 *
 * ── Three properties, each with a test ───────────────────────────────────────
 *
 * 1. **Scrubbed before write, and scrubbed exactly ONCE.** See below.
 * 2. **Never fatal.** `record()` catches everything and returns normally. A full
 *    disk, a read-only home, a permissions error — none may turn a tool call into a
 *    deny or a non-zero exit. `runHook` wraps the call too; both guards stay.
 * 3. **Bounded.** Hard ceiling on bytes, checked on every append; age applied at
 *    compaction. `MAX_BYTES` / `TARGET_BYTES` / `MAX_AGE_MS` below.
 *
 * ── Why the command is scrubbed BEFORE it is serialized, not after ───────────
 *
 * The natural reading of "scrub once, at the boundary" is to build the line and
 * scrub that. **That silently fails to redact.** `JSON.stringify` escapes
 * a quoted value's quotes to `\"`; the catalog's `.env` heuristic has a quoted
 * branch (needs a literal `"` after the separator) and an unquoted branch (excludes
 * `"`), and an escaped quote satisfies neither:
 *
 * | input command | scrub the serialized line | scrub the field, then serialize |
 * |---|---|---|
 * | `export API_KEY="abcd1234efgh"` | **unchanged — the secret is written** | `export API_KEY=[REDACTED:secret:env]` |
 *
 * That is worse than the documented "the output is no longer valid JSON" failure:
 * it is a redaction hole. So the field is scrubbed and then `JSON.stringify` quotes
 * and escapes the placeholder after the fact, and the line re-parses cleanly.
 * `events.test.ts` pins both halves, with the serialize-first case as a negative
 * control so the reasoning cannot quietly rot.
 *
 * This does not contradict `scrub.test.ts`'s pin, which warns against scrubbing a
 * JSON blob *and then re-parsing it*. Nothing here does that.
 *
 * ── Scrubbed exactly once ────────────────────────────────────────────────────
 *
 * `scrubText` is NOT idempotent: 11 of the 14 placeholders it emits are mangled by
 * a second pass (`[REDACTED:secret:aws]` → `[REDACTED:secret:[REDACTED:…`,
 * because the `.env` heuristic reads the literal word `secret` in our own
 * placeholder as a key name), and a GitHub token in a URL is *reclassified* to
 * `basic-auth`. So this module is the ONLY place a recorded command is scrubbed.
 * `events.test.ts` sweeps `src/` with the TypeScript parser and pins every module that
 * value-imports `scrubText`.
 */

import type { GuardIO } from "../io.js";
import { dedupMarkerPath, eventsPath, guardDir } from "./paths.js";
import { scrubText } from "./scrub.js";
import type { AgentSource, GuardAction, GuardDecision, MappedCall } from "./types.js";

/** One decision, ready to be recorded. */
export interface DecisionEvent {
  readonly mapped: MappedCall;
  readonly decision: GuardDecision;
  /** The app that sent the call. Written as the line's last key, `agent`. */
  readonly agent: AgentSource;
  /**
   * What identifies the ACTION this decision is about: the payload's `tool_use_id` where
   * the app supplies one, or a key the caller built when it does not. Used ONLY to dedupe
   * a hook invoked twice for one tool call; it is HASHED into the marker and never written
   * to the log (the record shape is unchanged) — see the dedup section below.
   */
  readonly callId?: string;
}

/** Sink for decision records. */
export interface EventRecorder {
  record(event: DecisionEvent): void;
}

/** A recorder that does nothing, and cannot throw. Used by tests. */
export const NOOP_RECORDER: EventRecorder = {
  record() {
    /* deliberately nothing */
  },
};

/**
 * Hard ceiling. Checked after every append; crossing it triggers a compaction.
 *
 * At roughly 150 bytes a record this is ~7,000 decisions — weeks of history for a
 * heavy user, and a file small enough that reading it in `status` is instant.
 */
export const MAX_BYTES = 1_048_576;

/**
 * What a compaction compacts DOWN to, so the cost is amortized.
 *
 * Half the ceiling means one compaction per ~512 KiB appended (~3,500 records), so
 * the per-decision cost is O(1). Compacting to just under the ceiling instead would
 * rewrite the whole file on nearly every subsequent append.
 */
export const TARGET_BYTES = 524_288;

/** Records older than this are dropped at compaction. Matches the crash spool. */
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How close in time two identical records must be to count as one duplicate.
 *
 * Only the FALLBACK path — an event with no `callId` — uses this. When a key is present
 * the match is exact, so no window is applied and a distinct call that carried a key is
 * never folded away. Claude Code and Cursor send a `tool_use_id`, and the Codex path
 * builds a key of its own because one of its two events per action carries no id — so this
 * is the rare degraded case; three seconds covers the ~1s gap between one call's two hook
 * invocations without merging two identical commands a user genuinely re-ran seconds apart.
 */
export const DEDUP_WINDOW_MS = 3000;

/** A tiny non-cryptographic hash (FNV-1a, 32-bit). The marker holds only this, not the key. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/** The dedup marker as `{h, t}` (a key hash and its write time), or `undefined`. Never throws. */
function readMarker(text: string | undefined): { h: string; t: number } | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") return undefined;
    const { h, t } = parsed as { h?: unknown; t?: unknown };
    return typeof h === "string" && typeof t === "number" ? { h, t } : undefined;
  } catch {
    return undefined;
  }
}

/** The `events.jsonl` line shape. Read by `core/decision-log.ts`. */
interface DecisionRecord {
  readonly ts: string;
  readonly tool: string;
  readonly decision: string;
  readonly ruleId: string;
  readonly command: string;
  readonly agent: AgentSource;
}

/**
 * The rule that produced the verdict.
 *
 * One line per decision means one `ruleId`
 * per line, so a call matching both a block and a warn records the block; the warn
 * is not separately recorded. `evaluate.ts` already names this rule in
 * `decision.reason`, and `events.test.ts` pins the two against each other — if they
 * ever disagree, the suite goes red rather than the log quietly attributing a
 * decision to the wrong rule.
 *
 * `undefined` only when nothing matched, which the caller has already excluded.
 */
function decidingRule(decision: GuardDecision): string | undefined {
  const wanted: GuardAction | undefined =
    decision.decision === "deny"
      ? "block"
      : decision.decision === "ask"
        ? "require_approval"
        : undefined;

  if (wanted !== undefined) {
    const match = decision.matches.find((m) => m.action === wanted);
    if (match !== undefined) return match.ruleId;
  }
  // A warn-only verdict is `allow`; `evaluate.ts` reports `matches[0]` for it.
  return decision.matches[0]?.ruleId;
}

/** Milliseconds for a record's `ts`, or `undefined` if it is not a usable date. */
function stampOf(record: unknown): number | undefined {
  if (record === null || typeof record !== "object") return undefined;
  const ts = (record as { ts?: unknown }).ts;
  if (typeof ts !== "string") return undefined;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Bring the log back under `TARGET_BYTES`, dropping anything past the age bound in
 * the same pass.
 *
 * Newest-first so the records kept are the useful ones, then reversed so the file
 * stays chronological. Only WHOLE, parseable lines survive — a line truncated by a
 * process killed mid-append is normal, not corruption, and this is where it goes.
 *
 * Best-effort throughout: an unreadable file or a failed write leaves the log
 * exactly as it was, which is a bounded file that is briefly over its bound, not an
 * error anyone should see.
 */
function compact(io: GuardIO, path: string, nowMs: number): void {
  const text = io.readFile(path);
  if (text === undefined) return;

  const lines = text.split("\n");
  const kept: string[] = [];
  let bytes = 0;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line === undefined || line.trim().length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // truncated tail or hand-edited junk — compaction is where it goes
    }

    const stamp = stampOf(parsed);
    if (stamp === undefined || nowMs - stamp > MAX_AGE_MS) continue;

    const size = Buffer.byteLength(line, "utf8") + 1; // + the newline
    if (bytes + size > TARGET_BYTES) break;
    bytes += size;
    kept.push(line);
  }

  kept.reverse();
  io.writeFileAtomic(path, kept.length > 0 ? `${kept.join("\n")}\n` : "");
}

/**
 * The real recorder.
 *
 * @param io - the injected side-effect seam; every call here is best-effort.
 * @param now - clock, injectable so the age bound is testable without waiting.
 */
export function createEventRecorder(io: GuardIO, now: () => number = Date.now): EventRecorder {
  return {
    record({ mapped, decision, agent, callId }: DecisionEvent): void {
      try {
        // Only decisions that MATCHED a rule are recorded. `parseDecisionLog`
        // discards any line without a `ruleId`, so an unmatched call would be
        // written and then dropped on read — and most tool calls match nothing, so
        // recording them would spend the whole byte budget on noise. Warns DO have
        // matches and are recorded: `status` counts them, because a rule that warns
        // forty times a day is exactly as annoying as one that blocks.
        const ruleId = decidingRule(decision);
        if (ruleId === undefined) return;

        // `mapper.ts` has already capped the channel at MAX_DETAIL_LEN (8192), so
        // the field is bounded before it is scrubbed.
        const raw = mapped.args.full_command ?? mapped.args.file_path ?? "";

        const record: DecisionRecord = {
          ts: new Date(now()).toISOString(),
          tool: mapped.tool,
          decision: decision.decision,
          ruleId,
          // Scrub the FIELD, then serialize. See the header — the inverse leaves an
          // escaped-quote secret unredacted. `ruleId`, `agent` and `tool` are our own
          // identifiers and the vendor's tool name, never user content, so they are
          // not scrubbed; scrubbing an id could only corrupt it.
          command: scrubText(raw).text,
          agent,
        };

        const home = io.homedir();

        // ── One tool call → one record ────────────────────────────────────────
        // All three apps can invoke the hook TWICE for a single tool call, which without
        // this writes the same decision twice, about a second apart. The key is `callId`
        // when the caller has one — exact, and two distinct calls never share one, so this
        // path can never drop a real call — and the event content within a short window
        // otherwise. Codex is why `callId` is not simply the payload's `tool_use_id`: only
        // one of its two events per action carries an id, so its path supplies a key that
        // both events produce (`core/codex-mapper.ts`). The key is hashed into a marker
        // file so it survives across the fresh process each hook run is; the log line
        // gains no id, so the record shape (and Cursor's "no id in the log" guarantee) is
        // unchanged.
        const byId = callId !== undefined && callId.length > 0;
        const dedupKey = byId
          ? `id:${callId}`
          : `ev:${agent} ${record.tool} ${record.decision} ${ruleId} ${record.command}`;
        const keyHash = fnv1a(dedupKey);
        const nowMs = now();
        const marker = readMarker(io.readFile(dedupMarkerPath(home)));
        if (marker?.h === keyHash && (byId || nowMs - marker.t <= DEDUP_WINDOW_MS)) return;

        if (!io.mkdirp(guardDir(home))) return;

        const path = eventsPath(home);
        if (!io.appendFile(path, `${JSON.stringify(record)}\n`)) return;

        // Remember this decision's key, AFTER the append so a failed write never suppresses
        // the retry. Best-effort: a failed marker write only means the next duplicate is
        // not caught, which is the pre-existing behaviour, not a regression.
        io.writeFileAtomic(dedupMarkerPath(home), JSON.stringify({ h: keyHash, t: nowMs }));

        if (io.fileSize(path) > MAX_BYTES) compact(io, path, now());
      } catch {
        /* A failed write is never a reason to block a developer's command. */
      }
    },
  };
}
