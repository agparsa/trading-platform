import { describe, expect, it } from 'vitest';
import {
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_PREFIX,
  WORKER_HEARTBEAT_TTL_SECONDS,
  parseWorkerHeartbeat,
  workerHeartbeatKey,
} from './worker-heartbeat';

const beat = {
  instance: 'host-1:42',
  build: 'b6043fee9a91',
  role: 'all',
  queues: ['swap-accrual', 'reconciliation'],
  startedAt: '2026-09-21T08:00:00.000Z',
  at: '2026-09-21T08:05:00.000Z',
  egress: {
    target: 'dl-cdn.alpinelinux.org',
    ok: false,
    checkedAt: '2026-09-21T08:04:00.000Z',
    error: 'ETIMEDOUT',
  },
};

describe('worker heartbeat contract', () => {
  it('keys every instance under one prefix, so the reader can scan for all of them', () => {
    expect(workerHeartbeatKey('host-1:42')).toBe(`${WORKER_HEARTBEAT_PREFIX}host-1:42`);
    expect(workerHeartbeatKey('a')).not.toBe(workerHeartbeatKey('b'));
  });

  it('believes a beat for more than one missed interval and fewer than four', () => {
    // One missed beat is a stall; three is absence. The TTL must sit between,
    // or a slow Redis reads as a dead worker (too short) or a dead worker reads
    // as alive for minutes (too long).
    const intervals = (WORKER_HEARTBEAT_TTL_SECONDS * 1000) / WORKER_HEARTBEAT_INTERVAL_MS;
    expect(intervals).toBeGreaterThan(1);
    expect(intervals).toBeLessThan(4);
  });

  it('round-trips what the worker writes', () => {
    expect(parseWorkerHeartbeat(JSON.stringify(beat))).toEqual(beat);
    expect(parseWorkerHeartbeat(beat)).toEqual(beat);
  });

  it('reads a worker older than the egress probe as not asked, rather than as no heartbeat', () => {
    const { egress: _dropped, ...older } = beat;
    expect(parseWorkerHeartbeat(older)).toEqual({ ...older, egress: null });
  });

  it('copies the queue list rather than aliasing the input', () => {
    const parsed = parseWorkerHeartbeat(beat);
    expect(parsed?.queues).not.toBe(beat.queues);
  });

  it.each([
    ['not json', 'nope'],
    ['a number', 7],
    ['null', null],
    ['no build', { ...beat, build: undefined }],
    ['an empty build', { ...beat, build: '' }],
    ['a non-string queue', { ...beat, queues: ['a', 3] }],
    ['queues that are not a list', { ...beat, queues: 'swap-accrual' }],
    ['an unreadable timestamp', { ...beat, at: 'yesterday' }],
    ['no start', { ...beat, startedAt: undefined }],
    ['an egress answer that is not a yes or no', { ...beat, egress: { ...beat.egress, ok: 'no' } }],
    ['an egress answer with no time', { ...beat, egress: { ...beat.egress, checkedAt: 'now' } }],
    ['an egress error that is not text', { ...beat, egress: { ...beat.egress, error: 42 } }],
  ])('treats %s as no heartbeat at all', (_label, raw) => {
    expect(parseWorkerHeartbeat(raw)).toBeNull();
  });
});
