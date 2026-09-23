import { describe, expect, it } from 'vitest';
import { fetchApiLiveness } from './api';

const answer = (status: number, body: unknown) =>
  (async () =>
    ({ ok: status >= 200 && status < 300, json: async () => body }) as Response) as typeof fetch;

/**
 * The status page read `/health` as though the body were the data. Production
 * showed "up · undefineds" to anyone who followed the terminal's "Build status"
 * link. These pin the envelope.
 */
describe('fetchApiLiveness', () => {
  it('unwraps the envelope /health answers with', async () => {
    const liveness = await fetchApiLiveness(
      answer(200, {
        ok: true,
        data: { status: 'ok', uptimeSeconds: 42, build: 'abc123def456' },
        meta: {},
      }),
      'http://api',
    );
    expect(liveness).toEqual({ status: 'ok', uptimeSeconds: 42, build: 'abc123def456' });
  });

  it('treats a bare body — the shape it used to assume — as no answer, not as an answer with holes', async () => {
    expect(
      await fetchApiLiveness(answer(200, { status: 'ok', uptimeSeconds: 42 }), 'http://api'),
    ).toBeNull();
  });

  it('says unknown for an API built without a marker', async () => {
    const liveness = await fetchApiLiveness(
      answer(200, { ok: true, data: { status: 'ok', uptimeSeconds: 1 } }),
      'http://api',
    );
    expect(liveness?.build).toBe('unknown');
  });

  it('is null when the API refuses or cannot be reached', async () => {
    expect(await fetchApiLiveness(answer(503, {}), 'http://api')).toBeNull();
    expect(
      await fetchApiLiveness(
        (async () => {
          throw new Error('ECONNREFUSED');
        }) as typeof fetch,
        'http://api',
      ),
    ).toBeNull();
  });
});
