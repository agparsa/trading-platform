/**
 * Central trading error catalogue.
 *
 * Clients switch on `code`, never on `message`. Messages are human text and may
 * be reworded or translated; codes are part of the API contract.
 */
export const TradingErrorCode = {
  // --- auth ---
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',

  // --- validation ---
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  UNKNOWN_SYMBOL: 'UNKNOWN_SYMBOL',
  INVALID_VOLUME: 'INVALID_VOLUME',
  INVALID_PRICE: 'INVALID_PRICE',
  INVALID_ORDER_TYPE: 'INVALID_ORDER_TYPE',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',

  // --- trading ---
  MARKET_CLOSED: 'MARKET_CLOSED',
  NO_QUOTE_AVAILABLE: 'NO_QUOTE_AVAILABLE',
  STALE_QUOTE: 'STALE_QUOTE',
  INSUFFICIENT_MARGIN: 'INSUFFICIENT_MARGIN',
  MAX_POSITION_SIZE_EXCEEDED: 'MAX_POSITION_SIZE_EXCEEDED',
  MAX_EXPOSURE_EXCEEDED: 'MAX_EXPOSURE_EXCEEDED',
  MAX_OPEN_POSITIONS_EXCEEDED: 'MAX_OPEN_POSITIONS_EXCEEDED',
  INVALID_STOP_LOSS: 'INVALID_STOP_LOSS',
  INVALID_TAKE_PROFIT: 'INVALID_TAKE_PROFIT',
  POSITION_NOT_FOUND: 'POSITION_NOT_FOUND',
  POSITION_ALREADY_CLOSING: 'POSITION_ALREADY_CLOSING',
  PARTIAL_CLOSE_EXCEEDS_VOLUME: 'PARTIAL_CLOSE_EXCEEDS_VOLUME',
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  ORDER_NOT_MODIFIABLE: 'ORDER_NOT_MODIFIABLE',
  ACCOUNT_NOT_TRADEABLE: 'ACCOUNT_NOT_TRADEABLE',
  /**
   * The platform-wide halt is on.
   *
   * Distinct from `ACCOUNT_NOT_TRADEABLE`, which is about one account: a trader
   * told "your account cannot trade" when the whole platform is halted will
   * reasonably think something is wrong with *them*, and will call support to
   * find out. The two situations need two answers.
   */
  TRADING_HALTED: 'TRADING_HALTED',
  SYMBOL_NOT_TRADEABLE: 'SYMBOL_NOT_TRADEABLE',

  // --- concurrency / delivery ---
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  IDEMPOTENCY_KEY_CONFLICT: 'IDEMPOTENCY_KEY_CONFLICT',
  CONCURRENT_MODIFICATION: 'CONCURRENT_MODIFICATION',
  RATE_LIMITED: 'RATE_LIMITED',

  // --- system ---
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
} as const;
export type TradingErrorCode = (typeof TradingErrorCode)[keyof typeof TradingErrorCode];

/** Wire shape of every error response. Stack traces never cross this boundary. */
export interface ApiErrorBody {
  code: TradingErrorCode;
  message: string;
  requestId: string;
  /** Safe, structured context — field names, limits, observed values. Never secrets. */
  details?: Record<string, string | number | boolean | null>;
}

/**
 * Domain-level failure. Thrown by pure domain code; translated into an HTTP
 * response by the API layer's exception filter.
 */
export class DomainError extends Error {
  readonly code: TradingErrorCode;
  readonly details?: Record<string, string | number | boolean | null>;

  constructor(
    code: TradingErrorCode,
    message: string,
    details?: Record<string, string | number | boolean | null>,
  ) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    if (details !== undefined) this.details = details;
    Object.setPrototypeOf(this, DomainError.prototype);
  }
}

export const isDomainError = (e: unknown): e is DomainError =>
  e instanceof DomainError ||
  (typeof e === 'object' && e !== null && (e as DomainError).name === 'DomainError');
