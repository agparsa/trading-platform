import { describe, expect, it } from 'vitest';
import { ScriptedMarketDataProvider } from './scripted';
import { Resolution } from '../types';
import { T0, tick, XAUUSD_INSTRUMENT } from '../__fixtures__/market';

/** The exact sequence from docs/testing.md, "Deterministic market script". */
const SCRIPT = [
  tick(0, '4500.00', '4500.20'),
  tick(1000, '4501.00', '4501.20'),
  tick(2000, '4502.00', '4502.20'),
];

const build = () => new ScriptedMarketDataProvider([XAUUSD_INSTRUMENT], SCRIPT);

describe('ScriptedMarketDataProvider', () => {
  it('refuses to step before start()', () => {
    expect(() => build().step()).toThrow(/before start/);
  });

  it('plays the script in order and then stops', async () => {
    const p = build();
    await p.start();
    expect(p.step()?.bid).toBe('4500.00');
    expect(p.step()?.bid).toBe('4501.00');
    expect(p.step()?.bid).toBe('4502.00');
    expect(p.step()).toBeNull();
  });

  it('produces byte-identical output on replay', async () => {
    const p = build();
    await p.start();
    const first: string[] = [];
    const offFirst = p.subscribe('XAUUSD', (t) => first.push(`${t.bid}/${t.ask}@${t.timestamp}`));
    p.drain();
    offFirst();

    p.reset();
    const second: string[] = [];
    p.subscribe('XAUUSD', (t) => second.push(`${t.bid}/${t.ask}@${t.timestamp}`));
    p.drain();

    expect(first).toHaveLength(3);
    expect(second).toEqual(first);
  });

  it('serves candles built from the ticks it emitted', async () => {
    const p = build();
    await p.start();
    p.drain();
    const candles = await p.getCandles('XAUUSD', Resolution.M1, T0, T0 + 60_000);
    expect(candles).toHaveLength(1);
    expect(candles[0]?.open).toBe('4500');
    expect(candles[0]?.close).toBe('4502');
  });

  it('stops delivering after unsubscribe', async () => {
    const p = build();
    await p.start();
    const seen: string[] = [];
    const off = p.subscribe('XAUUSD', (t) => seen.push(t.bid));
    p.step();
    off();
    p.drain();
    expect(seen).toEqual(['4500.00']);
  });
});
