/**
 * One-element brace groups in a guardrail's `label`.
 *
 * `label` is a picomatch pattern. `{Bash,PowerShell}` is an alternation and matches either
 * name. A brace group with no comma and no `..` range, such as `{Bash}`, is not: picomatch
 * reads it as literal braces, so the label matches only a tool literally named `{Bash}`
 * and the guardrail does not fire on `Bash`. Nothing about such a rule is invalid, so the loader
 * accepts it and lists it as enabled.
 *
 * This module finds those groups and spells the label without the braces. `guardrails add`
 * writes the corrected label and says so; `guardrails validate` names it as a warning.
 * Matching itself is unchanged.
 *
 * Only a group whose value is a plain tool name (letters, digits, `_`, `.`, `:`, `-`) is
 * rewritten. Any other value, such as a wildcard, a negation, an extended glob or a regex
 * escape (`{*}`, `{mcp__*}`, `{!Bash}`, `{@(A|B)}`, `{(\w)+}`), is warned about and left as
 * written: without the braces the label could go from matching no tool to matching every
 * tool the pattern covers, which can block or allow every call.
 *
 * Pure, and total on any input.
 */

/** One label that holds a one-element brace group. */
export interface SingleBraceLabel {
  /** Where the label is, as `match.<arm>[<index>].label`. */
  readonly path: string;
  /** The label as written. */
  readonly label: string;
  /** The same label with each one-element group's braces removed. */
  readonly corrected: string;
  /**
   * Whether `guardrails add` writes `corrected` in place of `label`. False when an unwrapped
   * value is not a plain tool name, because the correction could widen what the guardrail
   * matches.
   */
  readonly rewrite: boolean;
}

/** A value that names one tool and holds no pattern syntax. Only these are rewritten. */
const PLAIN_NAME = /^[\p{L}\p{N}_.:-]+$/u;

/** The three composition arms a condition can sit in. */
const ARMS = ["any_of", "all_of", "none_of"] as const;

/**
 * A bracket expression (`[…]`, matched first and kept as is, because a `{` inside it is a
 * character in a class), or a `{…}` group holding no comma and no nested brace. Neither
 * brace may be escaped with a backslash. The bracket body stops at the next `[`, so a run of
 * unclosed `[` is scanned once rather than once per `[`.
 */
const BRACKET_OR_BRACE_GROUP = /(?<!\\)\[[^\][]*\]|(?<!\\)\{([^{},]*?)(?<!\\)\}/g;

/**
 * The label with each one-element brace group unwrapped, or `undefined` when it has none.
 *
 * Left alone: a bracket expression, an empty `{}`, a group that holds only spaces, and a
 * `..` range (`{1..3}`), which picomatch expands. Spaces around the value are dropped
 * (`{ Bash }` becomes `Bash`). Repeated until nothing changes, so `{{Bash}}` becomes `Bash`.
 */
function correctLabel(label: string): { corrected: string; rewrite: boolean } | undefined {
  let current = label;
  let rewrite = true;
  for (;;) {
    const next = current.replace(BRACKET_OR_BRACE_GROUP, (group, inner: string | undefined) => {
      const value = inner?.trim();
      if (value === undefined || value === "" || value.includes("..")) return group;
      if (!PLAIN_NAME.test(value)) rewrite = false;
      return value;
    });
    if (next === current) break;
    current = next;
  }
  return current === label ? undefined : { corrected: current, rewrite };
}

/** A JSON object that is not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Every label in `match` that holds a one-element brace group, in arm and index order. */
export function findSingleBraceLabels(match: unknown): SingleBraceLabel[] {
  const found: SingleBraceLabel[] = [];
  if (!isRecord(match)) return found;
  for (const arm of ARMS) {
    const conditions = match[arm];
    if (!Array.isArray(conditions)) continue;
    conditions.forEach((condition, index) => {
      if (!isRecord(condition) || typeof condition.label !== "string") return;
      const result = correctLabel(condition.label);
      if (result === undefined) return;
      found.push({ path: `match.${arm}[${index}].label`, label: condition.label, ...result });
    });
  }
  return found;
}

/**
 * `match` with every rewritable label corrected, plus what was rewritten (`fixes`) and what
 * was found but left as written because a rewrite would widen it (`warnings`).
 *
 * Returns a new object when something changed and the input itself when nothing did. The
 * input is never modified.
 */
export function correctSingleBraceLabels(match: unknown): {
  match: unknown;
  fixes: SingleBraceLabel[];
  warnings: SingleBraceLabel[];
} {
  const found = findSingleBraceLabels(match);
  const fixes = found.filter((f) => f.rewrite);
  const warnings = found.filter((f) => !f.rewrite);
  if (fixes.length === 0 || !isRecord(match)) return { match, fixes, warnings };
  const corrected: Record<string, unknown> = { ...match };
  for (const arm of ARMS) {
    const conditions = match[arm];
    if (!Array.isArray(conditions)) continue;
    corrected[arm] = conditions.map((condition) => {
      if (!isRecord(condition) || typeof condition.label !== "string") return condition;
      const result = correctLabel(condition.label);
      return result?.rewrite ? { ...condition, label: result.corrected } : condition;
    });
  }
  return { match: corrected, fixes, warnings };
}

/** The sentence `guardrails add` and `guardrails validate` print for one finding. */
export function singleBraceWarning(found: SingleBraceLabel): string {
  const head = `${found.path} is \`${found.label}\`: a brace group with one value is not an alternation, so picomatch reads the braces literally`;
  if (found.rewrite) {
    return `${head}; write \`${JSON.stringify(found.corrected)}\` instead (use \`{A,B}\` only for two or more values).`;
  }
  return `${head} and this guardrail never fires. Without the braces it is \`${JSON.stringify(found.corrected)}\`, a pattern that can match many tools, so it was not rewritten; write that only if every tool it matches should match.`;
}
