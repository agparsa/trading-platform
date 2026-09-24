import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { routeThrottles } from './api-inventory';

/**
 * The rate limits `docs/api.md` publishes, against the decorators that set them.
 *
 * The page listed three buckets: login at 5 a minute, "order create / modify /
 * close" at 120, everything else at 600. What the controllers do is wider:
 * registration, both halves of two-factor and both halves of a password reset
 * share the sign-in bucket; token refresh has its own at six times it; the
 * order preview is not in the order bucket; and beneath the per-address limits
 * sit per-account, per-firm and per-key ceilings the page never named. An
 * integrator whose script refreshes a token thirty-one times a minute got a 429
 * the reference said could not happen.
 *
 * The table now names every route in every bucket, and this holds it there in
 * both directions, with each default computed from the code's own fallback.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const doc = readFileSync(resolve(ROOT, 'docs/api.md'), 'utf8');
const schema = readFileSync(resolve(ROOT, 'apps/api/src/config/env.schema.ts'), 'utf8');

/** The fallback `rateLimits.<bucket>` returns with nothing configured. */
const fallback = (bucket: string): number => {
  const getter = new RegExp(
    `get ${bucket}\\(\\): number \\{\\s*return rateLimitFromEnv\\('([A-Z_]+)', (\\d+)\\)`,
  ).exec(schema);
  if (getter === null) throw new Error(`rateLimits.${bucket} not found in env.schema.ts`);
  return Number(getter[2]);
};

/**
 * `rateLimits.login * 6` → 30 and `Math.ceil(rateLimits.orders / 2)` → 60,
 * with the setting each follows. Any other form is refused rather than
 * guessed at, so a new way of writing a limit fails here first.
 */
const evaluate = (expression: string): { limit: number; bucket: string } => {
  const text = expression.trim();
  const times = /^rateLimits\.(\w+)(?:\s*\*\s*(\d+))?$/.exec(text);
  if (times !== null) {
    return { bucket: times[1]!, limit: fallback(times[1]!) * Number(times[2] ?? 1) };
  }
  const half = /^Math\.ceil\(rateLimits\.(\w+)\s*\/\s*(\d+)\)$/.exec(text);
  if (half !== null) {
    return { bucket: half[1]!, limit: Math.ceil(fallback(half[1]!) / Number(half[2])) };
  }
  throw new Error(`a throttle this test cannot read: ${expression}`);
};

/** A schema default, for a setting read through the schema rather than `rateLimits`. */
const schemaDefault = (name: string): number => {
  const at = schema.indexOf(`${name}: z`);
  if (at === -1) throw new Error(`${name} not in env.schema.ts`);
  const match = /\.default\((\d+)\)/.exec(schema.slice(at, schema.indexOf(',\n', at) + 1));
  if (match === null) throw new Error(`${name} has no default`);
  return Number(match[1]);
};

interface Row {
  readonly cells: string[];
  readonly routes: string[];
  readonly limit: number;
}

/** The rows of the first table after a heading. */
const table = (heading: string): Row[] => {
  const section = doc.slice(doc.indexOf(heading));
  const start = section.indexOf('\n|');
  const rows = section
    .slice(start + 1, section.indexOf('\n\n', start))
    .split('\n')
    .slice(2);
  return rows.map((line) => {
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    return {
      cells,
      routes: [...line.matchAll(/`((?:GET|POST|PUT|PATCH|DELETE) \/[^`]*)`/g)].map((m) => m[1]!),
      limit: Number(/(\d[\d,]*) \/ minute/.exec(line)?.[1]?.replace(/,/g, '') ?? NaN),
    };
  });
};

const throttles = routeThrottles();
const buckets = table('## Rate limits');

describe('the per-address buckets in docs/api.md', () => {
  it('reads the decorators (the probe that cannot fail is the one that never looked)', () => {
    expect(throttles.length).toBeGreaterThan(10);
    expect(throttles.some((t) => t.route === 'POST /auth/refresh')).toBe(true);
  });

  it('lists every throttled route, in the bucket its decorator names', () => {
    const inCode = throttles.map((t) => `${t.route} @ ${evaluate(t.expression).limit}`).sort();
    const inDoc = buckets
      .flatMap((row) => row.routes.map((route) => `${route} @ ${row.limit}`))
      .sort();
    expect(inDoc).toEqual(inCode);
  });

  it("uses fallbacks that agree with the schema's own defaults", () => {
    // Two places hold each default — the decorator's fallback and the schema.
    // A bucket documented from one while the process ran on the other would
    // be this page being wrong in a way no reader could see.
    for (const [bucket, setting] of [
      ['login', 'RATE_LIMIT_LOGIN_PER_MINUTE'],
      ['orders', 'RATE_LIMIT_ORDERS_PER_MINUTE'],
      ['api', 'RATE_LIMIT_API_PER_MINUTE'],
      ['socketMessages', 'RATE_LIMIT_SOCKET_MESSAGES_PER_MINUTE'],
    ] as const) {
      expect(fallback(bucket), setting).toBe(schemaDefault(setting));
    }
  });

  it('gives the default for everything else from the code', () => {
    const rest = buckets.find((row) => row.routes.length === 0);
    expect(rest?.limit).toBe(fallback('api'));
  });

  it('names the setting each bucket follows', () => {
    for (const row of buckets) {
      const throttle =
        row.routes.length === 0
          ? { expression: 'rateLimits.api' }
          : throttles.find((t) => t.route === row.routes[0]);
      const { bucket } = evaluate(throttle!.expression);
      const setting = new RegExp(
        `get ${bucket}\\(\\): number \\{\\s*return rateLimitFromEnv\\('([A-Z_]+)'`,
      ).exec(schema)?.[1];
      expect(row.cells.join(' '), row.cells[0]).toContain(`\`${setting}\``);
    }
  });
});

describe('the ceilings beneath them', () => {
  const ceilings = table('### Ceilings that are not per address');

  it('state the defaults the schema gives', () => {
    expect(ceilings.length).toBeGreaterThan(0);
    for (const row of ceilings) {
      const setting = /`([A-Z_]+)`/.exec(row.cells.at(-1) ?? '')?.[1];
      expect(setting, row.cells[0]).toBeDefined();
      const expected =
        setting === 'RATE_LIMIT_SOCKET_MESSAGES_PER_MINUTE'
          ? fallback('socketMessages')
          : schemaDefault(setting!);
      expect(row.limit, setting).toBe(expected);
    }
  });

  it('include every per-minute limit the schema declares', () => {
    const declared = [...schema.matchAll(/^\s+([A-Z_]*RATE_LIMIT[A-Z_]*): z/gm)].map((m) => m[1]!);
    const inBuckets = [
      'RATE_LIMIT_LOGIN_PER_MINUTE',
      'RATE_LIMIT_ORDERS_PER_MINUTE',
      'RATE_LIMIT_API_PER_MINUTE',
    ];
    const documented = new Set([
      ...inBuckets,
      ...ceilings.map((row) => /`([A-Z_]+)`/.exec(row.cells.at(-1) ?? '')?.[1]),
    ]);
    expect(declared.filter((name) => !documented.has(name))).toEqual([]);
  });
});
