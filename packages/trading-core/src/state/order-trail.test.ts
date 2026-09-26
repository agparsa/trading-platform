import { describe, expect, it } from 'vitest';
import { orderTrail } from './order-trail';

const at = new Date('2026-09-01T14:34:09.649Z');
const later = new Date('2026-09-01T14:40:00.000Z');
const row = (seq: number, fromStatus: string | null, toStatus: string, createdAt = at) => ({
  seq: BigInt(seq),
  createdAt,
  fromStatus,
  toStatus,
});
const statuses = (rows: ReturnType<typeof row>[]) => rows.map((r) => r.toStatus);

describe('an order trail', () => {
  it('puts a legacy trail numbered out of order back in order (as found in production)', () => {
    const rows = [
      row(25, 'ACCEPTED', 'FILLED'),
      row(213, null, 'NEW'),
      row(214, 'NEW', 'ACCEPTED'),
    ];
    expect(statuses(orderTrail(rows))).toEqual(['NEW', 'ACCEPTED', 'FILLED']);
  });

  it('keeps transactions in time order, and each one in chain order', () => {
    const rows = [
      row(40, 'PENDING', 'CANCEL_REQUESTED', later),
      row(41, 'CANCEL_REQUESTED', 'CANCELLED', later),
      row(33, 'NEW', 'PENDING'),
      row(32, null, 'NEW'),
    ];
    expect(statuses(orderTrail(rows))).toEqual(['NEW', 'PENDING', 'CANCEL_REQUESTED', 'CANCELLED']);
  });

  it('keeps seq order for a group that is not one chain: a modify leads back to where it began', () => {
    const rows = [row(8, 'MODIFY_REQUESTED', 'PENDING'), row(7, 'PENDING', 'MODIFY_REQUESTED')];
    expect(statuses(orderTrail(rows))).toEqual(['MODIFY_REQUESTED', 'PENDING']);
  });

  it('keeps seq order when a status repeats and the chain could go two ways', () => {
    const rows = [
      row(3, 'PARTIALLY_FILLED', 'FILLED'),
      row(2, 'PARTIALLY_FILLED', 'PARTIALLY_FILLED'),
      row(1, 'ACCEPTED', 'PARTIALLY_FILLED'),
    ];
    expect(statuses(orderTrail(rows))).toEqual(['PARTIALLY_FILLED', 'PARTIALLY_FILLED', 'FILLED']);
    expect(orderTrail(rows).map((r) => Number(r.seq))).toEqual([1, 2, 3]);
  });

  it('changes nothing about a trail that was already in order', () => {
    const rows = [row(1, null, 'NEW'), row(2, 'NEW', 'ACCEPTED'), row(3, 'ACCEPTED', 'FILLED')];
    expect(orderTrail(rows)).toEqual(rows);
  });
});
