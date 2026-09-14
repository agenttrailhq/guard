import {
  createCompiledFileGlobMatcher,
  matchDetailContains,
  matchDetailMatches,
  matchFileGlob,
  matchKind,
  matchLabel,
  matchNumeric,
} from "./matchers.js";
import type { MatchCondition, PolicyPredicate } from "./policy-predicate.js";
import { matchScope } from "./scope.js";
import type { Span } from "./trace.js";
import type { EvaluationResult, SpanContext } from "./types.js";

export type { EvaluationResult, SpanContext } from "./types.js";

function evaluateCondition(
  condition: MatchCondition,
  span: Span,
): { matched: boolean; reason: string } {
  const kindResult = matchKind(condition.kind, span);
  if (!kindResult.matched) {
    return kindResult;
  }

  const reasons: string[] = [kindResult.reason];

  if (condition.label !== undefined) {
    const labelResult = matchLabel(condition.label, span);
    if (!labelResult.matched) {
      return labelResult;
    }
    reasons.push(labelResult.reason);
  }

  if (condition.detail_contains !== undefined) {
    const detailResult = matchDetailContains(condition.detail_contains, span);
    if (!detailResult.matched) {
      return detailResult;
    }
    reasons.push(detailResult.reason);
  }

  if (condition.detail_matches !== undefined) {
    const regexResult = matchDetailMatches(condition.detail_matches, span);
    if (!regexResult.matched) {
      return regexResult;
    }
    reasons.push(regexResult.reason);
  }

  if (condition.file_glob !== undefined) {
    const globResult = matchFileGlob(condition.file_glob, span);
    if (!globResult.matched) {
      return globResult;
    }
    reasons.push(globResult.reason);
  }

  if (condition.numeric !== undefined) {
    for (const comparison of condition.numeric) {
      const numericResult = matchNumeric(comparison, span);
      if (!numericResult.matched) {
        return numericResult;
      }
      reasons.push(numericResult.reason);
    }
  }

  return {
    matched: true,
    reason: reasons.join("; "),
  };
}

function evaluateConditionCompiled(
  condition: MatchCondition,
  span: Span,
  compiledGlobMatcher?: (span: Span) => { matched: boolean; reason: string },
): { matched: boolean; reason: string } {
  const kindResult = matchKind(condition.kind, span);
  if (!kindResult.matched) {
    return kindResult;
  }

  const reasons: string[] = [kindResult.reason];

  if (condition.label !== undefined) {
    const labelResult = matchLabel(condition.label, span);
    if (!labelResult.matched) {
      return labelResult;
    }
    reasons.push(labelResult.reason);
  }

  if (condition.detail_contains !== undefined) {
    const detailResult = matchDetailContains(condition.detail_contains, span);
    if (!detailResult.matched) {
      return detailResult;
    }
    reasons.push(detailResult.reason);
  }

  if (condition.detail_matches !== undefined) {
    const regexResult = matchDetailMatches(condition.detail_matches, span);
    if (!regexResult.matched) {
      return regexResult;
    }
    reasons.push(regexResult.reason);
  }

  if (condition.file_glob !== undefined) {
    if (compiledGlobMatcher) {
      const globResult = compiledGlobMatcher(span);
      if (!globResult.matched) {
        return globResult;
      }
      reasons.push(globResult.reason);
    } else {
      const globResult = matchFileGlob(condition.file_glob, span);
      if (!globResult.matched) {
        return globResult;
      }
      reasons.push(globResult.reason);
    }
  }

  if (condition.numeric !== undefined) {
    for (const comparison of condition.numeric) {
      const numericResult = matchNumeric(comparison, span);
      if (!numericResult.matched) {
        return numericResult;
      }
      reasons.push(numericResult.reason);
    }
  }

  return {
    matched: true,
    reason: reasons.join("; "),
  };
}

function evaluateMatch(
  match: PolicyPredicate["match"],
  span: Span,
): { matched: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (match.all_of !== undefined) {
    for (const condition of match.all_of) {
      const result = evaluateCondition(condition, span);
      if (!result.matched) {
        return {
          matched: false,
          reasons: [`all_of: condition failed — ${result.reason}`],
        };
      }
      reasons.push(`all_of: ${result.reason}`);
    }
  }

  if (match.any_of !== undefined) {
    let anyMatched = false;
    const anyOfReasons: string[] = [];

    for (const condition of match.any_of) {
      const result = evaluateCondition(condition, span);
      if (result.matched) {
        anyMatched = true;
        anyOfReasons.push(`any_of: ${result.reason}`);
      }
    }

    if (!anyMatched) {
      return {
        matched: false,
        reasons: ["any_of: no conditions matched"],
      };
    }

    reasons.push(...anyOfReasons);
  }

  if (match.none_of !== undefined) {
    for (const condition of match.none_of) {
      const result = evaluateCondition(condition, span);
      if (result.matched) {
        return {
          matched: false,
          reasons: [`none_of: excluded condition matched — ${result.reason}`],
        };
      }
    }
    reasons.push(`none_of: no excluded condition matched (${match.none_of.length} checked)`);
  }

  return { matched: true, reasons };
}

export function evaluate(predicate: PolicyPredicate, context: SpanContext): EvaluationResult {
  const scopeResult = matchScope(predicate.scope, context);
  if (!scopeResult.matched) {
    return {
      matched: false,
      reasons: [scopeResult.reason],
    };
  }

  const matchResult = evaluateMatch(predicate.match, context.span);

  return {
    matched: matchResult.matched,
    reasons: matchResult.reasons,
  };
}

export type CompiledEvaluator = (context: SpanContext) => EvaluationResult;

export function compilePolicy(predicate: PolicyPredicate): CompiledEvaluator {
  type CompiledCondition = {
    condition: MatchCondition;
    globMatcher?: (span: Span) => { matched: boolean; reason: string };
  };

  function compileConditions(
    conditions: readonly MatchCondition[] | undefined,
  ): CompiledCondition[] | undefined {
    if (conditions === undefined) return undefined;
    return conditions.map((condition) => {
      const globMatcher = condition.file_glob
        ? createCompiledFileGlobMatcher(condition.file_glob)
        : undefined;
      return globMatcher ? { condition, globMatcher } : { condition };
    });
  }

  const compiledAnyOf = compileConditions(predicate.match.any_of);
  const compiledAllOf = compileConditions(predicate.match.all_of);
  const compiledNoneOf = compileConditions(predicate.match.none_of);
  const scope = predicate.scope;

  return (context: SpanContext): EvaluationResult => {
    const scopeResult = matchScope(scope, context);
    if (!scopeResult.matched) {
      return { matched: false, reasons: [scopeResult.reason] };
    }

    const reasons: string[] = [];
    const span = context.span;

    if (compiledAllOf !== undefined) {
      for (const { condition, globMatcher } of compiledAllOf) {
        const result = evaluateConditionCompiled(condition, span, globMatcher);
        if (!result.matched) {
          return {
            matched: false,
            reasons: [`all_of: condition failed — ${result.reason}`],
          };
        }
        reasons.push(`all_of: ${result.reason}`);
      }
    }

    if (compiledAnyOf !== undefined) {
      let anyMatched = false;
      const anyOfReasons: string[] = [];

      for (const { condition, globMatcher } of compiledAnyOf) {
        const result = evaluateConditionCompiled(condition, span, globMatcher);
        if (result.matched) {
          anyMatched = true;
          anyOfReasons.push(`any_of: ${result.reason}`);
        }
      }

      if (!anyMatched) {
        return { matched: false, reasons: ["any_of: no conditions matched"] };
      }

      reasons.push(...anyOfReasons);
    }

    if (compiledNoneOf !== undefined) {
      for (const { condition, globMatcher } of compiledNoneOf) {
        const result = evaluateConditionCompiled(condition, span, globMatcher);
        if (result.matched) {
          return {
            matched: false,
            reasons: [`none_of: excluded condition matched — ${result.reason}`],
          };
        }
      }
      reasons.push(`none_of: no excluded condition matched (${compiledNoneOf.length} checked)`);
    }

    return { matched: true, reasons };
  };
}
