export type UUID = string & { readonly __brand: "UUID" };

export type Timestamp = string & { readonly __brand: "Timestamp" };

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export interface PaginationParams {
  readonly page: number;

  readonly perPage: number;
}

export interface PaginatedResponse<T> {
  readonly data: readonly T[];
  readonly pagination: {
    readonly page: number;
    readonly perPage: number;
    readonly total: number;
    readonly totalPages: number;
  };
}

export interface CursorPaginationParams {
  readonly cursor?: string;
  readonly limit: number;
}

export interface CursorPaginatedResponse<T> {
  readonly data: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export type SortDirection = "asc" | "desc";
