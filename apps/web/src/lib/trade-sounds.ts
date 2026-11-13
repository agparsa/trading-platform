'use client';

import { create } from 'zustand';
import type { TradeSoundId } from './trading-toasts';

/**
 * The terminal's trading sounds.
 *
 * Synthesised in the browser with the Web Audio API from the scores below —
 * written for this platform, so there is no recording to license and nothing
 * to download. Each is under half a second and shaped with a fast attack and
 * an exponential release, which is what makes a tone read as a "chime" rather
 * than a beep. The set follows the familiar terminal grammar: up for opened
 * and take profit, down for closed and stop loss, a buzz for a refusal, an
 * alternating alarm for a stop-out.
 *
 * Played only for the server's events (see `soundFor`), at the volume the
 * trader set on the server (`soundVolume`), and never twice for the same
 * event: the order's answer and its WebSocket frame are the same news.
 */

/** One note: frequency (Hz), start and length (s), waveform, relative level. */
export interface Note {
  readonly hz: number;
  readonly at: number;
  readonly length: number;
  readonly wave: OscillatorType;
  readonly level: number;
}

const n = (hz: number, at: number, length: number, wave: OscillatorType, level = 1): Note => ({
  hz,
  at,
  length,
  wave,
  level,
});

export const SCORES: Readonly<Record<TradeSoundId, readonly Note[]>> = {
  // A bright rising fifth.
  trade_opened: [n(1046.5, 0, 0.09, 'triangle'), n(1568, 0.07, 0.16, 'triangle')],
  // The same interval, falling, softer.
  trade_closed: [n(1568, 0, 0.08, 'triangle', 0.8), n(1046.5, 0.07, 0.18, 'triangle', 0.8)],
  // A single soft tick: something changed, nothing happened.
  trade_modified: [n(1318.5, 0, 0.07, 'sine', 0.7)],
  // A rising major arpeggio.
  take_profit: [
    n(523.3, 0, 0.08, 'triangle'),
    n(659.3, 0.07, 0.08, 'triangle'),
    n(784, 0.14, 0.08, 'triangle'),
    n(1046.5, 0.21, 0.22, 'triangle'),
  ],
  // A falling minor line, darker waveform.
  stop_loss: [
    n(440, 0, 0.1, 'sawtooth', 0.45),
    n(349.2, 0.09, 0.1, 'sawtooth', 0.45),
    n(293.7, 0.18, 0.24, 'sawtooth', 0.45),
  ],
  // Two low pulses: refused.
  order_rejected: [n(196, 0, 0.11, 'square', 0.35), n(196, 0.15, 0.16, 'square', 0.35)],
  // Alternating alarm.
  risk_warning: [
    n(880, 0, 0.12, 'square', 0.35),
    n(660, 0.14, 0.12, 'square', 0.35),
    n(880, 0.28, 0.12, 'square', 0.35),
    n(660, 0.42, 0.18, 'square', 0.35),
  ],
};

/** The trader's settings, from the server; off until they have been read. */
export const useSoundSettings = create<{
  enabled: boolean;
  /** 0–100. */
  volume: number;
  set: (enabled: boolean, volume: number) => void;
}>((set) => ({
  enabled: false,
  volume: 70,
  set: (enabled, volume) => set({ enabled, volume }),
}));

/**
 * Remembers what has already been played, so one event is one sound.
 * Bounded: duplicates arrive milliseconds apart, and the terminal stays open
 * all day.
 */
export class PlayedOnce {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  constructor(private readonly limit = 256) {}
  /** True the first time a key is offered, false after. */
  first(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.order.push(key);
    if (this.order.length > this.limit) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }
}

/** The gain a 0–100 setting becomes. Perceived loudness is not linear. */
export function gainFor(volume: number): number {
  const v = Math.min(100, Math.max(0, volume)) / 100;
  return 0.35 * v * v;
}

const played = new PlayedOnce();
let context: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (Ctor === undefined) return null;
  context ??= new Ctor();
  return context;
}

/**
 * Browsers start audio suspended until the page has been touched. Called on
 * the first pointer or key press, so the first fill after load is heard.
 */
export function unlockAudio(): void {
  const ctx = audio();
  if (ctx !== null && ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
}

/** Plays one score now, regardless of settings — the settings screen's preview. */
export function playScore(id: TradeSoundId, volume: number): void {
  const ctx = audio();
  if (ctx === null) return;
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  const peak = gainFor(volume);
  if (peak <= 0) return;
  const start = ctx.currentTime + 0.01;
  for (const note of SCORES[id]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = note.wave;
    osc.frequency.value = note.hz;
    const t0 = start + note.at;
    const level = Math.max(0.0001, peak * note.level);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(level, t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + note.length);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + note.length + 0.02);
  }
}

/**
 * The sound for one server event, once, if the trader has sound on. `key` is
 * the event's subject — the same key the toast uses.
 */
export function playTradeSound(id: TradeSoundId | null, key: string): void {
  if (id === null) return;
  if (!played.first(`${id}:${key}`)) return;
  const { enabled, volume } = useSoundSettings.getState();
  if (!enabled) return;
  try {
    playScore(id, volume);
  } catch {
    // A browser without audio is a terminal without sound, not a broken one.
  }
}
