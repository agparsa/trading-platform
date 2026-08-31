import { describe, expect, it } from 'vitest';
import { NotificationCategory, type TradingSound } from '@tp/shared-types';
import { TradingEventHandler, type IncomingTradingEvent } from './trading-events';
import type { SoundPlayerPort } from './sound-player';

class RecordingPlayer implements SoundPlayerPort {
  readonly played: Array<{ sound: TradingSound; volume: number }> = [];
  play(sound: TradingSound, volume: number): void {
    this.played.push({ sound, volume });
  }
  dispose(): void {}
}

const event = (overrides: Partial<IncomingTradingEvent> = {}): IncomingTradingEvent => ({
  eventId: 'evt-1',
  kind: 'position.opened',
  title: 'BTCUSDT BUY opened',
  body: '0.10 BTCUSDT BUY at 64120.50',
  accountId: 'account-1',
  playSound: true,
  source: 'socket',
  ...overrides,
});

/**
 * The end of the chain the specification draws.
 *
 * Backend confirms → event → this → a sound, exactly once. Every test below is
 * a way for "exactly once" to be wrong.
 */
describe('handling a trading event on the device', () => {
  it('plays the sound for a new event', () => {
    const player = new RecordingPlayer();
    const handler = new TradingEventHandler(player);

    const result = handler.handle(event(), true);

    expect(result.duplicate).toBe(false);
    expect(result.playedSound).toBe('trade_opened');
    expect(player.played).toHaveLength(1);
  });

  it('ignores the same event arriving by a second route', () => {
    const player = new RecordingPlayer();
    const handler = new TradingEventHandler(player);

    handler.handle(event({ source: 'socket' }), true);
    // The push for the same fill arrives a moment after the socket frame. It
    // must not buzz, and it must not sound.
    const second = handler.handle(event({ source: 'push-foreground' }), true);

    expect(second.duplicate).toBe(true);
    expect(player.played).toHaveLength(1);
  });

  it('ignores a replay after a reconnect', () => {
    const player = new RecordingPlayer();
    const handler = new TradingEventHandler(player);

    for (let i = 0; i < 5; i += 1) handler.handle(event(), true);

    // A train tunnel must not cost a trader five identical chimes.
    expect(player.played).toHaveLength(1);
  });

  it('plays a different sound for a modification', () => {
    const player = new RecordingPlayer();
    const handler = new TradingEventHandler(player);

    handler.handle(event({ eventId: 'a', kind: 'position.opened' }), true);
    handler.handle(event({ eventId: 'b', kind: 'position.modified' }), true);

    // §18, at the point where it is finally audible.
    expect(player.played.map((entry) => entry.sound)).toEqual(['trade_opened', 'trade_modified']);
  });

  it('gives a stop loss its own sound', () => {
    const player = new RecordingPlayer();
    const handler = new TradingEventHandler(player);
    handler.handle(event({ kind: 'position.stop_loss' }), true);
    expect(player.played[0]?.sound).toBe('stop_loss');
  });

  it('stays silent in the background, where the OS has already played it', () => {
    const player = new RecordingPlayer();
    const handler = new TradingEventHandler(player);

    const result = handler.handle(event(), false);

    expect(result.duplicate).toBe(false);
    expect(player.played).toEqual([]);
  });

  it('stays silent when the trader taps the notification', () => {
    const player = new RecordingPlayer();
    const handler = new TradingEventHandler(player);

    handler.handle(event({ source: 'push-tapped' }), true);

    // The OS made a noise when it arrived; the trader is now looking at the
    // screen. Sounding again is the other half of the double-sound bug.
    expect(player.played).toEqual([]);
  });

  it('records the event even when it makes no sound', () => {
    const player = new RecordingPlayer();
    const handler = new TradingEventHandler(player);

    handler.handle(event(), false);
    const later = handler.handle(event(), true);

    // Otherwise the socket frame that arrives when the app returns to the
    // foreground would sound for something the trader already saw.
    expect(later.duplicate).toBe(true);
    expect(player.played).toEqual([]);
  });

  it('honours the volume the trader chose', () => {
    const player = new RecordingPlayer();
    const handler = new TradingEventHandler(player);
    handler.setPreferences({ soundEnabled: true, soundVolume: 40, perCategory: {} });

    handler.handle(event(), true);

    expect(player.played[0]?.volume).toBeCloseTo(0.4);
  });

  it('honours a muted category', () => {
    const player = new RecordingPlayer();
    const handler = new TradingEventHandler(player);
    handler.setPreferences({
      soundEnabled: true,
      soundVolume: 80,
      perCategory: { [NotificationCategory.TRADE_OPENED]: false },
    });

    handler.handle(event(), true);

    expect(player.played).toEqual([]);
  });

  it('does not second-guess the server into playing something', () => {
    const player = new RecordingPlayer();
    const handler = new TradingEventHandler(player);
    // The server has already applied quiet hours and preferences.
    handler.handle(event({ playSound: false }), true);
    expect(player.played).toEqual([]);
  });

  it('forgets what it has seen when the trader signs out', () => {
    const player = new RecordingPlayer();
    const handler = new TradingEventHandler(player);

    handler.handle(event(), true);
    handler.reset();
    const afterSignIn = handler.handle(event(), true);

    // The next person on this phone starts clean.
    expect(afterSignIn.duplicate).toBe(false);
    expect(player.played).toHaveLength(2);
  });
});
