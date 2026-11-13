import { describe, expect, it } from 'vitest';
import {
  LevelKind,
  draftLevel,
  editChanges,
  editErrors,
  editFrom,
  halfVolume,
  riskReward,
  stackChips,
} from './chart-levels';
import type { PositionRow, SymbolRow } from './queries';

const GOLD = {
  code: 'XAUUSD',
  contractSize: '100',
  tickSize: '0.01',
  pricePrecision: 2,
  quoteCurrency: 'USD',
  volumeStep: '0.01',
  minVolume: '0.01',
} as unknown as SymbolRow;

const BUY = {
  id: 'p1',
  symbol: 'XAUUSD',
  side: 'BUY',
  status: 'OPEN',
  volume: '0.10',
  entryPrice: '4000.00',
  currentPrice: '4010.00',
  stopLoss: null,
  takeProfit: '4040.00',
} as unknown as PositionRow;

describe('a draft stop or target', () => {
  it('starts half a percent from the price, on the side it must sit, on the tick grid', () => {
    expect(draftLevel(GOLD, BUY, LevelKind.STOP_LOSS, '4010.00')?.price).toBe('3989.95');
    expect(draftLevel(GOLD, BUY, LevelKind.TAKE_PROFIT, '4010.00')?.price).toBe('4030.05');
    const sell = { ...BUY, side: 'SELL' } as PositionRow;
    expect(draftLevel(GOLD, sell, LevelKind.STOP_LOSS, '4010.00')?.price).toBe('4030.05');
  });

  it('is draggable, named as a draft, and absent without a price', () => {
    const draft = draftLevel(GOLD, BUY, LevelKind.STOP_LOSS, '4010.00');
    expect(draft).toMatchObject({ draggable: true, positionId: 'p1', title: 'SL? 3989.95' });
    expect(
      draftLevel(GOLD, { ...BUY, currentPrice: null } as PositionRow, LevelKind.STOP_LOSS, null),
    ).toBeNull();
  });
});

describe('risk and reward while a level moves', () => {
  it('pairs the proposed stop with the target as it stands', () => {
    // 0.10 lots × 100: a 10.00 stop risks 100.00, a 40.00 target makes 400.00.
    expect(riskReward(BUY, GOLD, LevelKind.STOP_LOSS, '3990.00', 'USD')).toEqual({
      risk: '100.00',
      reward: '400.00',
      ratio: '4.00',
    });
  });

  it('has no ratio without both levels, or with a stop that risks nothing', () => {
    const bare = { ...BUY, takeProfit: null } as PositionRow;
    expect(riskReward(bare, GOLD, LevelKind.STOP_LOSS, '3990.00', 'USD')).toBeNull();
    expect(riskReward(BUY, GOLD, LevelKind.STOP_LOSS, '4005.00', 'USD')).toBeNull();
  });
});

describe('closing half of a position', () => {
  it('halves on the lot grid, rounding down', () => {
    expect(halfVolume(GOLD, { ...BUY, volume: '0.05' })).toBe('0.02');
    expect(halfVolume(GOLD, { ...BUY, volume: '1.00' })).toBe('0.50');
  });
  it('offers nothing when a half would be under the minimum', () => {
    expect(halfVolume(GOLD, { ...BUY, volume: '0.01' })).toBeNull();
  });
});

describe('chips that would overlap', () => {
  it('pushes each one clear of the one above, in price order', () => {
    expect(stackChips({ a: 100, b: 102, c: 300, d: null }, 24)).toEqual({
      a: 100,
      b: 124,
      c: 300,
      d: null,
    });
  });
  it('leaves chips already apart where they are', () => {
    expect(stackChips({ a: 10, b: 50 }, 24)).toEqual({ a: 10, b: 50 });
  });
});

describe('editing a position’s stop and target', () => {
  it('starts from the position’s own levels', () => {
    expect(editFrom(BUY)).toEqual({ stopLoss: '', takeProfit: '4040.00' });
    expect(editFrom({ ...BUY, stopLoss: '3990.5' }, 2).stopLoss).toBe('3990.50');
  });

  it('sends only what changed, null for a cleared level', () => {
    expect(editChanges(BUY, { stopLoss: '', takeProfit: '4040.0' })).toEqual({});
    expect(editChanges(BUY, { stopLoss: '3990.00', takeProfit: '4040.00' })).toEqual({
      stopLoss: '3990.00',
    });
    expect(editChanges(BUY, { stopLoss: '', takeProfit: '' })).toEqual({ takeProfit: null });
  });

  it('refuses what the server would: not a price, off the grid, the wrong side', () => {
    const at = (edit: { stopLoss: string; takeProfit: string }) =>
      editErrors(GOLD, BUY, edit, '4010.00');
    expect(at({ stopLoss: 'abc', takeProfit: '' }).stopLoss).toBe('Not a price.');
    expect(at({ stopLoss: '3990.005', takeProfit: '' }).stopLoss).toMatch(/multiple of 0.01/);
    expect(at({ stopLoss: '4020.00', takeProfit: '' }).stopLoss).not.toBeNull();
    expect(at({ stopLoss: '', takeProfit: '4000.00' }).takeProfit).not.toBeNull();
    expect(at({ stopLoss: '3990.00', takeProfit: '4040.00' })).toEqual({
      stopLoss: null,
      takeProfit: null,
    });
  });
});
