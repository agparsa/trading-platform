import { Module, RequestMethod, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { raw } from 'express';
import { ACCEPTED_CONTENT_TYPES, MAX_DOCUMENT_BYTES } from '@tp/kyc-core';
import { API_VERSION } from '@tp/shared-types';
import { NotificationsModule } from '../notifications/notifications.module';
import { KycService } from './kyc.service';
import { AdminKycService } from './admin-kyc.service';
import { KycController } from './kyc.controller';
import { AdminKycController } from './admin-kyc.controller';

/**
 * Identity verification.
 *
 * Imports `NotificationsModule` because a decision is told to the person it is
 * about. Imports nothing from trading, and nothing from trading imports this:
 * a withdrawal may ask `KycService.isVerified`; opening a position never does.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [KycController, AdminKycController],
  providers: [KycService, AdminKycService],
  exports: [KycService],
})
export class KycModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    /**
     * The raw-body parser, on the one route that takes a file.
     *
     * Scoped this narrowly on purpose. The JSON parser everywhere else stops at
     * its default hundred kilobytes, and that is the right limit for every
     * other route on the API — nothing else has a reason to send more than a
     * form. Here the limit is the document ceiling, and the parser refuses a
     * larger body with a 413 before a byte of it reaches the service.
     *
     * `type` lists the accepted content types so that a JSON body sent to this
     * route is not swallowed as bytes; it falls through, and the controller
     * refuses it by name.
     */
    consumer
      .apply(raw({ type: [...ACCEPTED_CONTENT_TYPES], limit: MAX_DOCUMENT_BYTES }))
      /**
       * Named exactly, with its version. Nest prefixes the global prefix; the
       * version has to be stated because URI versioning puts it in the path
       * and a middleware route without it matches nothing. An earlier wildcard
       * form was rejected by Express 5's path parser at boot — and the API did
       * not start at all, which the smoke suite caught and no unit test could.
       */
      .forRoutes({
        path: 'kyc/documents/:kind',
        method: RequestMethod.PUT,
        version: API_VERSION.replace('v', ''),
      });
  }
}
