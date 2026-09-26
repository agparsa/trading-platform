import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as shared from '@tp/shared-types';

/**
 * Every vocabulary `@tp/shared-types` shares with the database has the
 * database's values, no more and no fewer.
 *
 * `OrderEventType` listed `UNCONFIRMED`, with a paragraph on what it meant;
 * the database enum did not have it. The one place that records an order
 * moving to UNCONFIRMED — sent to a venue, answer lost — could not write the
 * event it described, and wrote REJECTED instead: a trail saying the venue
 * refused an order it may have filled. TypeScript could not see it, because
 * the Prisma client and the shared types are two definitions of one thing.
 *
 * Paired by name. A database enum with no shared counterpart is not checked;
 * one with a counterpart is, both ways.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schema = readFileSync(resolve(ROOT, 'prisma/schema.prisma'), 'utf8');

const database = new Map(
  [...schema.matchAll(/^enum (\w+) \{([\s\S]*?)\n\}/gm)].map((match) => [
    match[1]!,
    [...match[2]!.matchAll(/^\s+([A-Z][A-Z0-9_]*)\s*$/gm)].map((value) => value[1]!).sort(),
  ]),
);

const paired = [...database.keys()].filter(
  (name) => typeof (shared as Record<string, unknown>)[name] === 'object',
);

describe('shared vocabularies', () => {
  it('pairs the ones the platform trades on (the probe that cannot fail is the one that never looked)', () => {
    for (const name of ['OrderStatus', 'OrderEventType', 'PositionStatus', 'CloseReason']) {
      expect(paired).toContain(name);
    }
  });

  it.each(paired)('%s has exactly the database values', (name) => {
    const values = Object.values((shared as unknown as Record<string, object>)[name]!)
      .map(String)
      .sort();
    expect(values).toEqual(database.get(name));
  });
});
