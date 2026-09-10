import 'reflect-metadata';
// First, and as a side effect: file-backed secrets must be in place before any
// module below reads the environment at import time. See config/file-secrets.ts.
import { FILE_SECRETS_RESOLVED } from './config/file-secrets';
import { monitorEventLoopDelay } from 'node:perf_hooks';
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
import { DrainState } from './common/drain';
import { OpenApiDocumentService } from './developer/openapi-document.service';
import { ApiResponseInterceptor } from './common/api-response.interceptor';
import { DomainExceptionFilter } from './common/domain-exception.filter';

async function bootstrap(): Promise<void> {
  /**
   * `rawBody` keeps the bytes as they arrived, alongside the parsed body.
   *
   * A webhook signature is computed over bytes. `JSON.parse` followed by
   * `JSON.stringify` produces different bytes for the same document — key order,
   * whitespace, how a number was written — so a signature checked against a
   * re-serialised body fails for every authentic delivery and, worse, would
   * tempt someone into "fixing" it by not checking at all.
   *
   * Nothing in this repository verifies a signature yet, because the only
   * payment provider here is the manual bank transfer, which sends no webhooks.
   * This is on so that the first adapter that does has the bytes to verify
   * against, rather than discovering on its first live payment that they were
   * thrown away at startup.
   */
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });
  const config = app.get(ConfigService<Env, true>);
  const logger = app.get(Logger);
  app.useLogger(logger);

  const isProduction = config.get('NODE_ENV', { infer: true }) === 'production';
  if (FILE_SECRETS_RESOLVED.length > 0) {
    logger.log(`Secrets read from files: ${FILE_SECRETS_RESOLVED.join(', ')}`);
  }

  /**
   * Before anything else, so a request refused while draining costs nothing
   * and a request admitted is counted for the whole of its life.
   */
  /**
   * The loop's own account of how busy it is: mean delay of a 20 ms timer over
   * the last second, re-read from the histogram and reset once a second so a
   * bad minute an hour ago does not keep refusing traffic now.
   */
  const LAG_RESOLUTION_MS = 20;
  const loopDelay = monitorEventLoopDelay({ resolution: LAG_RESOLUTION_MS });
  loopDelay.enable();
  let lagMs = 0;
  // A self-rescheduling timeout, as everywhere else here: an interval would
  // queue its callbacks behind the very lag it is meant to measure.
  const sampleLag = (): void => {
    // The histogram records the timer's whole interval; the lag is what is left
    // after the interval it was asked for.
    lagMs = Number.isFinite(loopDelay.mean)
      ? Math.max(0, loopDelay.mean / 1e6 - LAG_RESOLUTION_MS)
      : 0;
    loopDelay.reset();
    setTimeout(sampleLag, 1_000).unref();
  };
  setTimeout(sampleLag, 1_000).unref();
  const maxLag = config.get('HTTP_MAX_EVENT_LOOP_LAG_MS', { infer: true });

  const drain = new DrainState({
    maxInFlight: config.get('HTTP_MAX_IN_FLIGHT', { infer: true }),
    maxEventLoopLagMs: maxLag === 0 ? Number.POSITIVE_INFINITY : maxLag,
    eventLoopLag: () => lagMs,
    onShed: (shed, inFlight) =>
      logger.warn(
        `Refused ${shed} request(s) as overloaded (${inFlight} in flight, loop lag ${lagMs.toFixed(0)} ms). ` +
          'Add an instance, or raise HTTP_MAX_IN_FLIGHT / HTTP_MAX_EVENT_LOOP_LAG_MS if this is not a burst.',
      ),
  });
  app.use(drain.middleware());
  app.use(requestContext({ trustedProxyHops: config.get('TRUSTED_PROXY_HOPS', { infer: true }) }));
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
    exclude: ['health', 'health/market', 'ready', 'metrics'],
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

  /**
   * The OpenAPI document is built in every environment and handed to the
   * developer reference, which serves it behind authentication. Swagger's own
   * UI mounts on Express outside Nest's guards, so it stays a development
   * convenience: in production the whole route surface is not for anybody who
   * can reach the host.
   */
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
  app.get(OpenApiDocumentService).set(document);
  if (!isProduction) {
    SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'docs/openapi.json' });
  }

  /**
   * Signals are handled here rather than by `enableShutdownHooks`, because
   * that helper answers SIGTERM with `app.close()` at once — and `app.close()`
   * takes the database away from requests still in flight. See `DrainState`.
   * `app.close()` still runs every `onApplicationShutdown` hook; it just runs
   * them after the last request has left.
   */
  const drainDeadlineMs = config.get('SHUTDOWN_DRAIN_TIMEOUT_MS', { infer: true });
  let stopping = false;
  const stop = async (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    logger.log(
      `${signal}: draining ${drain.inFlightRequests} request(s) in flight, up to ${drainDeadlineMs} ms`,
    );
    const abandoned = await drain.drain(drainDeadlineMs, () => {
      (app.getHttpServer() as { closeIdleConnections?: () => void }).closeIdleConnections?.();
    });
    if (abandoned > 0) {
      logger.warn(
        `Drain deadline passed with ${abandoned} request(s) still in flight; closing anyway`,
      );
    } else {
      logger.log('Drained; closing');
    }
    await app.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void stop('SIGTERM'));
  process.once('SIGINT', () => void stop('SIGINT'));

  const port = config.get('API_PORT', { infer: true });
  const host = config.get('API_HOST', { infer: true });
  /**
   * Keep-alive, stated. Node closes an idle connection after five seconds by
   * default and a client reusing it at that instant is reset; see
   * `HTTP_KEEP_ALIVE_TIMEOUT_MS`. `headersTimeout` must exceed it, or Node
   * ends idle connections on the shorter of the two.
   */
  const server = app.getHttpServer() as {
    keepAliveTimeout: number;
    headersTimeout: number;
  };
  server.keepAliveTimeout = config.get('HTTP_KEEP_ALIVE_TIMEOUT_MS', { infer: true });
  server.headersTimeout = server.keepAliveTimeout + 1_000;
  /**
   * Listening directly rather than through `app.listen`, which offers no way
   * to state the backlog and leaves Node's 511. See `HTTP_LISTEN_BACKLOG`.
   *
   * `app.listen` also does one thing that is easy to miss: it flushes the logs
   * Nest buffered before `useLogger`. Without the `flushLogs()` below, the
   * first deploy of this lost every boot line — isolation probe, connection
   * budget, roles reconciled — while the health check passed. The smoke suite
   * now proves the boot log reaches stdout.
   */
  await app.init();
  await new Promise<void>((resolve, reject) => {
    const listening = app.getHttpServer() as {
      listen: (options: { port: number; host: string; backlog: number }, cb: () => void) => void;
      once: (event: 'error', cb: (error: Error) => void) => void;
    };
    listening.once('error', reject);
    listening.listen(
      { port, host, backlog: config.get('HTTP_LISTEN_BACKLOG', { infer: true }) },
      resolve,
    );
  });
  app.flushLogs();
  logger.log(
    `API listening on http://${host}:${port} (${config.get('NODE_ENV', { infer: true })})`,
  );
}

void bootstrap();
