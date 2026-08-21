import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { VersioningType } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { ZodValidationPipe } from 'nestjs-zod';
import helmet from 'helmet';
import { API_VERSION } from '@tp/shared-types';
import { AppModule } from './app.module';
import { corsOrigins, Env } from './config/env.schema';
import { requestContext } from './common/request-context';
import { ApiResponseInterceptor } from './common/api-response.interceptor';
import { DomainExceptionFilter } from './common/domain-exception.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService<Env, true>);
  const logger = app.get(Logger);
  app.useLogger(logger);

  const isProduction = config.get('NODE_ENV', { infer: true }) === 'production';

  app.use(requestContext);
  app.use(
    helmet({
      // The API serves JSON only; a restrictive CSP costs nothing here.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  app.enableCors({
    origin: corsOrigins(config.get('CORS_ORIGINS', { infer: true })),
    credentials: true,
    // The client needs to read the request id back to report a failure.
    exposedHeaders: ['X-Request-Id'],
  });

  app.setGlobalPrefix(config.get('API_GLOBAL_PREFIX', { infer: true }), {
    exclude: ['health', 'ready', 'metrics'],
  });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: API_VERSION.replace('v', '') });

  /**
   * One validation library for the whole platform.
   *
   * Request DTOs are Zod schemas, the same way the environment contract and the
   * shared wire types are, so a rule about a price format is written once
   * instead of once per layer.
   */
  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalInterceptors(new ApiResponseInterceptor());
  app.useGlobalFilters(new DomainExceptionFilter());

  if (!isProduction) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Trading Platform API')
        .setDescription(
          'Order, position and market endpoints. Every mutation requires an Idempotency-Key header.',
        )
        .setVersion('0.1.0')
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'docs/openapi.json' });
  }

  app.enableShutdownHooks();

  const port = config.get('API_PORT', { infer: true });
  const host = config.get('API_HOST', { infer: true });
  await app.listen(port, host);
  logger.log(
    `API listening on http://${host}:${port} (${config.get('NODE_ENV', { infer: true })})`,
  );
}

void bootstrap();
