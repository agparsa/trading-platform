import { describe, expect, it } from 'vitest';
import { readWindow } from '@tp/reports-core';
import { endOfDateIn, isDateOnly, resolveWindowInput, startOfDateIn } from './report-window';
import { zonedDayAndMinute } from '../market/session';

/**
 * A report window means trading days, in the trading server's timezone.
 *
 * `reports.md` reasons at length about *which timestamp* each kind is windowed
 * on and says nothing about *which timezone*; the panel had quietly chosen UTC.
 */
describe('a report window asked for as dates', () => {
  it('starts at local midnight and ends one millisecond before the next', () => {
    for (const zone of ['UTC', 'Asia/Tokyo', 'America/New_York', 'Europe/London']) {
      const start = startOfDateIn(zone, '2026-03-01');
      const end = endOfDateIn(zone, '2026-03-01');
      expect(zonedDayAndMinute(start, zone).minute, `${zone} start`).toBe(0);
      expect(zonedDayAndMinute(end + 1, zone).minute, `${zone} end`).toBe(0);
      expect(end - start).toBeGreaterThanOrEqual(23 * 3_600_000 - 1);
      expect(end - start).toBeLessThanOrEqual(25 * 3_600_000);
    }
  });

  /**
   * The defect, stated as the difference it makes. Nine hours of 1 March were
   * outside a report headed "March", and nine hours of April were inside it.
   */
  it('covers a different nine hours in Tokyo than the UTC window did', () => {
    const tokyo = startOfDateIn('Asia/Tokyo', '2026-03-01');
    const utcMidnight = Date.parse('2026-03-01T00:00:00.000Z');
    expect(utcMidnight - tokyo).toBe(9 * 3_600_000);

    const end = endOfDateIn('Asia/Tokyo', '2026-03-31');
    expect(end + 1).toBe(Date.parse('2026-03-31T15:00:00.000Z'));
  });

  /**
   * The month it is asked for is the month it covers, end to end, in that zone.
   */
  it('covers exactly the month asked for', () => {
    for (const zone of ['UTC', 'Asia/Tokyo', 'America/New_York']) {
      const start = startOfDateIn(zone, '2026-03-01');
      const end = endOfDateIn(zone, '2026-03-31');
      const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
      expect(formatter.format(new Date(start)), zone).toBe('2026-03-01');
      expect(formatter.format(new Date(end)), zone).toBe('2026-03-31');
      // And one millisecond later is April, so nothing is counted twice.
      expect(formatter.format(new Date(end + 1)), zone).toBe('2026-04-01');
    }
  });

  /**
   * A month containing a clock change is 743 or 745 hours, not 744. Right by
   * construction here, because it is `startOfTradingDay` doing the work.
   */
  it('handles a month with a daylight-saving change in it', () => {
    const start = startOfDateIn('Europe/London', '2026-10-01');
    const end = endOfDateIn('Europe/London', '2026-10-31');
    expect(zonedDayAndMinute(start, 'Europe/London').minute).toBe(0);
    expect(zonedDayAndMinute(end + 1, 'Europe/London').minute).toBe(0);
    // October 2026 gains an hour when the clocks go back.
    expect(end + 1 - start).toBe(745 * 3_600_000);

    const march = startOfDateIn('Europe/London', '2027-03-01');
    const marchEnd = endOfDateIn('Europe/London', '2027-03-31');
    expect(marchEnd + 1 - march).toBe(743 * 3_600_000);
  });

  it('leaves an instant alone, so an integration keeps the window it asked for', () => {
    const asked = resolveWindowInput('Asia/Tokyo', '2026-03-01T04:30:00.000Z', '2026-03-02T00:00:00+09:00');
    expect(asked.from).toBe('2026-03-01T04:30:00.000Z');
    expect(asked.to).toBe('2026-03-02T00:00:00+09:00');
  });

  it('recognises a date and nothing else as a date', () => {
    expect(isDateOnly('2026-03-01')).toBe(true);
    expect(isDateOnly('2026-03-01T00:00:00.000Z')).toBe(false);
    expect(isDateOnly('01/03/2026')).toBe(false);
    expect(isDateOnly(20260301)).toBe(false);
    expect(isDateOnly(undefined)).toBe(false);
  });

  it('produces a window the bounds check accepts', () => {
    const asked = resolveWindowInput('Asia/Tokyo', '2026-03-01', '2026-03-31');
    const parsed = readWindow(asked.from, asked.to, Date.parse('2026-04-02T00:00:00Z'));
    expect('window' in parsed).toBe(true);
  });
});

/**
 * The panel is the caller that got this wrong, so it is checked here rather
 * than left to a browser test that would only notice if the server were not in
 * UTC.
 */
describe('the reports panel', () => {
  it('sends the dates a person picked, not UTC midnights built from them', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(
      join(__dirname, '..', '..', '..', 'web', 'src', 'components', 'admin', 'reports-panel.tsx'),
      'utf8',
    );
    /**
     * Comments stripped first. The panel's comment explains the mistake by
     * quoting it, and the first version of this check failed on that — a guard
     * that reads prose as code, which is the same shape as an exemption list
     * that finds itself in the corpus it searches.
     */
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code, 'the panel is building a UTC day again').not.toMatch(/T00:00:00\.000Z/);
    expect(code, 'the panel is building a UTC day again').not.toMatch(/T23:59:59\.999Z/);
    // And it still sends something: a check that passes on an empty read is not one.
    expect(code).toMatch(/from,/);
  });
});
