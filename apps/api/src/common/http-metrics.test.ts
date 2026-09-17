import { describe, expect, it } from 'vitest';
import express from 'express';
import { Registry, Counter, Histogram } from 'prom-client';
import type { AddressInfo } from 'node:net';
import { UNMATCHED, httpMetrics, routeLabel } from './http-metrics';
import type { MetricsService } from '../metrics/metrics.service';

describe('routeLabel', () => {
  /**
   * The whole point. A label value is a time series: the URL would mean one
   * series per account for ever, and account identifiers inside a metrics
   * store with its own access rules and its own retention.
   */
  it('is the route pattern, not the URL', () => {
    expect(
      routeLabel({
        baseUrl: '',
        route: { path: '/api/v1/accounts/:id/positions' },
        originalUrl: '/api/v1/accounts/8b1e0533-0000-4000-8000-000000000001/positions',
      }),
    ).toBe('/api/v1/accounts/:id/positions');
  });

  it('says unmatched when nothing routed, so a 404 flood is one series', () => {
    expect(routeLabel({ originalUrl: '/nope' })).toBe(UNMATCHED);
    expect(routeLabel({ route: { path: '' } })).toBe(UNMATCHED);
    expect(routeLabel({ route: {} })).toBe(UNMATCHED);
  });

  /**
   * Belt and braces, and deliberately so: if a future Express or a hand-mounted
   * handler ever leaves the raw path here, the failure is silent, expensive and
   * a privacy incident.
   */
  it('refuses a label that still looks like an identifier', () => {
    for (const path of [
      '/api/v1/accounts/8b1e0533-0000-4000-8000-000000000001',
      '/api/v1/accounts/8b1e0533-0000-4000-8000-000000000001/positions',
      '/api/v1/orders/1024',
      '/api/v1/reports/aGVsbG8tdGhlcmUtZnJpZW5kLTEyMw',
    ]) {
      expect(routeLabel({ route: { path } }), path).toBe(UNMATCHED);
    }
  });

  it('keeps an ordinary pattern with a parameter in it', () => {
    expect(routeLabel({ baseUrl: '/api/v1', route: { path: '/orders/:orderId' } })).toBe(
      '/api/v1/orders/:orderId',
    );
  });
});

describe('httpMetrics', () => {
  /**
   * Through a real express, because the defect being fixed was precisely that
   * nothing ever called these — a test on the function alone would have passed
   * against the broken platform too.
   */
  it('counts a request and times it, labelled by pattern and status', async () => {
    const registry = new Registry();
    const metrics = {
      httpRequests: new Counter({
        name: 'tp_http_requests_total',
        help: 'x',
        labelNames: ['method', 'route', 'status'] as const,
        registers: [registry],
      }),
      httpDuration: new Histogram({
        name: 'tp_http_request_duration_seconds',
        help: 'x',
        labelNames: ['method', 'route'] as const,
        registers: [registry],
      }),
    } as unknown as MetricsService;

    const app = express();
    app.use(httpMetrics(metrics));
    app.get('/accounts/:id', (_request, response) => response.status(200).json({ ok: true }));

    const server = app.listen(0);
    try {
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      const { port } = server.address() as AddressInfo;
      await fetch(`http://127.0.0.1:${port}/accounts/8b1e0533-0000-4000-8000-000000000001`);
      await fetch(`http://127.0.0.1:${port}/not-a-route`);
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if ((await registry.getMetricsAsJSON())[0]?.values?.length === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const printed = await registry.metrics();
      expect(printed).toContain('tp_http_requests_total{method="GET",route="/accounts/:id",status="200"} 1');
      expect(printed).toContain(`route="${UNMATCHED}"`);
      expect(printed, 'an account id reached a metrics label').not.toContain('8b1e0533');
      expect(printed).toMatch(/tp_http_request_duration_seconds_count\{[^}]*route="\/accounts\/:id"[^}]*\} 1/);
    } finally {
      server.close();
    }
  });
});
