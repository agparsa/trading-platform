'use client';

import { useEffect } from 'react';
import { useNotificationPreferences } from './queries';
import { unlockAudio, useSoundSettings } from './trade-sounds';

/**
 * Keeps the terminal's player on the trader's own sound settings — the
 * server's `soundEnabled` and `soundVolume`, the same ones the phone app
 * obeys — and unlocks browser audio on the first touch or key, which no page
 * may do on its own.
 */
export function useSoundSync(): void {
  const preferences = useNotificationPreferences();
  const enabled = preferences.data?.soundEnabled;
  const volume = preferences.data?.soundVolume;

  useEffect(() => {
    if (enabled === undefined || volume === undefined) return;
    useSoundSettings.getState().set(enabled, volume);
  }, [enabled, volume]);

  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);
}
