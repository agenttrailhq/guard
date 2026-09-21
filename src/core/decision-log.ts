// cspell:words unrotated
/**
 * Reading `~/.agenttrail/guard/events.jsonl` for `status`.
 *
 * The writer is `core/events.ts`. Every command in this file was scrubbed BEFORE it
 * was written, which is why nothing here scrubs again: `scrubText` is not idempotent,
 * and a second pass mangles 11 of the 14 placeholder kinds. `events.test.ts` holds the
 * end-to-end property instead: six secret shapes through the real recorder, `runStatus`
 * over the result, each raw secret absent from stdout.
 *
 * TOLERANT BY DESIGN. The file is append-only from a process that can be killed
 * mid-write, so a truncated final line is normal, not corruption. Every parse failure
 * skips one line and continues; nothing here throws. `status` failing because the log
 * has a bad byte would be a worse bug than the bad byte.
 */

/** One recorded decision, as written to `events.jsonl`. */
export interface DecisionRecord {
  readonly ts: string;
  readonly tool: string;
  readonly decision: string;
  readonly ruleId: string;
  readonly command: string;
  /** The app that sent the call: `claude` or `cursor`. */
  readonly agent: string;
}

/** The rule that fired most often, with a representative command shape. */
export interface FrequentMatch {
  readonly ruleId: string;
  readonly count: number;
  /** The most common command recorded for this rule — scrubbed at WRITE time. */
  readonly command: string;
}

function readString(rec: Record<string, unknown>, key: string): string | undefined {
  const v = rec[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * Parse the log. Never throws; unparseable lines are skipped, and so is a line without a
 * string `ruleId`, `decision` or `agent`.
 *
 * Only the LAST `limit` lines are parsed. An unrotated log must not make `status` slow
 * — and the recent-decisions view only ever shows the tail anyway.
 */
export function parseDecisionLog(text: string | undefined, limit = 500): DecisionRecord[] {
  if (text === undefined) return [];
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const out: DecisionRecord[] = [];
  for (const line of lines.slice(-limit)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a truncated tail line is expected, not an error
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const rec = parsed as Record<string, unknown>;
    const ruleId = readString(rec, "ruleId");
    const decision = readString(rec, "decision");
    const agent = readString(rec, "agent");
    if (ruleId === undefined || decision === undefined || agent === undefined) continue;
    out.push({
      ts: readString(rec, "ts") ?? "",
      tool: readString(rec, "tool") ?? "",
      decision,
      ruleId,
      command: readString(rec, "command") ?? "",
      agent,
    });
  }
  return out;
}

/**
 * The rule that fired most often, or `undefined` when nothing has.
 *
 * `warn`-level matches count: a rule that warns forty times a day is exactly as
 * annoying as one that blocks, and the allowlist is the pressure valve for both.
 *
 * Ties break on the id, so repeated runs over the same log print the same rule — a
 * "most frequent match" that shuffles between runs reads as a bug.
 */
export function mostFrequentMatch(records: readonly DecisionRecord[]): FrequentMatch | undefined {
  const byRule = new Map<string, Map<string, number>>();
  const totals = new Map<string, number>();

  for (const r of records) {
    totals.set(r.ruleId, (totals.get(r.ruleId) ?? 0) + 1);
    const commands = byRule.get(r.ruleId) ?? new Map<string, number>();
    commands.set(r.command, (commands.get(r.command) ?? 0) + 1);
    byRule.set(r.ruleId, commands);
  }
  if (totals.size === 0) return undefined;

  let bestRule = "";
  let bestCount = -1;
  for (const [ruleId, count] of [...totals.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (count > bestCount) {
      bestRule = ruleId;
      bestCount = count;
    }
  }

  let bestCommand = "";
  let bestCommandCount = -1;
  for (const [command, count] of byRule.get(bestRule) ?? []) {
    if (count > bestCommandCount) {
      bestCommand = command;
      bestCommandCount = count;
    }
  }

  return { ruleId: bestRule, count: bestCount, command: bestCommand };
}
