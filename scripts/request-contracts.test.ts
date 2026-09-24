import { describe, expect, it } from 'vitest';
import {
  type OpenApiDocument,
  type SentBody,
  type SentField,
  type SentShape,
  checkRequests,
  sentBodies,
} from './request-contracts';
import type { ClientCall } from './response-contracts';

/**
 * The request half of `pnpm smoke:contracts`, without a running API.
 *
 * The smoke run compares the compiler's view of every body and query the
 * clients send with the schemas the API publishes at boot. Here the reader is
 * run on the real clients, and the comparer on a small document written for
 * the purpose, one case per way a request can be refused.
 */
const bodies = sentBodies();

describe('the body reader', () => {
  it('finds the bodies of every client (the probe that cannot fail is the one that never looked)', () => {
    expect(bodies.length).toBeGreaterThan(80);
    expect(bodies.some((body) => body.call.app === 'mobile')).toBe(true);
  });

  it('reads what the web sends for an order, and that does not include the idempotency key', () => {
    // `mutate` strips `commandId` into a header, and typed the rest as if it
    // had not: every order body claimed a field the schema refuses.
    const order = bodies.find(
      (body) => body.call.app === 'web' && body.call.key === 'POST /orders',
    );
    const names = (order?.shapes ?? []).flatMap((shape) =>
      (shape ?? []).map((field) => field.name),
    );
    expect(names).toEqual(expect.arrayContaining(['accountId', 'symbol', 'side', 'volume']));
    expect(names).not.toContain('commandId');
  });

  it('reads one level down: the sessions a desk writes are a list of windows', () => {
    const sessions = bodies.find((body) => body.call.key === 'POST /admin/instruments/*/sessions');
    const windows = sessions?.shapes[0]?.find((field) => field.name === 'windows');
    expect(windows?.nested?.[0]?.map((field) => field.name).sort()).toEqual([
      'closeMinute',
      'dayOfWeek',
      'openMinute',
    ]);
  });

  it('can list the fields of every body a client sends', () => {
    expect(
      bodies.filter((body) => body.shapes.some((shape) => shape === null)).map((b) => b.typeText),
    ).toEqual([]);
  });
});

const call = (
  verb: ClientCall['verb'],
  path: string,
  query?: Record<string, string | null>,
): ClientCall => ({
  app: 'web',
  file: 'test',
  line: 1,
  verb,
  path,
  typeText: undefined,
  query,
  key: `${verb} ${path}`,
});
const field = (
  name: string,
  kinds: SentField['kinds'],
  extra: Partial<SentField> = {},
): SentField => ({
  name,
  optional: false,
  kinds,
  nested: null,
  ...extra,
});
const body = (path: string, shape: SentShape): SentBody => ({
  call: call('POST', path),
  typeText: 'test',
  shapes: [shape],
});

const strict = { 'x-nestjs_zod-parent-additional-properties': false } as const;
const document: OpenApiDocument = {
  paths: {
    '/api/v1/orders': {
      post: {
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } },
        },
      },
    },
    '/api/v1/sessions': {
      post: {
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  windows: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: { dayOfWeek: { type: 'integer' } },
                      required: ['dayOfWeek'],
                      additionalProperties: false,
                    },
                    ...strict,
                  },
                },
                required: ['windows'],
              },
            },
          },
        },
      },
    },
    '/api/v1/positions/{id}/reverse': { post: {} },
    '/api/v1/positions': {
      get: {
        parameters: [
          { name: 'accountId', in: 'query', required: true },
          { name: 'limit', in: 'query', required: false },
        ],
      },
    },
  },
  components: {
    schemas: {
      Order: {
        type: 'object',
        properties: {
          symbol: { type: 'string', ...strict },
          volume: { type: 'string', ...strict },
          stopLoss: { anyOf: [{ type: 'string' }, { type: 'null' }], ...strict },
        },
        required: ['symbol', 'volume'],
      },
    },
  },
};

const order = [field('symbol', new Set(['string'])), field('volume', new Set(['string']))];

const cases: Array<{
  name: string;
  bodies: SentBody[];
  calls: ClientCall[];
  wrong: RegExp | null;
}> = [
  { name: 'an order the schema accepts', bodies: [body('/orders', order)], calls: [], wrong: null },
  {
    name: 'a field a strict schema does not name',
    bodies: [body('/orders', [...order, field('commandId', new Set(['string']))])],
    calls: [],
    wrong: /sends `commandId`/,
  },
  {
    name: 'a required field missing',
    bodies: [body('/orders', [order[0]!])],
    calls: [],
    wrong: /omits `volume`/,
  },
  {
    name: 'a required field the client may leave out',
    bodies: [
      body('/orders', [order[0]!, field('volume', new Set(['string']), { optional: true })]),
    ],
    calls: [],
    wrong: /may omit `volume`/,
  },
  {
    name: 'a number where the schema takes a string',
    bodies: [body('/orders', [order[0]!, field('volume', new Set(['number']))])],
    calls: [],
    wrong: /`volume` as number/,
  },
  {
    name: 'null where the schema allows it',
    bodies: [body('/orders', [...order, field('stopLoss', new Set(['string', 'null']))])],
    calls: [],
    wrong: null,
  },
  {
    name: 'a wrong field inside a list of objects',
    bodies: [
      body('/sessions', [
        field('windows', new Set(['array']), {
          nested: [[field('day', new Set(['number']))]],
        }),
      ]),
    ],
    calls: [],
    wrong: /`windows.day`/,
  },
  {
    name: 'a body sent to a route that reads none',
    bodies: [body('/positions/*/reverse', [field('reason', new Set(['string']))])],
    calls: [],
    wrong: /reads no body/,
  },
  {
    name: 'a route the document does not have',
    bodies: [body('/nowhere', [])],
    calls: [],
    wrong: /no such operation/,
  },
  {
    name: 'a query without the key the route requires',
    bodies: [],
    calls: [call('GET', '/positions', {})],
    wrong: /`accountId`, which the route requires/,
  },
  {
    name: 'a query key the route does not declare',
    bodies: [],
    calls: [call('GET', '/positions', { accountId: null, includeClosd: 'true' })],
    wrong: /`includeClosd`, which the route does not declare/,
  },
  {
    name: 'a query the route accepts',
    bodies: [],
    calls: [call('GET', '/positions', { accountId: null, limit: '100' })],
    wrong: null,
  },
];

describe('the request comparer', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const messages = checkRequests(c.bodies, c.calls, document).problems.map((p) => p.message);
    if (c.wrong === null) expect(messages).toEqual([]);
    else expect(messages.join('\n')).toMatch(c.wrong);
  });
});
