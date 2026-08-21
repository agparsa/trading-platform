import { describe, expect, it } from 'vitest';
import { HttpStatus } from '@nestjs/common';
import { TradingErrorCode } from '@tp/shared-types';
import { statusForCode } from './domain-exception.filter';

describe('statusForCode', () => {
  it('maps a business rejection to 422 so the client can show the trader why', () => {
    expect(statusForCode(TradingErrorCode.INSUFFICIENT_MARGIN)).toBe(
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
    expect(statusForCode(TradingErrorCode.MAX_EXPOSURE_EXCEEDED)).toBe(
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  });

  it('maps a retryable race to 409', () => {
    expect(statusForCode(TradingErrorCode.STALE_QUOTE)).toBe(HttpStatus.CONFLICT);
    expect(statusForCode(TradingErrorCode.CONCURRENT_MODIFICATION)).toBe(HttpStatus.CONFLICT);
    expect(statusForCode(TradingErrorCode.POSITION_ALREADY_CLOSING)).toBe(HttpStatus.CONFLICT);
  });

  it('maps auth failures to 401/403', () => {
    expect(statusForCode(TradingErrorCode.UNAUTHENTICATED)).toBe(HttpStatus.UNAUTHORIZED);
    expect(statusForCode(TradingErrorCode.TOKEN_EXPIRED)).toBe(HttpStatus.UNAUTHORIZED);
    expect(statusForCode(TradingErrorCode.FORBIDDEN)).toBe(HttpStatus.FORBIDDEN);
  });

  it('maps a missing resource to 404', () => {
    expect(statusForCode(TradingErrorCode.ORDER_NOT_FOUND)).toBe(HttpStatus.NOT_FOUND);
  });

  it('maps rate limiting to 429', () => {
    expect(statusForCode(TradingErrorCode.RATE_LIMITED)).toBe(HttpStatus.TOO_MANY_REQUESTS);
  });

  it('falls back to 500 for anything unmapped rather than guessing a 4xx', () => {
    expect(statusForCode('SOMETHING_NEW' as TradingErrorCode)).toBe(
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  });

  it('gives every declared error code an explicit status', () => {
    const unmapped = Object.values(TradingErrorCode).filter(
      (code) =>
        statusForCode(code) === HttpStatus.INTERNAL_SERVER_ERROR &&
        code !== TradingErrorCode.INTERNAL_ERROR,
    );
    expect(unmapped).toEqual([]);
  });
});
