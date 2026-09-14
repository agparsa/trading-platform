import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_QUEUES, DEFAULT_JOB_OPTIONS, QueueName } from './queues';

describe('queue configuration', () => {
  it('exposes every declared queue', () => {
    expect(ALL_QUEUES).toContain(QueueName.SWAP_ACCRUAL);
    expect(ALL_QUEUES).toHaveLength(Object.keys(QueueName).length);
  });

  it('uses unique queue names', () => {
    expect(new Set(ALL_QUEUES).size).toBe(ALL_QUEUES.length);
  });

  it('keeps failed financial jobs for inspection', () => {
    expect(DEFAULT_JOB_OPTIONS.removeOnFail).toBe(false);
  });

  it('retries with exponential backoff rather than hammering a sick dependency', () => {
    expect(DEFAULT_JOB_OPTIONS.backoff.type).toBe('exponential');
    expect(DEFAULT_JOB_OPTIONS.attempts).toBeGreaterThan(1);
  });
});

/**
 * The jobs table in `docs/worker.md` has to list the jobs.
 *
 * It did not. Three scheduled queues — broker health, the outbox relay and
 * webhook delivery — had been added since the table was written, and the table
 * still described a worker with three jobs where there were six. Nobody was
 * wrong about anything; the list simply did not move, and the document is what
 * an operator reads at three in the morning to find out what is supposed to be
 * happening.
 *
 * A static check pointed at the document rather than at the code it describes,
 * which is the only direction that works: the code is what runs, so it cannot
 * be checked against the prose it drifted from.
 */
describe('the jobs table in docs/worker.md', () => {
  const doc = readFileSync(join(process.cwd(), 'docs', 'worker.md'), 'utf8');

  it('names every queue this worker declares', () => {
    const missing = ALL_QUEUES.filter((name) => !doc.includes(`\`${name}\``));
    expect(missing, 'a queue nobody documented is work nobody knows is supposed to happen').toEqual(
      [],
    );
  });
});
