import {
  API_VERSION,
  type ApiResponse,
  DomainError,
  IDEMPOTENCY_HEADER,
  REQUEST_ID_HEADER,
  TradingErrorCode,
} from '@tp/shared-types';

export interface ApiClientOptions {
  readonly baseUrl: string;
  /** Returns the current access token, or null when signed out. */
  readonly getAccessToken?: () => string | null;
  /** Called once when the server reports the access token has expired. */
  readonly onTokenExpired?: () => Promise<string | null>;
  readonly fetchImpl?: typeof fetch;
  readonly defaultTimeoutMs?: number;
}

export interface RequestOptions {
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly query?: Record<string, string | number | boolean | undefined>;
}

/**
 * Typed REST client.
 *
 * Unwraps the API envelope and turns a failure into a `DomainError` carrying the
 * server's error code — so calling code branches on `TradingErrorCode`, never on
 * an HTTP status or a message string.
 */
export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultTimeoutMs: number;

  constructor(private readonly options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 15_000;
  }

  get version(): string {
    return API_VERSION;
  }

  get<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('GET', path, undefined, options);
  }

  /**
   * POST always carries an idempotency key. A retried order submission must not
   * create a second trade, and the only safe place to guarantee that is at the
   * point the request is built.
   */
  post<T>(
    path: string,
    body: unknown,
    options: RequestOptions & { idempotencyKey: string },
  ): Promise<T> {
    return this.request<T>('POST', path, body, options);
  }

  patch<T>(
    path: string,
    body: unknown,
    options: RequestOptions & { idempotencyKey: string },
  ): Promise<T> {
    return this.request<T>('PATCH', path, body, options);
  }

  delete<T>(path: string, options: RequestOptions & { idempotencyKey: string }): Promise<T> {
    return this.request<T>('DELETE', path, undefined, options);
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? this.defaultTimeoutMs,
    );
    if (options.signal !== undefined) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: this.buildHeaders(body !== undefined, options.idempotencyKey),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const payload = (await response.json().catch(() => null)) as ApiResponse<T> | null;

      if (payload === null) {
        throw new DomainError(
          TradingErrorCode.INTERNAL_ERROR,
          `The server returned an unreadable response (HTTP ${response.status})`,
        );
      }

      if (payload.ok) return payload.data;

      if (payload.error.code === TradingErrorCode.TOKEN_EXPIRED && this.options.onTokenExpired) {
        const refreshed = await this.options.onTokenExpired();
        if (refreshed !== null) return this.request<T>(method, path, body, options);
      }

      throw new DomainError(payload.error.code, payload.error.message, payload.error.details);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new DomainError(TradingErrorCode.SERVICE_UNAVAILABLE, 'The request timed out');
      }
      throw new DomainError(
        TradingErrorCode.SERVICE_UNAVAILABLE,
        error instanceof Error ? error.message : 'Network request failed',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const url = new URL(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
    if (query !== undefined) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private buildHeaders(hasBody: boolean, idempotencyKey?: string): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (hasBody) headers['Content-Type'] = 'application/json';
    const token = this.options.getAccessToken?.() ?? null;
    if (token !== null) headers['Authorization'] = `Bearer ${token}`;
    if (idempotencyKey !== undefined) headers[IDEMPOTENCY_HEADER] = idempotencyKey;
    headers[REQUEST_ID_HEADER] = crypto.randomUUID();
    return headers;
  }
}
