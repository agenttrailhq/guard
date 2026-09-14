import type { Span } from "./trace.js";

export interface SpanContext {
  readonly span: Span;

  readonly agentId: string;

  readonly projectId: string;

  readonly developerId: string | null;
}

export interface EvaluationResult {
  readonly matched: boolean;
  readonly reasons: readonly string[];
}
