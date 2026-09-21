/**
 * The guard's own vocabulary. Types only — this module emits no runtime code and
 * is safe to import from anywhere, including the hook bundle.
 *
 * `Match` is a TYPE-ONLY import from `../engine/policy-predicate.js`, so esbuild
 * erases it and it contributes zero bytes. A value import would drag zod into the hook
 * bundle; see `normalize.ts`.
 */

import type { Match } from "../engine/policy-predicate.js";

/** What a rule asks for when it matches. Mirrors the engine's `ActionSchema`. */
export type GuardAction = "block" | "require_approval" | "warn";

/** What Claude Code understands on `hookSpecificOutput.permissionDecision`. */
export type PermissionDecision = "allow" | "deny" | "ask";

/**
 * An app guard runs inside: `claude` is Claude Code, `cursor` is Cursor.
 *
 * The hook's `--agent` flag names the app whose hook configuration launched it. A
 * decision-log line's `agent` names the app that sent the call.
 */
export type AgentSource = "claude" | "cursor";

/**
 * One guardrail, in the shape `@agenttrail/guardrails` publishes.
 *
 * `rules.ts` loads the catalog through one injectable seam, so tests can swap in their
 * own catalog without touching production code.
 *
 * `fixtures` is deliberately absent: fixtures live with the rules in `guardrails`,
 * whose tests check them. The guard only needs to evaluate.
 */
export interface GuardRule {
  /** Stable dotted id, e.g. `wt.reset-hard`. Used in `reason` and the allowlist. */
  readonly id: string;
  readonly category: string;
  readonly severity: string;
  readonly defaultAction: GuardAction;
  readonly title: string;
  /**
   * Human-readable, and it states the rule's COVERAGE LIMITS verbatim
   * ("does not match `rm -fr`").
   */
  readonly description: string;
  /** The predicate's `match` sub-object — the engine's own DSL. */
  readonly match: Match;
}

/**
 * A tool call reduced to the channels the engine can actually read.
 *
 * TWO channels. `detail_contains` and `detail_matches` read `detail`, which is aliased
 * from `full_command`; `file_glob` reads `file_path`. There is no `url` matcher in the
 * engine, so there is no `url` channel here — a third key would be read by nothing.
 */
export interface MappedCall {
  /** The tool name, verbatim from the payload. Becomes the span `label`. */
  readonly tool: string;
  readonly args: {
    readonly full_command?: string;
    readonly file_path?: string;
  };
}

/** The raw Claude Code `PreToolUse` payload, as far as the guard trusts it. */
export interface PreToolUsePayload {
  readonly tool_name?: unknown;
  readonly tool_input?: unknown;
}

/**
 * The raw Cursor hook payload, as far as the guard reads it.
 *
 * Cursor sends more keys than these (`conversation_id`, `generation_id`, `model`,
 * `tool_use_id`, `cwd`, `sandbox`, `workspace_roots`, `user_email`, `transcript_path`).
 * The guard reads none of them: no id, no working directory and no account detail
 * reaches a rule or the decision log.
 */
export interface CursorHookPayload {
  /** `preToolUse`, `beforeShellExecution`, … — Cursor names its events in camelCase. */
  readonly hook_event_name?: unknown;
  /** `preToolUse` only: `Shell`, `Read`, `Write`, `Grep`, `Delete`, `MCP:<tool>`, … */
  readonly tool_name?: unknown;
  /** `preToolUse` only: the tool's arguments, as an object. */
  readonly tool_input?: unknown;
  /** `beforeShellExecution` only: the command line. */
  readonly command?: unknown;
  /** Present on every Cursor payload, for example `3.20.21`. */
  readonly cursor_version?: unknown;
}

/** One rule that matched, kept with its identity (see `evaluate.ts` on warns). */
export interface RuleMatch {
  readonly ruleId: string;
  readonly action: GuardAction;
}

/** The guard's verdict for one tool call. */
export interface GuardDecision {
  readonly decision: PermissionDecision;
  /**
   * One line, and CONTENT-FREE. It names the product, what happened, and the guardrail's
   * own title and id — `agenttrail-guard blocked this: Block git force-push (guardrail
   * wt.reset-hard)` — and never the command, the path, or anything else it judged. In Cursor
   * this text is all the user sees, so it has to stand on its own.
   */
  readonly reason: string;
  /** Every match, including `warn`s that the combined verdict discards. */
  readonly matches: readonly RuleMatch[];
}

/** A `{guardrail, pattern}` allowlist entry: suppress THAT guardrail on THAT shape. */
export interface AllowlistEntry {
  readonly guardrail: string;
  readonly pattern: string;
}

/** `~/.agenttrail/guard/config.json`, after defaulting. */
export interface GuardConfig {
  /**
   * Rule ids turned off individually, by `guardrails disable <guardrail-id>`.
   *
   * `disabledPacks` is pack granularity; this is the per-rule switch. It is a separate
   * key rather than an
   * `"off"` action, because `GuardAction` is shared with the engine and with
   * `@agenttrail/guardrails` — a local concern must not widen a shared vocabulary.
   *
   * FAILS TOWARD ENFORCING, like `allowlist`: a malformed list is discarded, so a typo
   * leaves rules running rather than silently switching them off. The same direction
   * holds across versions — an older binary reading a newer file ignores this key and
   * enforces a rule the user disabled.
   */
  readonly disabledGuardrails: readonly string[];
  /**
   * Packs the user turned off, by `guardrails disable <pack>` or by hand.
   *
   * The ONLY pack switch. Every pack is enabled unless it is named here, so a pack added
   * in a later release is enforced as soon as that release is installed — the config
   * records the user's decisions, not a snapshot of the library at install time. The same
   * holds for a user rule's own category: it loads unless its category is named here.
   *
   * FAILS TOWARD ENFORCING, like the other lists: a malformed value is discarded, so a typo
   * cannot silently keep a pack disabled.
   */
  readonly disabledPacks: readonly string[];
  readonly guardrailActionOverrides: Readonly<Record<string, GuardAction>>;
  readonly allowlist: readonly AllowlistEntry[];
  readonly crashReports: boolean;
  /**
   * Where `crash-report --send` posts, when crash reporting is on.
   *
   * `undefined` is the SHIPPED state and not a defect: the endpoint is a separate
   * launch dependency, and a placeholder URL would be a DNS lookup
   * to somewhere we do not control from a binary that promises not to make one.
   * With nothing configured, `--send` refuses by name and makes no call.
   */
  readonly crashEndpoint: string | undefined;
}
