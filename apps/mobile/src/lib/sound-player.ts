import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import type { TradingSound } from '@tp/shared-types';

/**
 * Plays one of the eight trading sounds.
 *
 * ## Why players are created once and kept
 *
 * A fill sound must start within a few tens of milliseconds of the fill, or the
 * association is lost and it stops feeling like feedback. Decoding a file on
 * demand costs enough to notice, so every sound gets a player at startup and
 * `play()` only ever seeks and starts.
 *
 * The cost is eight decoded buffers held for the life of the app. They are a
 * few hundred kilobytes each at most; the alternative is latency on exactly the
 * event the trader is waiting to hear.
 *
 * ## Why silent mode is respected on iOS
 *
 * `playsInSilentMode` is deliberately **not** set. A person who has physically
 * flipped the mute switch has said what they want, and an app that overrides it
 * to announce a routine fill is one they will uninstall. The push notification
 * still arrives; iOS decides whether it makes a noise, which is the correct
 * place for that decision.
 */
export interface SoundPlayerPort {
  play(sound: TradingSound, volume: number): void;
  dispose(): void;
}

/**
 * The bundled assets.
 *
 * `require` with a literal path, because the bundler resolves these at build
 * time and a computed path silently produces nothing. That is why this is a
 * hand-written map rather than a loop over `SOUND_ASSETS`.
 */
const SOURCES: Readonly<Record<TradingSound, number>> = {
  trade_opened: require('../../assets/sounds/trade_opened.wav') as number,
  trade_closed: require('../../assets/sounds/trade_closed.wav') as number,
  trade_modified: require('../../assets/sounds/trade_modified.wav') as number,
  order_filled: require('../../assets/sounds/order_filled.wav') as number,
  order_cancelled: require('../../assets/sounds/order_cancelled.wav') as number,
  stop_loss: require('../../assets/sounds/stop_loss.wav') as number,
  take_profit: require('../../assets/sounds/take_profit.wav') as number,
  risk_warning: require('../../assets/sounds/risk_warning.wav') as number,
  price_alert: require('../../assets/sounds/price_alert.wav') as number,
};

export class ExpoSoundPlayer implements SoundPlayerPort {
  private readonly players = new Map<TradingSound, AudioPlayer>();

  static async create(): Promise<ExpoSoundPlayer> {
    // Mixes with other audio rather than interrupting it. A trader listening to
    // something while they watch the market should not have it stopped by a
    // notification chime.
    await setAudioModeAsync({ playsInSilentMode: false, shouldPlayInBackground: false });
    return new ExpoSoundPlayer();
  }

  play(sound: TradingSound, volume: number): void {
    let player = this.players.get(sound);
    if (player === undefined) {
      const source = SOURCES[sound];
      if (source === undefined) return;
      player = createAudioPlayer(source);
      this.players.set(sound, player);
    }
    player.volume = volume;
    // Rewind first: two fills a second apart must both be audible, and a player
    // sitting at the end of its buffer plays nothing.
    player.seekTo(0).catch(() => undefined);
    player.play();
  }

  dispose(): void {
    for (const player of this.players.values()) player.remove();
    this.players.clear();
  }
}

/** Used on a simulator, in tests, and when audio fails to initialise. */
export const silentPlayer: SoundPlayerPort = {
  play: () => undefined,
  dispose: () => undefined,
};
