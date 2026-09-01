import {
  API_VERSION,
  type ApiResponse,
  DomainError,
  IDEMPOTENCY_HEADER,
  REQUEST_ID_HEADER,
  TradingErrorCode,
} from '@tp/shared-types';

/**
 * Is asking again likely to give a different answer?
 *
 * Every failure this client raises is a `DomainError` carrying a code, so the
 * question is answered from the code rather than from an HTTP status — which is
 * the same rule the rest of the codebase follows.
 *
 * Only two codes mean "the request never reached a decision": the transport
 * failed, or the request timed out — both of which this client reports as
 * `SERVICE_UNAVAILABLE` — and `INTERNAL_ERROR`, which is the server falling over
 * rather than refusing. Everything else is the server having understood and
 * answered, and a second identical question gets the same answer.
 *
 * This exists because it was got wrong: the terminal retried every failed read
 * once, so a support user who opened an administrative page watched "Loading…"
 * while the browser was refused a second time, and only then saw why. Found by
 * opening the page — every unit test passed straight through it.
 */
export function isWorthRetrying(error: unknown): boolean {
  if (!(error instanceof DomainError)) return true;
  return (
    error.code === TradingErrorCode.SERVICE_UNAVAILABLE ||
    error.code === TradingErrorCode.INTERNAL_ERROR
  );
}

export interface ApiClientOptions {
  readonly baseUrl: string;
  /** Returns the current access token, or null when signed out. */
  readonly getAccessToken?: () => string | null;
  /** Called once when the server reports the access token has expired. */
  readonly onTokenExpired?: () => Promise<string | null>;
  readonly fetchImpl?: typeof fetch;
  readonly defaultTimeoutMs?: number;
  /**
   * Whether the browser attaches cookies. The web client sets `'include'` so the
   * httpOnly refresh cookie reaches the auth routes across the dev origin split.
   * The cookie is path-scoped to `/auth`, so this does not put it on a trading
   * request.
   */
  readonly credentials?: 'omit' | 'same-origin' | 'include';
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
/** Whatever this runtime's fetch accepts as a body. Named without assuming a DOM lib. */
type FetchBody = NonNullable<NonNullable<Parameters<typeof fetch>[1]>['body']>;

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

  /**
   * PUT replaces a whole resource, so it is idempotent by construction: sending
   * the same set twice leaves the same set. It therefore takes no idempotency
   * key, unlike POST and PATCH, where a retry could otherwise create or apply
   * something twice.
   */
  put<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('PUT', path, body, options);
  }

  delete<T>(path: string, options: RequestOptions & { idempotencyKey: string }): Promise<T> {
    return this.request<T>('DELETE', path, undefined, options);
  }

  /**
   * Sends bytes as the body, and expects JSON back.
   *
   * For the one thing on the platform that is a file: an identity document.
   * The bytes go up as themselves under their own content type — no multipart,
   * no base64 — because the server decides what they are from the bytes and a
   * wrapper would only be something to unwrap.
   */
  async putBytes<T>(
    path: string,
    bytes: Blob | ArrayBuffer | Uint8Array,
    options: { contentType: string; filename?: string } & RequestOptions,
  ): Promise<T> {
    const headers = this.buildHeaders(false, options.idempotencyKey);
    headers['Content-Type'] = options.contentType;
    if (options.filename !== undefined && options.filename.length > 0) {
      // Header values are Latin-1; a filename is shown back as text and can
      // afford to lose characters, so anything outside that range is dropped.
      headers['X-Filename'] = options.filename.replace(/[^\x20-\x7e]/g, '').slice(0, 120);
    }
    return this.send<T>('PUT', path, bytes as FetchBody, headers, options);
  }

  /**
   * Fetches bytes rather than JSON, with the same session handling.
   *
   * The reviewer's document view. Returned as a Blob with the content type the
   * server sent, for the page to show; nothing here caches it.
   */
  async getBytes(path: string, options: RequestOptions = {}): Promise<Blob> {
    const url = this.buildUrl(path, options.query);
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: this.buildHeaders(false),
      ...(this.options.credentials === undefined ? {} : { credentials: this.options.credentials }),
    });
    if (response.ok) return response.blob();

    const payload = (await response.json().catch(() => null)) as ApiResponse<never> | null;
    if (payload !== null && !payload.ok) {
      if (payload.error.code === TradingErrorCode.TOKEN_EXPIRED && this.options.onTokenExpired) {
        const refreshed = await this.options.onTokenExpired();
        if (refreshed !== null) return this.getBytes(path, options);
      }
      throw new DomainError(payload.error.code, payload.error.message, payload.error.details);
    }
    throw new DomainError(
      TradingErrorCode.INTERNAL_ERROR,
      `The server returned an unreadable response (HTTP ${response.status})`,
    );
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    return this.send<T>(
      method,
      path,
      body === undefined ? undefined : JSON.stringify(body),
      this.buildHeaders(body !== undefined, options.idempotencyKey),
      options,
    );
  }

  private async send<T>(
    method: string,
    path: string,
    body: FetchBody | undefined,
    headers: Record<string, string>,
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
        headers,
        body,
        signal: controller.signal,
        ...(this.options.credentials === undefined
          ? {}
          : { credentials: this.options.credentials }),
      });

      /**
       * 204 means the server did what was asked and had nothing to say.
       *
       * It is checked before the body is read, because a 204 body is empty by
       * definition and `response.json()` on it throws. Without this, every
       * endpoint that answers 204 — sign out, disable two-factor, end a session
       * — reported "the server returned an unreadable response" *after
       * succeeding*, and the only reason nobody noticed is that the one caller
       * that existed swallowed its errors.
       */
      if (response.status === 204) return undefined as T;

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
        if (refreshed !== null) {
          // Re-sent with fresh headers: the old ones carry the expired token.
          const again = { ...headers, ...this.buildHeaders(false, options.idempotencyKey) };
          if (headers['Content-Type'] !== undefined)
            again['Content-Type'] = headers['Content-Type'];
          return this.send<T>(method, path, body, again, options);
        }
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
