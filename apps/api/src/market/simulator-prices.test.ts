import { describe, expect, it } from 'vitest';
import { parseSimulatorPrices } from './market-feed.service';

/**
 * The prices written into the source were plausible on the day they were
 * written. A demonstration market quoting gold two hundred dollars from
 * anywhere real demonstrates nothing, and correcting it should not need a
 * rebuild.
 */
describe('parseSimulatorPrices', () => {
  it('reads the pairs', () => {
    expect(parseSimulatorPrices('XAUUSD:3350,BTCUSD:95000')).toEqual({
      XAUUSD: '3350',
      BTCUSD: '95000',
    });
  });

  it('means "change nothing" by an empty value', () => {
    expect(parseSimulatorPrices('')).toEqual({});
    expect(parseSimulatorPrices('   ')).toEqual({});
  });

  it('tolerates spacing and lower case, because a human types this', () => {
    expect(parseSimulatorPrices(' xauusd:3350 , ethusd:3100 ')).toEqual({
      XAUUSD: '3350',
      ETHUSD: '3100',
    });
  });

  /**
   * Keeps the decimals as written. Going through a JS number would round
   * 1.08755 on its way to a price the whole platform then trades against.
   */
  it('carries the price through as text', () => {
    expect(parseSimulatorPrices('EURUSD:1.08755')['EURUSD']).toBe('1.08755');
  });

  it('ignores a symbol the platform does not have, rather than refusing to start', () => {
    // Which instruments exist is a database question; this is configuration.
    expect(parseSimulatorPrices('NOTREAL:5')).toEqual({ NOTREAL: '5' });
  });
});
