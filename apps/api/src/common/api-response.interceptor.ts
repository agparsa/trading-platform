import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { RequestWithContext } from './request-context';
import { ApiSuccess } from '@tp/shared-types';
import { map, Observable } from 'rxjs';

/**
 * Wraps every successful handler return value in the standard envelope, so no
 * controller has to remember to. Handlers return plain data; clients always see
 * `{ ok: true, data, meta }`.
 */
@Injectable()
export class ApiResponseInterceptor<T> implements NestInterceptor<T, ApiSuccess<T>> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<ApiSuccess<T>> {
    const request = context.switchToHttp().getRequest<RequestWithContext>();
    return next.handle().pipe(
      map((data) => ({
        ok: true as const,
        data,
        meta: {
          requestId: request.requestId ?? 'unknown',
          serverTime: Date.now(),
        },
      })),
    );
  }
}
