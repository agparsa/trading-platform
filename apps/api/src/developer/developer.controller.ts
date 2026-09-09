import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  DomainError,
  TradingErrorCode,
  SERVICE_GRANTABLE_PERMISSIONS,
  KEYABLE_PERMISSIONS,
} from '@tp/shared-types';
import { CREDENTIAL_PREFIX } from '@tp/crypto-core';
import { SIGNATURE_HEADER } from '@tp/webhooks-core';
import { SelfService } from '../common/decorators/self-service.decorator';
import { OpenApiDocumentService } from './openapi-document.service';

/**
 * What a developer integrating against this platform needs to read (§49).
 *
 * `@SelfService()`: any signed-in person, never a key. A script does not read
 * documentation; its author does, in a browser. Keeping the document behind a
 * session also means the full route surface — including every administrative
 * path — is not enumerable by anybody who can reach the host.
 */
@ApiTags('developer')
@Controller('developer')
@SelfService()
export class DeveloperController {
  constructor(private readonly openapi: OpenApiDocumentService) {}

  @Get('openapi.json')
  @SelfService()
  @ApiOperation({ summary: 'The OpenAPI document for this API, as built at boot' })
  openApi() {
    const document = this.openapi.get();
    if (document === null) {
      throw new DomainError(
        TradingErrorCode.RESOURCE_NOT_FOUND,
        'The API document was not generated at boot',
      );
    }
    return document;
  }

  /**
   * The facts a reference page states in prose and must not get wrong: which
   * header carries the signature, which capabilities a key or a token may
   * hold. Served rather than hard-coded in the page, so the page cannot drift
   * from the platform it describes.
   */
  @Get('conventions')
  @SelfService()
  @ApiOperation({
    summary:
      'Authentication, idempotency and webhook conventions, from the code that enforces them',
  })
  conventions() {
    return {
      authentication: {
        header: 'Authorization',
        scheme: 'Bearer',
        credentials: [
          'a session access token',
          `an API key (${CREDENTIAL_PREFIX.api_key}_…)`,
          `a service token (${CREDENTIAL_PREFIX.service_token}_…)`,
        ],
      },
      idempotency: {
        header: 'Idempotency-Key',
        requiredOn: 'every mutation on the trading routes',
        semantics:
          'the same key with the same body returns the stored result; the same key with a different body is refused',
      },
      webhooks: {
        signatureHeader: SIGNATURE_HEADER,
        scheme: 'v1',
        signedOver: '<t>.<raw body>',
        algorithm: 'HMAC-SHA256, hex',
        recommendedToleranceSeconds: 300,
      },
      keyablePermissions: KEYABLE_PERMISSIONS,
      serviceGrantablePermissions: SERVICE_GRANTABLE_PERMISSIONS,
    };
  }
}
