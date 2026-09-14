// cspell:words nocase picomatch

import picomatch from "picomatch";
import type { NumericComparison } from "./policy-predicate.js";
import type { Span } from "./trace.js";

const DETAIL_ATTR = "detail";

const FILE_PATH_ATTR = "file_path";

const FILE_GLOB_OPTIONS: picomatch.PicomatchOptions = { dot: true, nocase: true };

const LABEL_GLOB_OPTIONS: picomatch.PicomatchOptions = { dot: true, nocase: true };

export function matchKind(conditionKind: string, span: Span): { matched: boolean; reason: string } {
  const matched = span.kind.toLowerCase() === conditionKind.toLowerCase();
  return {
    matched,
    reason: matched
      ? `kind: "${conditionKind}" matched`
      : `kind: expected "${conditionKind}", got "${span.kind}"`,
  };
}

export function matchLabel(
  conditionLabel: string,
  span: Span,
): { matched: boolean; reason: string } {
  const matched = createCompiledLabelMatcher(conditionLabel)(span.label);
  return {
    matched,
    reason: matched
      ? `label: "${conditionLabel}" matched`
      : `label: expected "${conditionLabel}", got "${span.label}"`,
  };
}

export function matchDetailContains(
  requiredSubstrings: readonly string[],
  span: Span,
): { matched: boolean; reason: string } {
  const detail = span.attributes[DETAIL_ATTR];

  if (detail === undefined) {
    return { matched: false, reason: "detail_contains: detail attribute missing" };
  }

  const missing: string[] = [];
  for (const substring of requiredSubstrings) {
    if (!detail.includes(substring)) {
      missing.push(substring);
    }
  }

  if (missing.length > 0) {
    return {
      matched: false,
      reason: `detail_contains: missing substrings: ${JSON.stringify(missing)}`,
    };
  }

  return {
    matched: true,
    reason: `detail_contains: all ${requiredSubstrings.length} substring(s) found`,
  };
}

export function matchDetailMatches(
  patterns: readonly string[],
  span: Span,
): { matched: boolean; reason: string } {
  const detail = span.attributes[DETAIL_ATTR];

  if (detail === undefined) {
    return { matched: false, reason: "detail_matches: detail attribute missing" };
  }

  for (const pattern of patterns) {
    if (createCompiledDetailMatcher(pattern)(detail)) {
      return { matched: true, reason: `detail_matches: "${pattern}" matched` };
    }
  }

  return {
    matched: false,
    reason: `detail_matches: no pattern of ${patterns.length} matched`,
  };
}

export function matchFileGlob(pattern: string, span: Span): { matched: boolean; reason: string } {
  const filePath = span.attributes[FILE_PATH_ATTR];

  if (filePath === undefined) {
    return { matched: false, reason: "file_glob: file_path attribute missing" };
  }

  try {
    const isMatch = picomatch(pattern, FILE_GLOB_OPTIONS);
    const matched = isMatch(filePath);
    return {
      matched,
      reason: matched
        ? `file_glob: "${pattern}" matched "${filePath}"`
        : `file_glob: "${pattern}" did not match "${filePath}"`,
    };
  } catch {
    return {
      matched: false,
      reason: `file_glob: invalid pattern: "${pattern}"`,
    };
  }
}

function resolveNumericField(field: NumericComparison["field"], span: Span): number {
  switch (field) {
    case "tokens":
      return span.tokens;
    case "cached_tokens":
      return span.cachedTokens;
    case "duration_ms":
      return span.durationMs;
    default: {
      const _exhaustive: never = field;
      throw new Error(`unmapped numeric field: ${String(_exhaustive)}`);
    }
  }
}

export function matchNumeric(
  comparison: NumericComparison,
  span: Span,
): { matched: boolean; reason: string } {
  const actual = resolveNumericField(comparison.field, span);
  const { op, value, field } = comparison;

  let matched: boolean;
  switch (op) {
    case "gt":
      matched = actual > value;
      break;
    case "gte":
      matched = actual >= value;
      break;
    case "lt":
      matched = actual < value;
      break;
    case "lte":
      matched = actual <= value;
      break;
    default: {
      const _exhaustive: never = op;
      throw new Error(`unmapped numeric op: ${String(_exhaustive)}`);
    }
  }

  return {
    matched,
    reason: matched
      ? `numeric: ${field} (${actual}) ${op} ${value} matched`
      : `numeric: ${field} (${actual}) not ${op} ${value}`,
  };
}

const compiledGlobCache = new Map<string, picomatch.Matcher>();

const compiledLabelCache = new Map<string, picomatch.Matcher>();

const compiledDetailCache = new Map<string, RegExp | null>();

export function createCompiledLabelMatcher(pattern: string): (label: string) => boolean {
  let matcher = compiledLabelCache.get(pattern);
  if (matcher === undefined) {
    try {
      matcher = picomatch(pattern, LABEL_GLOB_OPTIONS);
    } catch {
      matcher = () => false;
    }
    compiledLabelCache.set(pattern, matcher);
  }
  const cached = matcher;
  return (label: string) => cached(label);
}

export function createCompiledDetailMatcher(pattern: string): (detail: string) => boolean {
  let compiled = compiledDetailCache.get(pattern);
  if (compiled === undefined) {
    try {
      compiled = new RegExp(pattern, "i");
    } catch {
      compiled = null;
    }
    compiledDetailCache.set(pattern, compiled);
  }
  const cached = compiled;
  return cached === null ? () => false : (detail: string) => cached.test(detail);
}

export function createCompiledFileGlobMatcher(
  pattern: string,
): (span: Span) => { matched: boolean; reason: string } {
  let matcher = compiledGlobCache.get(pattern);
  if (!matcher) {
    try {
      matcher = picomatch(pattern, FILE_GLOB_OPTIONS);
      compiledGlobCache.set(pattern, matcher);
    } catch {
      return (_span: Span) => ({
        matched: false,
        reason: `file_glob: invalid pattern: "${pattern}"`,
      });
    }
  }

  const cachedMatcher = matcher;
  return (span: Span) => {
    const filePath = span.attributes[FILE_PATH_ATTR];
    if (filePath === undefined) {
      return { matched: false, reason: "file_glob: file_path attribute missing" };
    }
    const matched = cachedMatcher(filePath);
    return {
      matched,
      reason: matched
        ? `file_glob: "${pattern}" matched "${filePath}"`
        : `file_glob: "${pattern}" did not match "${filePath}"`,
    };
  };
}
