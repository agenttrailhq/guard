/**
 * Claude Code transcript shapes — STRUCTURAL, not version-keyed.
 *
 * Claude Code persists each session as a JSONL file at
 * `~/.claude/projects/<project-slug>/<session-id>.jsonl`. One JSON object per
 * line. The format is internal + version-brittle, so we discriminate on line
 * `type` + `message.content` block **shape**, NEVER on the `version` string
 * (an exact-version allow-list would silently quarantine every session the day
 * Claude Code bumps its transcript version). `version` is recorded for
 * reporting only.
 *
 * These interfaces cover only the fields the reader needs; every field is
 * optional at the boundary because a real transcript is untrusted input —
 * `parse.ts` validates structure and quarantines what it cannot fold.
 */

/** A single content block inside a `message.content` array. */
export interface ContentBlock {
  readonly type?: string;
  /** `text` block. */
  readonly text?: string;
  /** `tool_use` block. */
  readonly id?: string;
  readonly name?: string;
  readonly input?: Readonly<Record<string, unknown>>;
  /** `tool_result` block. */
  readonly tool_use_id?: string;
  readonly content?: unknown;
  readonly is_error?: boolean;
}

/** Token usage on an assistant message (top-level, NOT per-iteration). */
export interface Usage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  /** Anthropic Messages API field names — the `_input_` infix is load-bearing. */
  readonly cache_read_input_tokens?: number;
  /** Aggregate cache-WRITE tokens (5m + 1h). The stored count of record. */
  readonly cache_creation_input_tokens?: number;
  /**
   * Per-bucket cache-WRITE split — present in real Anthropic transcripts,
   * priced per bucket (1h at 2× input, 5m at 1.25×).
   *
   * The flat `cache_creation_input_tokens` above is the vendor's SEPARATELY-reported
   * aggregate. It USUALLY but NOT ALWAYS equals `ephemeral_5m + ephemeral_1h`: real
   * transcripts contain turns with `cache_creation_input_tokens: 0` while `ephemeral_1h`
   * is non-zero. So: the split is AUTHORITATIVE for cost when present; the aggregate
   * remains the count of record; and the two must **NEVER** be asserted equal.
   */
  readonly cache_creation?: {
    readonly ephemeral_5m_input_tokens?: number;
    readonly ephemeral_1h_input_tokens?: number;
  };
  /**
   * Fast-mode marker. Observed as `"standard"` in transcripts — Claude Code's native
   * OTel reports `"normal"`/`"fast"` instead, so the two disagree on the non-fast value.
   * `null` and absent are both real and both DISTINCT from `"standard"`, and must NOT
   * be coerced to it.
   */
  readonly speed?: string | null;
  /**
   * Data-residency marker. `"us"` applies a 1.1× multiplier on every token category for
   * Claude 4.6+; `"global"` (default) / `"not_available"` are standard. Declared
   * `string | null` (NOT `string`) deliberately: it is genuinely `null` on real turns,
   * and typing it `string | undefined` would let the weaker `!== undefined` guard
   * compile and emit the literal `"null"` as a false premium.
   */
  readonly inference_geo?: string | null;
}

/** The `message` envelope on a user/assistant line. */
export interface TranscriptMessage {
  readonly role?: string;
  readonly model?: string;
  /** `content` is either a bare string (simple user text) or a block array. */
  readonly content?: string | readonly ContentBlock[];
  readonly usage?: Usage;
}

/**
 * One parsed transcript line. `type` discriminates: `summary` (line-1
 * custom-title / recap), `user`, `assistant`, `system`. Unknown `type`s are
 * kept but folded as no-ops (forward-tolerant).
 */
export interface TranscriptLine {
  readonly type?: string;
  readonly uuid?: string;
  readonly parentUuid?: string | null;
  readonly timestamp?: string;
  readonly sessionId?: string;
  readonly version?: string;
  readonly gitBranch?: string;
  readonly cwd?: string;
  readonly isSidechain?: boolean;
  readonly message?: TranscriptMessage;
}

/** A `tool_use` extracted from an assistant turn. */
export interface ToolUse {
  readonly toolUseId: string;
  readonly name: string;
  /** Command / path / free-form input (content — emitted only under `--content`). */
  readonly input: Readonly<Record<string, unknown>>;
}

/** A resolved tool_use ↔ tool_result pairing. */
export interface ToolResult {
  readonly toolUseId: string;
  readonly isError: boolean;
  /** Result body (content — emitted only under `--content`). */
  readonly content: string;
  /** Timestamp of the tool_result message (verbatim). */
  readonly timestamp: string;
}

/** A normalized model turn (one assistant message carrying `usage`). */
export interface Turn {
  readonly messageUuid: string;
  readonly timestamp: string;
  readonly model: string;
  readonly usage: Usage;
  /** Assistant text blocks joined (content — emitted only under `--content`). */
  readonly text: string;
  readonly toolUses: readonly ToolUse[];
  readonly isSidechain: boolean;
  /**
   * The `messageUuid` of the most-recent non-sidechain user prompt seen at parse
   * time — i.e. the prompt this assistant message answers. `""` for an
   * assistant message that precedes the first prompt (resumed / compacted); the
   * tree attaches those to the FIRST turn. This is the per-turn grouping key: one
   * trace per prompt, all its assistant messages + tool spans beneath. Stamped
   * during the existing forward walk (no new parsing) so grouping never depends on
   * timestamps (which a prompt line can lack — see `parse.ts`).
   */
  readonly promptUuid: string;
}

/** A normalized user prompt (content — emitted only under `--content`). */
export interface UserPrompt {
  readonly messageUuid: string;
  readonly timestamp: string;
  readonly text: string;
  readonly isSidechain: boolean;
}

/**
 * The structural result of parsing one transcript file. A session that yields
 * no coherent message spine is quarantined by the caller.
 */
export interface ParsedSession {
  readonly sessionId: string;
  /** Recorded for reporting ONLY — never used to gate parsing. */
  readonly version: string | null;
  readonly gitBranch: string | null;
  readonly cwd: string | null;
  readonly turns: readonly Turn[];
  readonly userPrompts: readonly UserPrompt[];
  readonly toolResults: ReadonlyMap<string, ToolResult>;
  /** First / last MESSAGE timestamps (verbatim; agent-root span bounds). */
  readonly firstTimestamp: string;
  readonly lastTimestamp: string;
  /** Count of lines skipped as unparseable (per-line isolation). */
  readonly skippedLines: number;
}
