import 'reflect-metadata';
// First, and as a side effect: file-backed secrets must be in place before
// worker.module.ts reads the environment at import time. See file-secrets.ts.
import { FILE_SECRETS_RESOLVED } from './file-secrets';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { WorkerModule } from './worker.module';

/**
 * The worker is a headless Nest application context — it serves no HTTP.
 * Shutdown hooks are enabled so a SIGTERM drains in-flight jobs and closes the
 * Redis connections rather than abandoning them.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);
  app.enableShutdownHooks();
  if (FILE_SECRETS_RESOLVED.length > 0) {
    logger.log(`Secrets read from files: ${FILE_SECRETS_RESOLVED.join(', ')}`);
  }
  logger.log('Worker started');
}

void bootstrap();
