import type { Timestamp, UUID } from "./common.js";

export type TraceStatus = "success" | "failure" | "in_progress";

export type SpanKind = "llm" | "execute_tool" | "retrieval" | "embedding" | "agent" | "internal";

export interface Trace {
  readonly id: UUID;
  readonly orgId: UUID;
  readonly agentId: UUID;
  readonly projectId: UUID;
  readonly developerId: UUID | null;
  readonly conversationId: string | null;
  readonly startedAt: Timestamp;
  readonly durationMs: number;
  readonly status: TraceStatus;
  readonly model: string;
  readonly provider: string;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly reasoningTokens: number;
  readonly failedToolCalls: number;
  readonly humanHandoffReason: string | null;
  readonly attributes: Readonly<Record<string, string>>;
}

export type SpanTestStatus = "passed" | "failed" | "skipped";

export interface SpanContentFile {
  readonly path: string;
  readonly diff?: string | null;
}

export interface SpanContentTest {
  readonly name: string;
  readonly status: SpanTestStatus;
  readonly message?: string | null;
}

export interface SpanContent {
  readonly task?: string | null;
  readonly files?: readonly SpanContentFile[];
  readonly terminal?: readonly string[];
  readonly reasoning?: readonly string[];
  readonly tests?: readonly SpanContentTest[];

  readonly result?: string | null;

  readonly truncated?: boolean;
}

export interface Span {
  readonly id: UUID;
  readonly traceId: UUID;
  readonly orgId: UUID;
  readonly parentSpanId: UUID | null;
  readonly kind: SpanKind;
  readonly label: string;
  readonly startedAt: Timestamp;
  readonly durationMs: number;
  readonly tokens: number;
  readonly cachedTokens: number;
  readonly failed: boolean;
  readonly attributes: Readonly<Record<string, string>>;

  readonly content?: SpanContent;
}
