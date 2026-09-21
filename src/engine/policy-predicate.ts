import { z } from "zod";

export const NumericFieldSchema = z.enum(["tokens", "cached_tokens", "duration_ms"]);

export const NumericOpSchema = z.enum(["gt", "gte", "lt", "lte"]);

export const NumericComparisonSchema = z
  .object({
    field: NumericFieldSchema,
    op: NumericOpSchema,
    value: z.number().finite(),
  })
  .strict();

export const DETAIL_MATCHES_MAX_PATTERN_LENGTH = 320;

export const DETAIL_MATCHES_MAX_PATTERNS = 10;

export function hasNestedUnboundedQuantifier(source: string): boolean {
  const unboundedQuantifierAt = (s: string, i: number): boolean => {
    const ch = s[i];
    if (ch === "*" || ch === "+") return true;
    if (ch !== "{") return false;
    const close = s.indexOf("}", i);

    return close !== -1 && /^\{\d*,\}$/.test(s.slice(i, close + 1));
  };

  const containsUnbounded = (body: string): boolean => {
    let inClass = false;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch === "\\") {
        i++;
        continue;
      }
      if (inClass) {
        if (ch === "]") inClass = false;
        continue;
      }
      if (ch === "[") {
        inClass = true;
        continue;
      }
      if (unboundedQuantifierAt(body, i)) return true;
    }
    return false;
  };

  const groupStarts: number[] = [];
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch === "(") {
      groupStarts.push(i);
      continue;
    }
    if (ch === ")") {
      const start = groupStarts.pop();
      if (start === undefined) continue;

      if (unboundedQuantifierAt(source, i + 1) && containsUnbounded(source.slice(start + 1, i))) {
        return true;
      }
    }
  }
  return false;
}

const DetailMatchPatternSchema = z
  .string()
  .min(1)
  .max(DETAIL_MATCHES_MAX_PATTERN_LENGTH)
  .superRefine((pattern, ctx) => {
    try {
      new RegExp(pattern, "i");
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `detail_matches: not a valid regular expression (${
          error instanceof Error ? error.message : "unknown error"
        })`,
      });
      return;
    }
    if (hasNestedUnboundedQuantifier(pattern)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "detail_matches: nested unbounded quantifier (e.g. `(a+)+`) can backtrack catastrophically; rewrite without repeating a repeating group",
      });
    }
  });

export const MatchConditionSchema = z
  .object({
    kind: z.string().min(1),
    label: z.string().min(1).optional(),
    detail_contains: z.array(z.string().min(1)).min(1).optional(),
    detail_matches: z
      .array(DetailMatchPatternSchema)
      .min(1)
      .max(DETAIL_MATCHES_MAX_PATTERNS)
      .optional(),
    file_glob: z.string().min(1).optional(),
    numeric: z.array(NumericComparisonSchema).min(1).optional(),
  })
  .strict();

export const MatchSchema = z
  .object({
    any_of: z.array(MatchConditionSchema).min(1).optional(),
    all_of: z.array(MatchConditionSchema).min(1).optional(),
    none_of: z.array(MatchConditionSchema).min(1).optional(),
  })
  .strict()
  .refine((data) => data.any_of !== undefined || data.all_of !== undefined, {
    message: "At least one of 'any_of' or 'all_of' must be provided",
  });

export const ScopeSchema = z
  .object({
    agent_in: z.array(z.string().min(1)).min(1).optional(),
    project_in: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict()
  .optional();

export const ActionSchema = z.enum(["block", "require_approval", "warn"]);

export const PolicyPredicateSchema = z
  .object({
    version: z.literal(1),
    match: MatchSchema,
    scope: ScopeSchema,
    action: ActionSchema,
  })
  .strict();

export type NumericComparison = z.infer<typeof NumericComparisonSchema>;

export type NumericField = z.infer<typeof NumericFieldSchema>;

export type NumericOp = z.infer<typeof NumericOpSchema>;

export type MatchCondition = z.infer<typeof MatchConditionSchema>;

export type Match = z.infer<typeof MatchSchema>;

export type Scope = z.infer<typeof ScopeSchema>;

export type Action = z.infer<typeof ActionSchema>;

export type PolicyPredicate = z.infer<typeof PolicyPredicateSchema>;

export function parsePolicyPredicate(
  input: unknown,
): z.SafeParseReturnType<unknown, PolicyPredicate> {
  return PolicyPredicateSchema.safeParse(input);
}
