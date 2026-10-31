import { describe, expect, it } from 'vitest';
import { NOTIFICATION_CATEGORIES } from '@tp/shared-types';
import {
  DEFAULT_SETTINGS,
  defaultPreference,
  describePreferences,
  resolveDelivery,
} from './preferences';

describe('email by default', () => {
  it('is on for risk alerts and off for everything else', () => {
    const emailed = NOTIFICATION_CATEGORIES.filter((category) => defaultPreference(category).email);
    expect(emailed).toEqual(['RISK_ALERT']);
  });

  it('is what the settings screen shows and what delivery does, for someone who set nothing', () => {
    const shown = describePreferences(DEFAULT_SETTINGS, []).categories;
    for (const category of NOTIFICATION_CATEGORIES) {
      expect(shown.find((row) => row.category === category)?.email, category).toBe(
        resolveDelivery(DEFAULT_SETTINGS, undefined, category).email,
      );
    }
  });
});
