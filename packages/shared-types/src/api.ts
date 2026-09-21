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
  /**
   * Present on one kind of failure only: a health probe that reports down.
   * The report is the answer — which dependency, which schedule, which worker
   * — and a 503 that dropped it said nothing but "unavailable". See
   * `HealthReport`.
   */
  data?: HealthReport;
}

/** One indicator's entry in a health report: its status and whatever it chose to say. */
export type HealthEntry = { status: 'up' | 'down' } & Record<string, unknown>;

/**
 * The shape the health probes answer with (`/ready`, `/health/jobs`, …): each
 * indicator once under `details`, and again under `info` (the ones that are
 * up) or `error` (the ones that are down).
 */
export interface HealthReport {
  status: 'ok' | 'error' | 'shutting_down';
  info?: Record<string, HealthEntry>;
  error?: Record<string, HealthEntry>;
  details: Record<string, HealthEntry>;
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
