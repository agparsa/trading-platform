import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { DomainError, IDEMPOTENCY_HEADER, TradingErrorCode } from '@tp/shared-types';
import type { RequestWithContext } from '../request-context';

/**
 * Extracts the mandatory `Idempotency-Key` header.
 *
 * Required rather than optional: a mutation without one cannot be retried
 * safely, and a client that omits it should find out immediately rather than
 * when a network blip turns one order into two.
 */
export const IdempotencyKey = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<RequestWithContext>();
  const key = request.header(IDEMPOTENCY_HEADER);
  if (key === undefined || key.trim().length === 0) {
    throw new DomainError(
      TradingErrorCode.IDEMPOTENCY_KEY_REQUIRED,
      `The ${IDEMPOTENCY_HEADER} header is required on this endpoint`,
    );
  }
  if (key.length > 200) {
    throw new DomainError(
      TradingErrorCode.VALIDATION_FAILED,
      `${IDEMPOTENCY_HEADER} must be at most 200 characters`,
    );
  }
  return key.trim();
});
