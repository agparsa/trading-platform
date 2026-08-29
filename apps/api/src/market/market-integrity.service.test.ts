import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { TickRejection, type Tick } from '@tp/market-core';
import { MarketIntegrityService } from './market-integrity.service';
import { MetricsService } from '../metrics/metrics.service';

/**
 * The service around the gate.
 *
 * `TickGate` decides; this counts, logs and summarises. What is worth testing
 * here is the part the gate cannot do on its own: that a broken feed produces
 * one log line per run rather than four a second per instrument, and that the
 * health summary names the instruments in trouble rather than counting them.
 */

const NOW = 1_756_000_000_000;

const tick = (overrides: Partial<Tick> = {}): Tick => ({
  symbol: 'XAUUSD',
  bid: '4583.58',
  ask: '4583.72',
  timestamp: NOW,
  volume: '1',
  ...overrides,
});

function build(overrides: Record<string, unknown> = {}) {
  const config = new ConfigService<Record<string, unknown>, true>({
    MARKET_MAX_SPREAD_RATIO: 0.05,
    MARKET_MAX_JUMP_RATIO: 0.1,
    MARKET_MAX_FUTURE_SKEW_MS: 5_000,
    MARKET_REANCHOR_AFTER: 5,
    ...overrides,
  } as never);
  return new MarketIntegrityService(config as never, new MetricsService());
}

describe('MarketIntegrityService', () => {
  let integrity: MarketIntegrityService;

  beforeEach(() => {
    integrity = build();
  });

  it('lets an ordinary tick through and remembers it', () => {
    expect(integrity.admit(tick(), NOW).accepted).toBe(true);
    expect(integrity.lastAccepted('XAUUSD')?.bid).toBe('4583.58');
  });

  it('refuses a crossed book and leaves the previous price standing', () => {
    integrity.admit(tick(), NOW);
    const verdict = integrity.admit(
      tick({ bid: '4600.00', ask: '4500.00', timestamp: NOW + 250 }),
      NOW + 250,
    );

    expect(verdict.accepted).toBe(false);
    expect(verdict.reason).toBe(TickRejection.CROSSED);
    expect(integrity.lastAccepted('XAUUSD')?.bid).toBe('4583.58');
  });

  it('counts every rejection, not only the ones it logged', () => {
    integrity.admit(tick(), NOW);
    for (let i = 1; i <= 4; i += 1) {
      integrity.admit(tick({ bid: '4600.00', ask: '4500.00', timestamp: NOW + i }), NOW + i);
    }
    expect(integrity.summary().rejectedTotal).toBe(4);
  });

  /**
   * "Three symbols are being refused" and "XAUUSD is being refused" prompt
   * different questions, and only one of them can be acted on.
   */
  it('names the instruments currently in a rejection run', () => {
    integrity.admit(tick(), NOW);
    integrity.admit(tick({ symbol: 'EURUSD', bid: '1.08750', ask: '1.08755' }), NOW);

    integrity.admit(tick({ bid: '4600.00', ask: '4500.00', timestamp: NOW + 1 }), NOW + 1);

    expect(integrity.summary().symbolsInRejectionRun).toEqual(['XAUUSD']);
    expect(integrity.summary().symbols).toBe(2);
  });

  it('clears the run once the feed recovers', () => {
    integrity.admit(tick(), NOW);
    integrity.admit(tick({ bid: '4600.00', ask: '4500.00', timestamp: NOW + 1 }), NOW + 1);
    expect(integrity.summary().symbolsInRejectionRun).toEqual(['XAUUSD']);

    integrity.admit(tick({ bid: '4583.60', ask: '4583.74', timestamp: NOW + 2 }), NOW + 2);
    expect(integrity.summary().symbolsInRejectionRun).toEqual([]);
  });

  it('re-anchors on a sustained gap rather than refusing the market forever', () => {
    const gate = build({ MARKET_REANCHOR_AFTER: 2 });
    gate.admit(tick(), NOW);

    expect(
      gate.admit(tick({ bid: '9000.00', ask: '9000.20', timestamp: NOW + 1 }), NOW + 1).accepted,
    ).toBe(false);
    const second = gate.admit(
      tick({ bid: '9000.00', ask: '9000.20', timestamp: NOW + 2 }),
      NOW + 2,
    );
    expect(second.accepted).toBe(true);
    expect(second.reanchored).toBe(true);
    expect(gate.lastAccepted('XAUUSD')?.bid).toBe('9000.00');
  });

  it('reads its thresholds from configuration', () => {
    const permissive = build({ MARKET_MAX_JUMP_RATIO: null, MARKET_MAX_SPREAD_RATIO: null });
    permissive.admit(tick(), NOW);
    expect(
      permissive.admit(tick({ bid: '9000.00', ask: '9500.00', timestamp: NOW + 1 }), NOW + 1)
        .accepted,
    ).toBe(true);
  });
});
