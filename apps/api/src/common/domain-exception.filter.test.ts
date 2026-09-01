import { describe, expect, it } from 'vitest';
import { HttpStatus } from '@nestjs/common';
import { TradingErrorCode } from '@tp/shared-types';
import { DomainExceptionFilter, statusForCode } from './domain-exception.filter';
import type { ApiFailure } from '@tp/shared-types';

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

/**
 * The branch a client can never provoke, and the one that matters most.
 *
 * Every error reachable over HTTP is a *handled* one — a 404, a validation
 * failure, malformed JSON — and each takes an earlier path through the filter.
 * The unexpected-exception branch is the only one that has a real stack trace in
 * its hands, and the only way to reach it is to throw at it directly.
 *
 * This was written after a deliberate change made that branch return
 * `exception.stack` and every probe in `pnpm pentest` stayed green. Nothing in
 * the suite would have noticed a stack trace being served to clients.
 */
function respond(exception: unknown): { status: number; body: ApiFailure } {
  let status = 0;
  let body = {} as ApiFailure;
  const response = {
    status(value: number) {
      status = value;
      return this;
    },
    json(value: ApiFailure) {
      body = value;
    },
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ requestId: 'req-1', url: '/api/v1/orders' }),
      getResponse: () => response,
    }),
  };
  new DomainExceptionFilter().catch(exception, host as never);
  return { status, body };
}

describe('DomainExceptionFilter, on an exception nobody expected', () => {
  it('answers with a code and a request id, and nothing about itself', () => {
    const exception = new Error('connect ECONNREFUSED 10.0.0.5:5432');
    const { status, body } = respond(exception);

    expect(status).toBe(500);
    expect(body.error.code).toBe(TradingErrorCode.INTERNAL_ERROR);
    expect(body.error.requestId).toBe('req-1');
    expect(body.error.message).toBe('An unexpected error occurred');
  });

  it('never puts the stack, the message or a file path in the response', () => {
    const exception = new Error('relation "users" does not exist');
    exception.stack = 'Error: relation "users" does not exist\n    at /home/app/src/db.ts:12:5';
    const rendered = JSON.stringify(respond(exception).body);

    for (const leak of ['relation "users"', 'at /home/app', 'db.ts', 'Error:']) {
      expect(rendered).not.toContain(leak);
    }
  });

  it('says the same thing whatever was thrown, so the shape reveals nothing either', () => {
    const bodies = [new Error('a'), 'a string', { code: 'P2002' }, null, undefined].map((thrown) =>
      JSON.stringify(respond(thrown).body),
    );
    expect(new Set(bodies).size).toBe(1);
  });
});

describe('errors raised by the body parsers, below Nest', () => {
  /** What `http-errors` produces when a body exceeds a parser's limit. */
  const tooLarge = () =>
    Object.assign(new Error('request entity too large'), {
      status: 413,
      statusCode: 413,
      expose: true,
      type: 'entity.too.large',
    });

  it('turns a body over the limit into a 413 the client can act on', () => {
    const { status, body } = respond(tooLarge());
    expect(status).toBe(413);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.message).toMatch(/larger than this route accepts/);
  });

  it('honours only what the parser marks as safe to show, and only 4xx', () => {
    const internal = Object.assign(new Error('a parser crashed'), {
      status: 500,
      expose: false,
    });
    expect(respond(internal).status).toBe(500);
    expect(JSON.stringify(respond(internal).body)).not.toContain('parser crashed');

    const hidden = Object.assign(new Error('something with a path in it'), {
      status: 400,
      expose: false,
    });
    // Not marked exposable: treated as unknown, said nothing about.
    expect(respond(hidden).status).toBe(500);
  });
});
