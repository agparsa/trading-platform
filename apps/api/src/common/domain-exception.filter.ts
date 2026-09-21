import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import type { RequestWithContext } from './request-context';
import { ApiFailure, DomainError, TradingErrorCode, type HealthReport } from '@tp/shared-types';

/**
 * Maps a domain error code onto an HTTP status.
 *
 * Kept as an explicit table rather than a heuristic: a business rejection
 * (insufficient margin) is a 422 the client should show the trader, while a
 * stale quote is a 409 it should retry. Guessing from the error name would get
 * that wrong in both directions.
 */
const STATUS_BY_CODE: Readonly<Partial<Record<TradingErrorCode, HttpStatus>>> = {
  [TradingErrorCode.UNAUTHENTICATED]: HttpStatus.UNAUTHORIZED,
  [TradingErrorCode.TOKEN_EXPIRED]: HttpStatus.UNAUTHORIZED,
  [TradingErrorCode.FORBIDDEN]: HttpStatus.FORBIDDEN,

  [TradingErrorCode.VALIDATION_FAILED]: HttpStatus.BAD_REQUEST,
  [TradingErrorCode.RESOURCE_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [TradingErrorCode.METHOD_NOT_ALLOWED]: HttpStatus.METHOD_NOT_ALLOWED,
  [TradingErrorCode.UNKNOWN_SYMBOL]: HttpStatus.BAD_REQUEST,
  [TradingErrorCode.INVALID_VOLUME]: HttpStatus.BAD_REQUEST,
  [TradingErrorCode.INVALID_PRICE]: HttpStatus.BAD_REQUEST,
  [TradingErrorCode.INVALID_ORDER_TYPE]: HttpStatus.BAD_REQUEST,
  [TradingErrorCode.INVALID_STOP_LOSS]: HttpStatus.BAD_REQUEST,
  [TradingErrorCode.INVALID_TAKE_PROFIT]: HttpStatus.BAD_REQUEST,
  [TradingErrorCode.IDEMPOTENCY_KEY_REQUIRED]: HttpStatus.BAD_REQUEST,

  [TradingErrorCode.ORDER_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [TradingErrorCode.POSITION_NOT_FOUND]: HttpStatus.NOT_FOUND,

  [TradingErrorCode.INVALID_STATE_TRANSITION]: HttpStatus.CONFLICT,
  [TradingErrorCode.POSITION_ALREADY_CLOSING]: HttpStatus.CONFLICT,
  [TradingErrorCode.CONCURRENT_MODIFICATION]: HttpStatus.CONFLICT,
  [TradingErrorCode.IDEMPOTENCY_KEY_CONFLICT]: HttpStatus.CONFLICT,
  [TradingErrorCode.IDEMPOTENCY_RESULT_UNAVAILABLE]: HttpStatus.CONFLICT,
  [TradingErrorCode.FEATURE_DISABLED]: HttpStatus.FORBIDDEN,
  [TradingErrorCode.STALE_QUOTE]: HttpStatus.CONFLICT,

  [TradingErrorCode.INSUFFICIENT_MARGIN]: HttpStatus.UNPROCESSABLE_ENTITY,
  [TradingErrorCode.MAX_POSITION_SIZE_EXCEEDED]: HttpStatus.UNPROCESSABLE_ENTITY,
  [TradingErrorCode.MAX_EXPOSURE_EXCEEDED]: HttpStatus.UNPROCESSABLE_ENTITY,
  [TradingErrorCode.MAX_OPEN_POSITIONS_EXCEEDED]: HttpStatus.UNPROCESSABLE_ENTITY,
  [TradingErrorCode.PARTIAL_CLOSE_EXCEEDS_VOLUME]: HttpStatus.UNPROCESSABLE_ENTITY,
  [TradingErrorCode.MARKET_CLOSED]: HttpStatus.UNPROCESSABLE_ENTITY,
  [TradingErrorCode.ACCOUNT_NOT_TRADEABLE]: HttpStatus.UNPROCESSABLE_ENTITY,
  // 503, not 422: the request was fine and the service is deliberately not
  // taking it. A client that retries later is doing the right thing.
  [TradingErrorCode.TRADING_HALTED]: HttpStatus.SERVICE_UNAVAILABLE,
  // 401, not 403: the request is not authenticated *yet*. A client seeing 403
  // would conclude the credentials were rejected and stop asking.
  [TradingErrorCode.TWO_FACTOR_REQUIRED]: HttpStatus.UNAUTHORIZED,
  [TradingErrorCode.TWO_FACTOR_INVALID]: HttpStatus.UNAUTHORIZED,
  [TradingErrorCode.SYMBOL_NOT_TRADEABLE]: HttpStatus.UNPROCESSABLE_ENTITY,
  [TradingErrorCode.ORDER_NOT_MODIFIABLE]: HttpStatus.UNPROCESSABLE_ENTITY,

  [TradingErrorCode.RATE_LIMITED]: HttpStatus.TOO_MANY_REQUESTS,

  [TradingErrorCode.NO_QUOTE_AVAILABLE]: HttpStatus.SERVICE_UNAVAILABLE,
  [TradingErrorCode.SERVICE_UNAVAILABLE]: HttpStatus.SERVICE_UNAVAILABLE,
  [TradingErrorCode.NOT_IMPLEMENTED]: HttpStatus.NOT_IMPLEMENTED,
  [TradingErrorCode.INTERNAL_ERROR]: HttpStatus.INTERNAL_SERVER_ERROR,
};

export function statusForCode(code: TradingErrorCode): HttpStatus {
  return STATUS_BY_CODE[code] ?? HttpStatus.INTERNAL_SERVER_ERROR;
}

/**
 * Reverse mapping, for exceptions Nest raises before any domain code runs —
 * an unmatched route, a rejected payload, a guard denial. Without this every
 * 404 would reach the client labelled INTERNAL_ERROR, which is both wrong and
 * alarming.
 */
const CODE_BY_STATUS: Readonly<Partial<Record<number, TradingErrorCode>>> = {
  [HttpStatus.BAD_REQUEST]: TradingErrorCode.VALIDATION_FAILED,
  [HttpStatus.UNAUTHORIZED]: TradingErrorCode.UNAUTHENTICATED,
  [HttpStatus.FORBIDDEN]: TradingErrorCode.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: TradingErrorCode.RESOURCE_NOT_FOUND,
  [HttpStatus.METHOD_NOT_ALLOWED]: TradingErrorCode.METHOD_NOT_ALLOWED,
  [HttpStatus.CONFLICT]: TradingErrorCode.CONCURRENT_MODIFICATION,
  [HttpStatus.UNPROCESSABLE_ENTITY]: TradingErrorCode.VALIDATION_FAILED,
  [HttpStatus.PAYLOAD_TOO_LARGE]: TradingErrorCode.VALIDATION_FAILED,
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: TradingErrorCode.VALIDATION_FAILED,
  [HttpStatus.TOO_MANY_REQUESTS]: TradingErrorCode.RATE_LIMITED,
  [HttpStatus.SERVICE_UNAVAILABLE]: TradingErrorCode.SERVICE_UNAVAILABLE,
  [HttpStatus.NOT_IMPLEMENTED]: TradingErrorCode.NOT_IMPLEMENTED,
};

export function codeForStatus(status: number): TradingErrorCode {
  return CODE_BY_STATUS[status] ?? TradingErrorCode.INTERNAL_ERROR;
}

/**
 * The only place an exception becomes an HTTP response.
 *
 * An unrecognised error is logged in full server-side and reported to the
 * client as a bare INTERNAL_ERROR with a request id. Stack traces, SQL and
 * driver messages never cross this boundary.
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<RequestWithContext>();
    const response = http.getResponse<Response>();
    const requestId = request.requestId ?? 'unknown';

    const { status, body } = this.describe(exception, requestId);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        { requestId, path: request.url, err: exception },
        'Unhandled exception while serving request',
      );
    }

    response.status(status).json(body);
  }

  private describe(
    exception: unknown,
    requestId: string,
  ): { status: HttpStatus; body: ApiFailure } {
    if (exception instanceof DomainError) {
      const status = statusForCode(exception.code);
      return {
        status,
        body: {
          ok: false,
          error: {
            code: exception.code,
            message: exception.message,
            requestId,
            ...(exception.details === undefined ? {} : { details: exception.details }),
          },
        },
      };
    }

    const contention = contentionCodeOf(exception);
    if (contention !== null) {
      return {
        status: statusForCode(contention),
        body: {
          ok: false,
          error: {
            code: contention,
            message:
              'The account was busy with another write and this request could not be completed. Nothing was changed; try again.',
            requestId,
          },
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      /**
       * A health probe that reports down carries its report in the exception —
       * Terminus throws `ServiceUnavailableException(report)`. This branch used
       * to keep the message and drop the report, so every 503 from `/ready` or
       * `/health/jobs` read "Service Unavailable Exception" and nothing else:
       * not which dependency, not which schedule was late, not which worker
       * was missing. The 200 said everything and the 503 said nothing, which is
       * the wrong way round for a probe. The report goes on the envelope as
       * `data`, the same place the 200 puts it, so a reader parses both alike.
       */
      const report = healthReport(exception.getResponse());
      return {
        status,
        body: {
          ok: false,
          error: { code: codeForStatus(status), message: exception.message, requestId },
          ...(report === null ? {} : { data: report }),
        },
      };
    }

    /**
     * Errors raised below Nest, by Express's own body parsers.
     *
     * A body over the raw parser's limit, or one it could not decode, arrives
     * here as an `http-errors` object — not an `HttpException` — carrying a
     * numeric `status` in the 4xx range and an `expose` flag saying its message
     * is safe to show. Before this branch every one of them was a 500, so a
     * person who uploaded an eleven-megabyte photograph was told the server had
     * failed rather than that the file was too large. Only 4xx is honoured: a
     * 5xx from a parser is still the server's fault and is reported as such.
     */
    const parserError =
      typeof exception === 'object' && exception !== null
        ? (exception as { status?: unknown; expose?: unknown; message?: unknown })
        : {};
    if (
      typeof parserError.status === 'number' &&
      parserError.status >= 400 &&
      parserError.status < 500 &&
      parserError.expose === true &&
      typeof parserError.message === 'string'
    ) {
      return {
        status: parserError.status,
        body: {
          ok: false,
          error: {
            code: codeForStatus(parserError.status),
            message:
              parserError.status === HttpStatus.PAYLOAD_TOO_LARGE
                ? 'The request body is larger than this route accepts.'
                : parserError.message,
            requestId,
          },
        },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        ok: false,
        error: {
          code: TradingErrorCode.INTERNAL_ERROR,
          message: 'An unexpected error occurred',
          requestId,
        },
      },
    };
  }
}

/**
 * Database contention, told apart from a genuine fault.
 *
 * Writes to one account serialise on its ledger row — that lock is what makes
 * ten concurrent deposits total the right number instead of the wrong one. A
 * burst of orders on the same account therefore queues, and a request at the
 * back of the queue can exhaust its transaction budget or fail to get a
 * connection at all.
 *
 * That is contention, not a fault: nothing was written, and retrying will very
 * likely work. Reporting it as INTERNAL_ERROR — which is what this codebase did
 * until a load test showed five orders failing that way — tells the trader
 * nothing and tells the operator to go looking for a bug that is not there.
 *
 * | Code  | Prisma's meaning                                    |
 * | ----- | --------------------------------------------------- |
 * | P2024 | Timed out fetching a connection from the pool        |
 * | P2028 | The interactive transaction expired                  |
 * | P2034 | Write conflict or deadlock; the transaction rolled back |
 */
const CONTENTION_CODES = new Set(['P2024', 'P2028', 'P2034']);

/** PostgreSQL's own codes, which Prisma passes through inside a P2010 message. */
const CONTENTION_SQLSTATES = ['40P01', '40001'];

function contentionCodeOf(exception: unknown): TradingErrorCode | null {
  if (typeof exception !== 'object' || exception === null) return null;
  const code = (exception as { code?: unknown }).code;
  if (typeof code === 'string' && CONTENTION_CODES.has(code)) {
    return TradingErrorCode.CONCURRENT_MODIFICATION;
  }
  // Prisma reports an expired interactive transaction through a message rather
  // than a code on some paths, and a trader must not be told "internal error"
  // because of which path it took.
  const message = (exception as { message?: unknown }).message;
  if (typeof message !== 'string') return null;
  if (
    message.includes('Transaction already closed') ||
    message.includes('Unable to start a transaction in the given time')
  ) {
    return TradingErrorCode.CONCURRENT_MODIFICATION;
  }
  // A deadlock or serialisation failure arrives as P2010 with PostgreSQL's own
  // code in the text. Lock ordering should prevent it; if one gets through, the
  // trader is told to retry rather than that the platform is broken.
  if (CONTENTION_SQLSTATES.some((sqlstate) => message.includes(sqlstate))) {
    return TradingErrorCode.CONCURRENT_MODIFICATION;
  }
  return null;
}

/**
 * The response of an `HttpException` when it is a Terminus health report, and
 * `null` for every other response. Recognised by shape rather than by class:
 * Terminus throws a plain `ServiceUnavailableException`, and any other
 * exception whose response happens to be an object is somebody's message and
 * stays where it was.
 */
function healthReport(response: unknown): HealthReport | null {
  if (typeof response !== 'object' || response === null) return null;
  const candidate = response as Record<string, unknown>;
  const status = candidate['status'];
  if (status !== 'ok' && status !== 'error' && status !== 'shutting_down') return null;
  if (typeof candidate['details'] !== 'object' || candidate['details'] === null) return null;
  return candidate as unknown as HealthReport;
}
