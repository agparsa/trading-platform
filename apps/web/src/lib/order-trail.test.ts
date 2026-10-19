import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ORDER_EVENT_LABEL, trailLines } from './order-trail';

const event = (type: string, payload: Record<string, unknown> = {}) => ({
  type,
  fromStatus: null,
  toStatus: 'X',
  payload,
  at: '2026-10-19T08:00:00.000Z',
});

describe('an order trail, in words', () => {
  it('names each step and states its facts as the server wrote them', () => {
    const lines = trailLines([
      event('CREATED', { volume: '1.00', price: '4500.00', timeInForce: 'GTC' }),
      event('MODIFIED', { price: '4510.00', previousPrice: '4500.00', by: 'SYSTEM' }),
      event('REJECTED', { reason: 'INSUFFICIENT_MARGIN' }),
    ]);
    expect(lines.map((line) => line.label)).toEqual(['Placed', 'Changed', 'Refused']);
    expect(lines[0]?.facts).toBe('volume 1.00 · price 4500.00 · time in force GTC');
    expect(lines[1]?.facts).toBe('price 4510.00 · was price 4500.00 · by system');
    expect(lines[2]?.reason).toBe('INSUFFICIENT_MARGIN');
  });

  it('shows a step it does not know as spelled', () => {
    expect(trailLines([event('ROUTED')])[0]?.label).toBe('ROUTED');
  });

  it('names every event type the schema has, read from the schema', () => {
    const schema = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../../../prisma/schema.prisma'),
      'utf8',
    );
    const body = /enum OrderEventType \{([^}]*)\}/.exec(schema)?.[1] ?? '';
    const types = body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[A-Z_]+$/.test(line));
    expect(types.length).toBeGreaterThan(5);
    expect(Object.keys(ORDER_EVENT_LABEL).sort()).toEqual(types.sort());
  });
});
