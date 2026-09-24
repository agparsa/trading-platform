import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ANDROID_CHANNEL_FOR_CATEGORY,
  ANDROID_QUIET_CHANNEL,
  NOTIFICATION_CATEGORIES,
  NotificationCategory,
  SOUND_FOR_CATEGORY,
  TradingSound,
  androidChannelFor,
  androidChannels,
} from '@tp/shared-types';
import { androidSound, appleSound } from '@tp/push-core';

/**
 * Every sound the server can name is one the phone can play, from every place
 * a phone plays one.
 *
 * `price_alert` was added to `TradingSound`, generated as a file, and given to
 * the in-app player — and not listed in `app.json`, which is what copies a
 * sound into the places the operating system plays notifications from, nor in
 * the build script's check that it had. A price alert arriving with the app in
 * the background named a sound the build did not contain. That the check
 * passed is the part worth a test: it listed eight names by hand.
 *
 * And every push goes to the channel whose sound it should make. On Android 8
 * and later the channel *is* the sound; the worker named one channel for
 * every notice, and every notice sounded like an opened trade.
 */
const APP = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SOUNDS = Object.values(TradingSound).sort();

describe('the sounds the phone carries', () => {
  it('has a file for every sound, and no file for a sound that does not exist', () => {
    const files = readdirSync(resolve(APP, 'assets/sounds'))
      .filter((name) => name.endsWith('.wav'))
      .map((name) => name.replace(/\.wav$/, ''))
      .sort();
    expect(files).toEqual(SOUNDS);
  });

  it('bundles every one for the operating system to play (app.json)', () => {
    const app = JSON.parse(readFileSync(resolve(APP, 'app.json'), 'utf8')) as {
      expo: { plugins: unknown[] };
    };
    const plugin = app.expo.plugins.find(
      (entry): entry is [string, { sounds: string[] }] =>
        Array.isArray(entry) && entry[0] === 'expo-notifications',
    );
    const bundled = (plugin?.[1].sounds ?? [])
      .map((path) => path.replace(/^.*\/(.+)\.wav$/, '$1'))
      .sort();
    expect(bundled).toEqual(SOUNDS);
  });

  it('is named by the push in the form each platform finds it under', () => {
    // iOS looks for a file by its full name and plays the default when there
    // is none; Android looks for a resource name, which has no extension.
    const app = JSON.parse(readFileSync(resolve(APP, 'app.json'), 'utf8')) as {
      expo: { plugins: unknown[] };
    };
    const plugin = app.expo.plugins.find(
      (entry): entry is [string, { sounds: string[] }] =>
        Array.isArray(entry) && entry[0] === 'expo-notifications',
    );
    const files = new Set((plugin?.[1].sounds ?? []).map((path) => path.replace(/^.*\//, '')));
    for (const sound of Object.values(TradingSound)) {
      expect(files.has(appleSound(sound)), `iOS: ${appleSound(sound)}`).toBe(true);
      expect(files.has(`${androidSound(sound)}.wav`), `Android: ${androidSound(sound)}`).toBe(true);
    }
  });

  it('checks every one in the Android build', () => {
    const script = readFileSync(resolve(APP, 'scripts/build-android.sh'), 'utf8');
    const loop = /^for name in (.+); do$/m.exec(script)?.[1] ?? '';
    expect(loop.split(' ').sort()).toEqual(SOUNDS);
  });

  it('generates every one (scripts/generate-sounds.py)', () => {
    const script = readFileSync(resolve(APP, 'scripts/generate-sounds.py'), 'utf8');
    const body = script.slice(
      script.indexOf('SOUNDS = {'),
      script.indexOf('\n}', script.indexOf('SOUNDS = {')),
    );
    const names = [...body.matchAll(/^\s+"([a-z_]+)":/gm)].map((m) => m[1]!).sort();
    expect(names).toEqual(SOUNDS);
  });
});

describe('the Android channels', () => {
  const channels = androidChannels();

  it('are one per category and one quiet one, each id once', () => {
    const ids = channels.map((channel) => channel.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(ANDROID_QUIET_CHANNEL);
    expect(ids.length).toBe(NOTIFICATION_CATEGORIES.length + 1);
  });

  it("carry their category's sound, and the quiet one none", () => {
    for (const category of NOTIFICATION_CATEGORIES) {
      const channel = channels.find((c) => c.id === ANDROID_CHANNEL_FOR_CATEGORY[category]);
      expect(channel?.sound, category).toBe(SOUND_FOR_CATEGORY[category]);
    }
    expect(channels.find((c) => c.id === ANDROID_QUIET_CHANNEL)?.sound).toBeNull();
  });

  it('give a stop loss a different channel from an opening, which was the whole defect', () => {
    expect(androidChannelFor(NotificationCategory.STOP_LOSS, true)).not.toBe(
      androidChannelFor(NotificationCategory.TRADE_OPENED, true),
    );
  });

  it('send a muted category to the quiet channel, since the message cannot silence it', () => {
    const channel = androidChannelFor(NotificationCategory.TRADE_OPENED, false);
    expect(channels.find((c) => c.id === channel)?.sound).toBeNull();
  });

  it('name only channels the phone creates', () => {
    const ids = new Set(channels.map((c) => c.id));
    for (const category of NOTIFICATION_CATEGORIES) {
      for (const playSound of [true, false]) {
        expect(
          ids.has(androidChannelFor(category, playSound)),
          `${category} ${String(playSound)}`,
        ).toBe(true);
      }
    }
  });

  it('keep the ids phones already have: a channel cannot change its sound once created', () => {
    // These existed before the table did, with these sounds. Renaming one
    // would strand the old channel on every installed phone.
    expect(ANDROID_CHANNEL_FOR_CATEGORY.TRADE_OPENED).toBe('trading');
    expect(ANDROID_CHANNEL_FOR_CATEGORY.TRADE_CLOSED).toBe('trading-closed');
    expect(ANDROID_CHANNEL_FOR_CATEGORY.TRADE_MODIFIED).toBe('trading-modified');
    expect(ANDROID_CHANNEL_FOR_CATEGORY.STOP_LOSS).toBe('trading-stop-loss');
    expect(ANDROID_CHANNEL_FOR_CATEGORY.TAKE_PROFIT).toBe('trading-take-profit');
    expect(ANDROID_CHANNEL_FOR_CATEGORY.RISK_ALERT).toBe('risk');
    expect(ANDROID_CHANNEL_FOR_CATEGORY.SECURITY_ALERT).toBe('security');
    expect(ANDROID_CHANNEL_FOR_CATEGORY.SYSTEM).toBe('system');
  });
});
