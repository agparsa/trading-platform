import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ALL_QUEUES } from './queues';

/**
 * The API and the worker must agree on the queue names.
 *
 * They are declared twice on purpose — the two processes deploy independently,
 * and importing across the boundary would mean the API could not be released
 * without the worker. That freedom costs one thing: the names can drift, and a
 * job published to `reconcilation` (sic) would sit in Redis for ever while
 * everything reported success.
 *
 * So this reads the worker's own file and compares. It is a string comparison
 * across a process boundary, which is exactly what the queue is.
 */
const WORKER_QUEUES = existsSync('apps/worker/src/queues.ts')
  ? 'apps/worker/src/queues.ts'
  : '../worker/src/queues.ts';

describe('queue names', () => {
  it('match the worker, exactly', () => {
    const source = readFileSync(WORKER_QUEUES, 'utf8');
    const declared = [...source.matchAll(/^\s+[A-Z_]+:\s*'([a-z-]+)',/gm)].map((match) => match[1]);

    expect(declared.length).toBeGreaterThan(0);
    expect([...ALL_QUEUES].sort()).toEqual([...declared].sort());
  });
});
