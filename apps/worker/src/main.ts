import 'reflect-metadata';
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
  logger.log('Worker started');
}

void bootstrap();
