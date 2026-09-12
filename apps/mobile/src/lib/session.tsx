import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Application from 'expo-application';
import * as Localization from 'expo-localization';
import type { ApiClient } from '@tp/api-client';
import type { NotificationSettingsDto } from '@tp/shared-types';
import { apiBaseUrl, createApi, toTokens, tokenStore } from './api';
import type { TokenStore } from './token-store';
import {
  configureChannels,
  installForegroundHandler,
  platformOf,
  requestPushToken,
} from './notifications';
import { TradingEventHandler, type IncomingTradingEvent } from './trading-events';
import { ExpoSoundPlayer, silentPlayer, type SoundPlayerPort } from './sound-player';

interface SessionValue {
  readonly api: ApiClient;
  readonly signedIn: boolean;
  readonly loading: boolean;
  signIn(email: string, password: string): Promise<{ twoFactorRequired: boolean }>;
  completeTwoFactor(challengeId: string, code: string): Promise<void>;
  signOut(): Promise<void>;
  /**
   * A token good for right now, refreshing first if it is close to expiry.
   *
   * Exposed for the WebSocket, which authenticates on connect and cannot go
   * through the REST client's own retry hook. Routed through the same
   * `TokenStore` so a socket reconnect during a refresh does not start a second
   * one — refresh tokens rotate, and two in flight means one gets rejected.
   */
  accessToken(): Promise<string | null>;
  /** Everything the settings screen shows, refreshed on demand. */
  readonly preferences: NotificationSettingsDto | null;
  refreshPreferences(): Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

interface SignInResponse {
  accessToken?: string;
  refreshToken?: string;
  expiresInSeconds?: number;
  twoFactorRequired?: boolean;
  challengeId?: string;
}

/**
 * Holds the session, the API client, and the one handler that turns events into
 * sounds.
 *
 * ## Why the event handler lives here and not in a screen
 *
 * Because screens unmount. A trader who switches from positions to the chart
 * while an order fills must still hear it, and the memory of which events have
 * been handled must survive every navigation — otherwise moving between tabs
 * re-arms every duplicate.
 */
export function SessionProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [signedIn, setSignedIn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [preferences, setPreferences] = useState<NotificationSettingsDto | null>(null);

  const soundsRef = useRef<SoundPlayerPort>(silentPlayer);
  const eventsRef = useRef<TradingEventHandler>(new TradingEventHandler(silentPlayer));
  const appActiveRef = useRef(AppState.currentState === 'active');

  const tokens = useMemo<TokenStore>(
    () =>
      tokenStore(async (refreshToken) => {
        // Deliberately a bare fetch and not `api`: using the client here would
        // recurse through its own onTokenExpired hook the moment a refresh
        // itself returned 401.
        const response = await fetch(`${apiBaseUrl()}/api/v1/auth/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
        if (!response.ok) throw new Error(`refresh failed: ${response.status}`);
        const payload = (await response.json()) as { data: Required<SignInResponse> };
        return toTokens(payload.data);
      }),
    [],
  );

  const api = useMemo(() => createApi(tokens), [tokens]);

  /** Registers this installation and uploads the push token, if permitted. */
  const registerDevice = useCallback(async () => {
    const installationId = await installationIdentifier();
    const pushToken = await requestPushToken();
    try {
      await api.post(
        '/devices',
        {
          platform: platformOf(),
          installationId,
          pushToken,
          appVersion: Application.nativeApplicationVersion,
          model: null,
          osVersion: null,
          locale: Localization.getLocales()[0]?.languageTag ?? null,
        },
        { idempotencyKey: `device:${installationId}:${Date.now()}` },
      );
    } catch {
      // A device that could not be registered must not stop a trader trading.
      // The next launch tries again.
    }
  }, [api]);

  const refreshPreferences = useCallback(async () => {
    try {
      const next = await api.get<NotificationSettingsDto>('/notifications/preferences');
      setPreferences(next);
      eventsRef.current.setPreferences({
        soundEnabled: next.soundEnabled,
        soundVolume: next.soundVolume,
        perCategory: Object.fromEntries(next.categories.map((row) => [row.category, row.sound])),
      });
    } catch {
      // Keep whatever we had. Defaults are permissive, so the failure mode is
      // hearing a sound the trader had muted — annoying, not dangerous.
    }
  }, [api]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      installForegroundHandler();
      await configureChannels();
      try {
        soundsRef.current = await ExpoSoundPlayer.create();
      } catch {
        // Audio failed to initialise — a simulator without an audio device, or
        // a permission the OS declined. Silence beats crashing on launch.
        soundsRef.current = silentPlayer;
      }
      eventsRef.current = new TradingEventHandler(soundsRef.current);

      const current = await tokens.current();
      if (cancelled) return;
      setSignedIn(current !== null);
      setLoading(false);
      if (current !== null) {
        await registerDevice();
        await refreshPreferences();
      }
    })();

    const appStateSubscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      appActiveRef.current = state === 'active';
    });

    /**
     * A push that arrived while the app was open.
     *
     * The OS was told not to play a sound for it (see `notifications.ts`); this
     * decides, after deduplicating against the socket frame that may already
     * have arrived for the same occurrence.
     */
    const received = Notifications.addNotificationReceivedListener((notification) => {
      const event = toTradingEvent(notification.request.content.data, 'push-foreground');
      if (event !== null) eventsRef.current.handle(event, appActiveRef.current);
    });

    const responded = Notifications.addNotificationResponseReceivedListener((response) => {
      const event = toTradingEvent(response.notification.request.content.data, 'push-tapped');
      if (event !== null) eventsRef.current.handle(event, true);
    });

    return () => {
      cancelled = true;
      appStateSubscription.remove();
      received.remove();
      responded.remove();
      soundsRef.current.dispose();
    };
  }, [tokens, registerDevice, refreshPreferences]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      /**
       * The installation goes with the credentials.
       *
       * It is what binds this session to this handset, so that revoking the
       * device — by its owner, or by staff when it is lost — ends the session
       * too. Without it the phone keeps its access after being "removed", which
       * is the state the platform was in until this was added.
       *
       * Read from the OS, so it is available before there is any session to
       * read it with.
       */
      const installationId = await installationIdentifier();
      const result = await api.post<SignInResponse>(
        '/auth/login',
        { email, password, installationId },
        { idempotencyKey: `login:${email}:${Date.now()}` },
      );
      if (result.twoFactorRequired === true) return { twoFactorRequired: true };

      await tokens.save(toTokens(result as Required<SignInResponse>));
      setSignedIn(true);
      await registerDevice();
      await refreshPreferences();
      return { twoFactorRequired: false };
    },
    [api, tokens, registerDevice, refreshPreferences],
  );

  const completeTwoFactor = useCallback(
    async (challengeId: string, code: string) => {
      // The half that issues the session carries the installation, or a phone
      // with two-factor on would end up with a session belonging to no device.
      const installationId = await installationIdentifier();
      const result = await api.post<Required<SignInResponse>>(
        '/auth/2fa/verify',
        { challengeId, code, installationId },
        { idempotencyKey: `2fa:${challengeId}` },
      );
      await tokens.save(toTokens(result));
      setSignedIn(true);
      await registerDevice();
      await refreshPreferences();
    },
    [api, tokens, registerDevice, refreshPreferences],
  );

  const accessToken = useCallback(async () => {
    const current = await tokens.current();
    return current?.accessToken ?? null;
  }, [tokens]);

  const signOut = useCallback(async () => {
    await tokens.clear();
    // The next person on this phone must not inherit a memory of the last
    // one's fills.
    eventsRef.current.reset();
    setPreferences(null);
    setSignedIn(false);
  }, [tokens]);

  const value = useMemo<SessionValue>(
    () => ({
      api,
      signedIn,
      loading,
      signIn,
      completeTwoFactor,
      signOut,
      accessToken,
      preferences,
      refreshPreferences,
    }),
    [
      api,
      signedIn,
      loading,
      signIn,
      completeTwoFactor,
      signOut,
      accessToken,
      preferences,
      refreshPreferences,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession must be used inside a SessionProvider');
  return value;
}

/**
 * Reads a push payload into an event this app can handle.
 *
 * Returns null rather than throwing for anything that does not look like a
 * trading event — a payload from a future version of the server, or a
 * notification from another source entirely.
 */
export function toTradingEvent(
  data: unknown,
  source: IncomingTradingEvent['source'],
): IncomingTradingEvent | null {
  if (data === null || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  const eventId = record['eventId'];
  const category = record['category'];
  if (typeof eventId !== 'string' || typeof category !== 'string') return null;

  return {
    eventId,
    // The server sends the category; `kind` is only needed for the mapping,
    // which has already happened. Passing the category through as the kind
    // would be wrong, so the handler is given a kind that maps to it.
    kind: typeof record['kind'] === 'string' ? record['kind'] : '',
    title: typeof record['title'] === 'string' ? record['title'] : '',
    body: typeof record['body'] === 'string' ? record['body'] : '',
    accountId: typeof record['accountId'] === 'string' ? record['accountId'] : null,
    // A payload with no `sound` key is one the server decided should be silent.
    playSound: typeof record['sound'] === 'string',
    source,
  };
}

async function installationIdentifier(): Promise<string> {
  /**
   * A per-installation id that survives token rotation and app updates.
   *
   * On Android `getAndroidId()` is stable per app signing key and per device.
   * On iOS `getIosIdForVendorAsync()` is stable while any app from this vendor
   * is installed. Both change on reinstall, which is correct: a reinstall is a
   * new installation, and the old device row's token is dead anyway.
   */
  const ios = await Application.getIosIdForVendorAsync().catch(() => null);
  return ios ?? Application.getAndroidId() ?? 'unknown-installation';
}
