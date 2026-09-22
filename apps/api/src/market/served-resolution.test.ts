import { describe, expect, it } from 'vitest';
import { RESOLUTIONS, Resolution } from '@tp/market-core';
import { isDomainError } from '@tp/shared-types';
import { servedResolution } from './market.controller';

/**
 * `GET /market/candles` used to accept any resolution the platform *knew* and
 * answer with an empty chart for one this deployment did not *serve* — `30`
 * was aggregatable, accepted, and persisted nowhere by default. An empty chart
 * reads as a frozen feed. Now the request is refused, and the refusal says
 * which resolutions would have been accepted.
 */
describe('servedResolution', () => {
  const served = [Resolution.M1, Resolution.H1] as const;

  it('returns a resolution that is known and served', () => {
    expect(servedResolution('60', served)).toBe('60');
  });

  it('refuses one the platform has never heard of, naming the vocabulary', () => {
    try {
      servedResolution('7', served);
      expect.unreachable();
    } catch (error) {
      expect(isDomainError(error)).toBe(true);
      expect(String((error as Error).message)).toContain("Unsupported resolution '7'");
      expect((error as { details?: Record<string, unknown> }).details?.['known']).toEqual([
        ...RESOLUTIONS,
      ]);
    }
  });

  it('refuses one the platform knows but this deployment does not aggregate, naming what it does', () => {
    try {
      servedResolution('30', served);
      expect.unreachable();
    } catch (error) {
      expect(isDomainError(error)).toBe(true);
      expect(String((error as Error).message)).toContain('not aggregated on this deployment');
      expect((error as { details?: Record<string, unknown> }).details?.['served']).toEqual([
        '1',
        '60',
      ]);
    }
  });
});
