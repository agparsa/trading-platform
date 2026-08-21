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
