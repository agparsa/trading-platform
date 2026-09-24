import { beforeEach, describe, expect, it } from 'vitest';
import { NotificationCategory, type TradingSound } from '@tp/shared-types';
import { TradingEventHandler, type IncomingTradingEvent } from './trading-events';
import type { SoundPlayerPort } from './sound-player';
import { SeenEvents } from './seen-events';

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
  source: 'push-foreground',
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

    handler.handle(event({ source: 'push-foreground' }), true);
    // The trader taps the notice for the fill they just heard. It must not
    // buzz, and it must not sound.
    const second = handler.handle(event({ source: 'push-tapped' }), true);

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

    // Otherwise tapping that notice later, with the app in the foreground,
    // would be handled as new for something the trader already saw.
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

describe('haptics alongside sound', () => {
  const buzzed: string[] = [];
  const haptics = {
    vibrate: (pattern: string) => {
      buzzed.push(pattern);
    },
  };

  beforeEach(() => {
    buzzed.length = 0;
  });

  const event = (over: Partial<IncomingTradingEvent> = {}): IncomingTradingEvent => ({
    eventId: `e${Math.random()}`,
    kind: 'order.filled',
    title: 'Filled',
    body: '1.00 XAUUSD',
    accountId: null,
    playSound: true,
    source: 'push-foreground',
    ...over,
  });

  it('vibrates for an event that matters', () => {
    const handler = new TradingEventHandler(
      { play: () => undefined, dispose: () => undefined },
      new SeenEvents(),
      haptics as never,
    );
    const result = handler.handle(event(), true);
    expect(result.vibrated).toBe('success');
    expect(buzzed).toEqual(['success']);
  });

  /**
   * The point of deciding the two separately. A trader with sound off in a
   * meeting still wants to feel a fill; deriving the buzz from the sound would
   * silently take that away.
   */
  it('still vibrates when sound is off', () => {
    const handler = new TradingEventHandler(
      { play: () => undefined, dispose: () => undefined },
      new SeenEvents(),
      haptics as never,
    );
    handler.setPreferences({ soundEnabled: false, soundVolume: 0, perCategory: {} });

    const result = handler.handle(event(), true);
    expect(result.playedSound).toBeNull();
    expect(result.vibrated).toBe('success');
    // The device, not just the report: the two decisions are independent all
    // the way to the hardware, not only in what the handler says it did.
    expect(buzzed).toEqual(['success']);
  });

  /** One switch per category, shared with sound. */
  it('stays still for a category the trader muted', () => {
    const handler = new TradingEventHandler(
      { play: () => undefined, dispose: () => undefined },
      new SeenEvents(),
      haptics as never,
    );
    handler.setPreferences({
      soundEnabled: true,
      soundVolume: 80,
      perCategory: { ORDER_FILLED: false },
    });

    expect(handler.handle(event(), true).vibrated).toBeNull();
    expect(buzzed).toEqual([]);
  });

  it('has its own master switch', () => {
    const handler = new TradingEventHandler(
      { play: () => undefined, dispose: () => undefined },
      new SeenEvents(),
      haptics as never,
    );
    handler.setPreferences({
      soundEnabled: true,
      soundVolume: 80,
      perCategory: {},
      hapticsEnabled: false,
    });

    expect(handler.handle(event(), true).vibrated).toBeNull();
  });

  /**
   * The OS already buzzed when the push arrived and the trader is holding the
   * phone. Buzzing again tells them nothing they are not already doing.
   */
  it('stays still for a notification the trader tapped', () => {
    const handler = new TradingEventHandler(
      { play: () => undefined, dispose: () => undefined },
      new SeenEvents(),
      haptics as never,
    );
    expect(handler.handle(event({ source: 'push-tapped' }), true).vibrated).toBeNull();
  });
});
