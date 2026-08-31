import { describe, expect, it } from 'vitest';
import { NotificationCategory, SOUND_FOR_CATEGORY } from '@tp/shared-types';
import { SOUND_ASSETS, clampVolume, decideSound, type SoundPreferences } from './sound-decision';

const on: SoundPreferences = { soundEnabled: true, soundVolume: 80, perCategory: {} };

const play = (category: NotificationCategory, overrides = {}) =>
  decideSound(
    { category, appActive: true, serverSaysPlay: true, ...overrides },
    { ...on, ...('preferences' in overrides ? {} : {}) },
  );

describe('deciding whether to make a noise', () => {
  it('plays the opening sound for an opened trade', () => {
    expect(play(NotificationCategory.TRADE_OPENED).sound).toBe('trade_opened');
  });

  it('plays a different sound for a modification', () => {
    // §18 asks for this specifically, and it is the one difference a user
    // notices immediately if it is wrong.
    expect(play(NotificationCategory.TRADE_MODIFIED).sound).not.toBe(
      play(NotificationCategory.TRADE_OPENED).sound,
    );
    expect(play(NotificationCategory.TRADE_MODIFIED).sound).toBe('trade_modified');
  });

  it('gives every trading category its own sound', () => {
    const sounds = [
      NotificationCategory.TRADE_OPENED,
      NotificationCategory.TRADE_CLOSED,
      NotificationCategory.TRADE_MODIFIED,
      NotificationCategory.ORDER_FILLED,
      NotificationCategory.ORDER_CANCELLED,
      NotificationCategory.STOP_LOSS,
      NotificationCategory.TAKE_PROFIT,
    ].map((category) => play(category).sound);

    // §19: "Each sound must be clearly distinguishable." The weaker property a
    // test can check is that they are at least distinct.
    expect(new Set(sounds).size).toBe(sounds.length);
  });

  it('stays silent while the app is in the background', () => {
    /**
     * The double-sound bug, prevented.
     *
     * When the app is backgrounded the OS plays the sound from the push
     * payload. An app that also played one on waking would make a trader with
     * the app behind their browser hear every fill twice — and it looks exactly
     * like a duplicate-event failure when it is not one.
     */
    const decision = decideSound(
      { category: NotificationCategory.TRADE_OPENED, appActive: false, serverSaysPlay: true },
      on,
    );
    expect(decision.sound).toBeNull();
    expect(decision.reason).toBe('app-in-background');
  });

  it('respects the master switch', () => {
    const decision = decideSound(
      { category: NotificationCategory.TRADE_OPENED, appActive: true, serverSaysPlay: true },
      { ...on, soundEnabled: false },
    );
    expect(decision.sound).toBeNull();
  });

  it('respects what the server said about this notification', () => {
    // The server has already applied quiet hours and per-category preferences;
    // the client must not second-guess it into playing something.
    const decision = decideSound(
      { category: NotificationCategory.TRADE_OPENED, appActive: true, serverSaysPlay: false },
      on,
    );
    expect(decision.sound).toBeNull();
  });

  it('respects a locally muted category', () => {
    const decision = decideSound(
      { category: NotificationCategory.STOP_LOSS, appActive: true, serverSaysPlay: true },
      { ...on, perCategory: { [NotificationCategory.STOP_LOSS]: false } },
    );
    expect(decision.reason).toBe('category-muted');
  });

  it('stays silent for a system notice', () => {
    const decision = play(NotificationCategory.SYSTEM);
    expect(decision.sound).toBeNull();
    expect(decision.reason).toBe('no-sound-for-category');
  });

  it('warns on risk and security alike', () => {
    expect(play(NotificationCategory.RISK_ALERT).sound).toBe('risk_warning');
    expect(play(NotificationCategory.SECURITY_ALERT).sound).toBe('risk_warning');
  });

  it('has a bundled asset for every sound the contract can produce', () => {
    // A category whose sound has no file plays nothing, silently. This is the
    // check that catches a sound added to the shared contract and not to the
    // app.
    for (const sound of Object.values(SOUND_FOR_CATEGORY)) {
      if (sound === null) continue;
      expect(SOUND_ASSETS[sound], sound).toBeDefined();
    }
  });
});

describe('volume', () => {
  it("scales the stored 0–100 to the player's 0–1", () => {
    expect(clampVolume(80)).toBeCloseTo(0.8);
    expect(clampVolume(0)).toBe(0);
    expect(clampVolume(100)).toBe(1);
  });

  it('refuses to blow an eardrum on a corrupt value', () => {
    expect(clampVolume(400)).toBe(1);
    expect(clampVolume(-20)).toBe(0);
    expect(clampVolume(Number.NaN)).toBeCloseTo(0.8);
  });
});
