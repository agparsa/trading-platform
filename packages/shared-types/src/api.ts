import type { ApiErrorBody } from './errors';

/**
 * Every REST response uses one of these two envelopes. No endpoint returns a
 * bare array or a bare scalar — that would make adding metadata a breaking change.
 */
export interface ApiSuccess<T> {
  ok: true;
  data: T;
  meta?: ApiMeta;
}

export interface ApiFailure {
  ok: false;
  error: ApiErrorBody;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface ApiMeta {
  requestId: string;
  /** Server time (ms since epoch, UTC) at which the response was produced. */
  serverTime: number;
  pagination?: PaginationMeta;
}

export interface PaginationMeta {
  /** Opaque cursor for the next page; absent when the last page was returned. */
  nextCursor?: string;
  limit: number;
}

export interface CursorPageQuery {
  cursor?: string;
  limit?: number;
}

export const API_VERSION = 'v1' as const;
export const IDEMPOTENCY_HEADER = 'Idempotency-Key' as const;
export const REQUEST_ID_HEADER = 'X-Request-Id' as const;
