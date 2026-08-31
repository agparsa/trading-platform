import { describe, expect, it } from 'vitest';
import { inQuietHours } from './preferences';

/**
 * Quiet hours, which are almost always the range that wraps midnight.
 *
 * Treating 22:00–07:00 as `start > end` and therefore empty is the bug this
 * suite exists to catch: it would make the feature do nothing for nearly
 * everybody who turns it on, silently, and the only symptom would be a phone
 * that keeps buzzing at night.
 */
describe('quiet hours', () => {
  const tehran = (start: number | null, end: number | null) => ({
    quietHoursStartMinute: start,
    quietHoursEndMinute: end,
    quietHoursTimezone: 'Asia/Tehran' as string | null,
  });

  /** 2026-08-31, at the given UTC hour and minute. */
  const utc = (hour: number, minute = 0) => new Date(Date.UTC(2026, 7, 31, hour, minute));

  it('is off when nothing is set', () => {
    expect(inQuietHours(tehran(null, null), utc(2))).toBe(false);
  });

  it('covers a range that wraps midnight', () => {
    // 22:00–07:00 Tehran. Tehran is UTC+03:30 on this date.
    const settings = tehran(22 * 60, 7 * 60);
    expect(inQuietHours(settings, utc(20, 0))).toBe(true); // 23:30 local
    expect(inQuietHours(settings, utc(0, 0))).toBe(true); // 03:30 local
    expect(inQuietHours(settings, utc(4, 0))).toBe(false); // 07:30 local
    expect(inQuietHours(settings, utc(12, 0))).toBe(false); // 15:30 local
  });

  it('covers a range inside one day', () => {
    // 13:00–15:00 local.
    const settings = tehran(13 * 60, 15 * 60);
    expect(inQuietHours(settings, utc(10, 0))).toBe(true); // 13:30
    expect(inQuietHours(settings, utc(12, 0))).toBe(false); // 15:30
  });

  it('excludes the end minute and includes the start', () => {
    const settings = tehran(13 * 60, 15 * 60);
    expect(inQuietHours(settings, utc(9, 30))).toBe(true); // exactly 13:00
    expect(inQuietHours(settings, utc(11, 30))).toBe(false); // exactly 15:00
  });

  it("reads the range in the user's zone, not the server's", () => {
    const settings = tehran(22 * 60, 7 * 60);
    // 23:00 UTC is 02:30 in Tehran — quiet there, and a server reading its own
    // clock as UTC would agree by accident. 19:00 UTC is 22:30 in Tehran, which
    // is quiet, and 19:00 UTC is *not* inside 22:00–07:00 read as UTC. That is
    // the case that separates the two readings.
    expect(inQuietHours(settings, utc(19, 0))).toBe(true);
  });

  it('treats an empty range as off rather than as all day', () => {
    expect(inQuietHours(tehran(60, 60), utc(0))).toBe(false);
  });

  it('treats an unknown timezone as unset rather than throwing', () => {
    const settings = {
      quietHoursStartMinute: 22 * 60,
      quietHoursEndMinute: 7 * 60,
      quietHoursTimezone: 'Mars/Olympus_Mons',
    };
    expect(inQuietHours(settings, utc(2))).toBe(false);
  });
});
