import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { DrainState } from './drain';

/**
 * Stopping without dropping anything.
 *
 * What is pinned: a request admitted before SIGTERM is waited for; one that
 * arrives after is refused with a coded 503 and told to retry; the wait ends
 * the moment the last request leaves; and a hung request cannot hold the
 * process past the deadline.
 */

function fakeResponse() {
  const emitter = new EventEmitter();
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body: unknown;
  const res = {
    setHeader: (k: string, v: string) => void (headers[k] = v),
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(payload: unknown) {
      body = payload;
      return res;
    },
    once: (event: string, fn: () => void) => emitter.once(event, fn),
    finish: () => emitter.emit('finish'),
    close: () => emitter.emit('close'),
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
    headers,
  };
  return res;
}

const request = { path: '/api/v1/orders' } as Request;

describe('DrainState', () => {
  it('counts requests in and out', () => {
    const drain = new DrainState();
    const middleware = drain.middleware();
    const a = fakeResponse();
    const b = fakeResponse();
    const next: NextFunction = () => undefined;
    middleware(request, a as unknown as Response, next);
    middleware(request, b as unknown as Response, next);
    expect(drain.inFlightRequests).toBe(2);
    a.finish();
    expect(drain.inFlightRequests).toBe(1);
    // A response that both finishes and closes is counted out once, not twice.
    b.finish();
    b.close();
    expect(drain.inFlightRequests).toBe(0);
    a.close();
    expect(drain.inFlightRequests).toBe(0);
  });

  it('refuses a request that arrives while draining, with a coded 503 and Connection: close', async () => {
    const drain = new DrainState();
    await drain.drain(10);
    const res = fakeResponse();
    let passed = false;
    drain.middleware()(request, res as unknown as Response, () => {
      passed = true;
    });
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(503);
    expect(res.headers['Connection']).toBe('close');
    expect(res.headers['Retry-After']).toBeDefined();
    expect(res.body).toMatchObject({ ok: false, error: { code: 'SERVICE_UNAVAILABLE' } });
    expect(drain.inFlightRequests).toBe(0);
  });

  it('waits for what is in flight and resolves the moment the last request leaves', async () => {
    const drain = new DrainState();
    const res = fakeResponse();
    drain.middleware()(request, res as unknown as Response, () => undefined);

    let resolved = false;
    const waiting = drain.drain(5_000).then((abandoned) => {
      resolved = true;
      return abandoned;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);
    expect(drain.isDraining).toBe(true);

    const before = Date.now();
    res.finish();
    expect(await waiting).toBe(0);
    // The moment, not the deadline: the last request leaving is what wakes it.
    expect(Date.now() - before).toBeLessThan(1_000);
  });

  it('gives up at the deadline and reports how many it abandoned', async () => {
    const drain = new DrainState();
    drain.middleware()(request, fakeResponse() as unknown as Response, () => undefined);
    drain.middleware()(request, fakeResponse() as unknown as Response, () => undefined);
    const started = Date.now();
    const abandoned = await drain.drain(50);
    expect(abandoned).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });

  it('resolves at once when nothing is in flight, and tells the caller draining began', async () => {
    const drain = new DrainState();
    let told = false;
    expect(await drain.drain(5_000, () => (told = true))).toBe(0);
    expect(told).toBe(true);
  });

  /**
   * Admission control. Above the limit a newcomer is refused at once with a
   * code and Retry-After — never accepted into a queue the process cannot
   * serve, which is how two thousand simultaneous orders became connection
   * resets with no answer.
   */
  describe('at the concurrency limit', () => {
    const admit = (drain: DrainState, path = '/api/v1/orders') => {
      const res = fakeResponse();
      let passed = false;
      drain.middleware()({ path } as Request, res as unknown as Response, () => {
        passed = true;
      });
      return { res, passed };
    };

    it('refuses the request above the limit, immediately and by name, and admits again once one leaves', () => {
      const shed: Array<[number, number]> = [];
      const drain = new DrainState({
        maxInFlight: 2,
        onShed: (n, inFlight) => shed.push([n, inFlight]),
      });
      const first = admit(drain);
      const second = admit(drain);
      expect(first.passed && second.passed).toBe(true);
      expect(drain.inFlightRequests).toBe(2);

      const third = admit(drain);
      expect(third.passed).toBe(false);
      expect(third.res.statusCode).toBe(503);
      expect(third.res.headers['Retry-After']).toBe('1');
      expect(third.res.body).toMatchObject({ ok: false, error: { code: 'SERVICE_UNAVAILABLE' } });
      // A refused request was never inside, so it is not counted out either.
      expect(drain.inFlightRequests).toBe(2);
      expect(drain.shedRequests).toBe(1);
      expect(shed).toEqual([[1, 2]]);

      first.res.finish();
      const fourth = admit(drain);
      expect(fourth.passed).toBe(true);
      expect(drain.inFlightRequests).toBe(2);
    });

    it('always admits the liveness probe, because a killed process helps nobody', () => {
      const drain = new DrainState({ maxInFlight: 1 });
      admit(drain);
      const probe = admit(drain, '/health');
      expect(probe.passed).toBe(true);
      const ready = admit(drain, '/ready');
      expect(ready.passed).toBe(false);
    });

    it('says that shedding happened at once, then at most once per window with the count since', () => {
      vi.useFakeTimers();
      try {
        const shed: number[] = [];
        const drain = new DrainState({
          maxInFlight: 1,
          onShed: (n) => shed.push(n),
          logEveryMs: 60_000,
        });
        admit(drain);
        admit(drain);
        admit(drain);
        admit(drain);
        expect(drain.shedRequests).toBe(3);
        // The first refusal is said immediately; the next two wait for the window.
        expect(shed).toEqual([1]);

        vi.advanceTimersByTime(60_000);
        admit(drain);
        expect(shed).toEqual([1, 3]);
        expect(drain.shedRequests).toBe(4);
      } finally {
        vi.useRealTimers();
      }
    });

    it('refuses on event-loop lag too, whatever the count, and admits again when the loop catches up', () => {
      let lag = 0;
      const drain = new DrainState({ maxEventLoopLagMs: 1_000, eventLoopLag: () => lag });
      expect(admit(drain).passed).toBe(true);
      lag = 1_001;
      const refused = admit(drain);
      expect(refused.passed).toBe(false);
      expect(refused.res.statusCode).toBe(503);
      expect(refused.res.body).toMatchObject({ ok: false, error: { code: 'SERVICE_UNAVAILABLE' } });
      expect((refused.res.body as { error: { message: string } }).error.message).toMatch(
        /too busy/,
      );
      expect(admit(drain, '/health').passed).toBe(true);
      lag = 1_000;
      expect(admit(drain).passed).toBe(true);
      expect(drain.shedRequests).toBe(1);
    });

    it('sheds nothing by default', () => {
      const drain = new DrainState();
      for (let i = 0; i < 1_000; i += 1) expect(admit(drain).passed).toBe(true);
      expect(drain.shedRequests).toBe(0);
    });
  });
});
