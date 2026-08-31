import { Global, Injectable, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseEncryptionKeys, SecretBox } from '@tp/crypto-core';
import type { Env } from '../../config/env.schema';

/**
 * The application's secret box, built from the configured key list.
 *
 * A class rather than a bare factory so that injection sites read as a
 * dependency on a service, and so a test can construct one with a throwaway key
 * without touching the environment.
 */
@Injectable()
export class SecretBoxService extends SecretBox {
  constructor(config: ConfigService<Env, true>) {
    super(parseEncryptionKeys(config.get('SECRET_ENCRYPTION_KEYS', { infer: true })));
  }
}

@Global()
@Module({
  providers: [SecretBoxService],
  exports: [SecretBoxService],
})
export class CryptoModule {}
