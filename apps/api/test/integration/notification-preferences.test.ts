import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { NotificationCategory } from '@tp/shared-types';
import { PreferencesService } from '../../src/notifications/preferences.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { DEFAULT_TENANT_ID, createTestClient, hasTestDatabase, resetDatabase } from './harness';

const suite = hasTestDatabase ? describe : describe.skip;

suite('Notification preferences (integration)', () => {
  let prisma: PrismaClient;
  let preferences: PreferencesService;
  let userId: string;

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
    preferences = new PreferencesService(prisma as unknown as PrismaService);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    const user = await prisma.user.create({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        email: 'trader@test.local',
        passwordHash: 'not-a-real-hash',
        displayName: 'Trader',
      },
    });
    userId = user.id;
  });

  it('delivers everything to someone who has never opened the settings screen', async () => {
    const settings = await preferences.get(userId);
    expect(settings.categories.every((category) => category.inApp)).toBe(true);
    expect(settings.pushEnabled).toBe(true);

    const resolved = await preferences.resolve(userId, NotificationCategory.TRADE_OPENED);
    expect(resolved).toEqual({ inApp: true, push: true, email: false, sound: true });
  });

  it('honours a category the user turned off', async () => {
    await preferences.updateCategory(userId, NotificationCategory.TRADE_OPENED, {
      push: false,
      sound: false,
    });

    const resolved = await preferences.resolve(userId, NotificationCategory.TRADE_OPENED);
    expect(resolved.push).toBe(false);
    expect(resolved.sound).toBe(false);
    // Still written down, so the notification centre has it when they look.
    expect(resolved.inApp).toBe(true);
  });

  it('leaves other categories alone', async () => {
    await preferences.updateCategory(userId, NotificationCategory.TRADE_OPENED, { push: false });
    const resolved = await preferences.resolve(userId, NotificationCategory.TRADE_CLOSED);
    expect(resolved.push).toBe(true);
  });

  it('refuses to turn off a security notification', async () => {
    await expect(
      preferences.updateCategory(userId, NotificationCategory.SECURITY_ALERT, { push: false }),
    ).rejects.toThrow(/cannot be turned off/);
  });

  it('refuses to turn off a risk notification', async () => {
    await expect(
      preferences.updateCategory(userId, NotificationCategory.RISK_ALERT, { inApp: false }),
    ).rejects.toThrow(/cannot be turned off/);
  });

  it('delivers a risk alert even when everything else is off', async () => {
    await preferences.updateSettings(userId, { tradingEnabled: false, pushEnabled: false });

    const trade = await preferences.resolve(userId, NotificationCategory.TRADE_OPENED);
    expect(trade.inApp).toBe(false);
    expect(trade.push).toBe(false);

    // The master switch does not reach a margin call, and the settings screen
    // says so rather than showing an off switch that lies.
    const risk = await preferences.resolve(userId, NotificationCategory.RISK_ALERT);
    expect(risk.inApp).toBe(true);
    expect(risk.push).toBe(true);

    const shown = await preferences.get(userId);
    const riskRow = shown.categories.find(
      (entry) => entry.category === NotificationCategory.RISK_ALERT,
    );
    expect(riskRow?.unmutable).toBe(true);
    expect(riskRow?.push).toBe(true);
  });

  it('lets the master push switch override a category that is on', async () => {
    await preferences.updateSettings(userId, { pushEnabled: false });
    const resolved = await preferences.resolve(userId, NotificationCategory.TRADE_OPENED);
    expect(resolved.push).toBe(false);
    // And the per-category setting is not destroyed by it: turning push back on
    // must restore what the user chose, not reset it.
    await preferences.updateSettings(userId, { pushEnabled: true });
    expect((await preferences.resolve(userId, NotificationCategory.TRADE_OPENED)).push).toBe(true);
  });

  it('withholds push during quiet hours but still writes the notice', async () => {
    await preferences.updateSettings(userId, {
      quietHoursStartMinute: 22 * 60,
      quietHoursEndMinute: 7 * 60,
      quietHoursTimezone: 'Asia/Tehran',
    });

    const threeThirtyAmLocal = new Date(Date.UTC(2026, 7, 31, 0, 0));
    const resolved = await preferences.resolve(
      userId,
      NotificationCategory.TRADE_CLOSED,
      threeThirtyAmLocal,
    );
    expect(resolved.push).toBe(false);
    expect(resolved.inApp).toBe(true);
  });

  it('wakes the phone for a margin call during quiet hours', async () => {
    await preferences.updateSettings(userId, {
      quietHoursStartMinute: 22 * 60,
      quietHoursEndMinute: 7 * 60,
      quietHoursTimezone: 'Asia/Tehran',
    });

    const threeThirtyAmLocal = new Date(Date.UTC(2026, 7, 31, 0, 0));
    const resolved = await preferences.resolve(
      userId,
      NotificationCategory.RISK_ALERT,
      threeThirtyAmLocal,
    );
    // The notification a person sets quiet hours to avoid is exactly the one
    // they need at 3am.
    expect(resolved.push).toBe(true);
  });

  it('refuses quiet hours with no timezone', async () => {
    await expect(
      preferences.updateSettings(userId, { quietHoursStartMinute: 22 * 60 }),
    ).rejects.toThrow(/timezone/i);
  });
});
