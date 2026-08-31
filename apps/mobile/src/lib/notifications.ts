import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { DevicePlatform, NOTIFICATION_CATEGORIES, TradingSound } from '@tp/shared-types';
import { SOUND_ASSETS } from './sound-decision';

/**
 * Everything the operating system needs to know before a notification arrives.
 *
 * ## Channels are not optional on Android
 *
 * From Android 8, a notification naming a channel the app has not created is
 * delivered **silently** — no sound, no heads-up, no complaint. That is the
 * quietest possible failure for a margin call, so the channels are created at
 * startup, before any token is registered, and one per sound: Android binds a
 * sound to a channel, not to a message, and a channel's sound cannot be changed
 * after it is created.
 */
export const TRADING_CHANNEL_ID = 'trading';

/** One channel per sound, because Android will not let a message choose one. */
const CHANNELS: ReadonlyArray<{ id: string; name: string; sound: TradingSound | null }> = [
  { id: TRADING_CHANNEL_ID, name: 'Trading', sound: TradingSound.TRADE_OPENED },
  { id: 'trading-closed', name: 'Closed trades', sound: TradingSound.TRADE_CLOSED },
  { id: 'trading-modified', name: 'Changed trades', sound: TradingSound.TRADE_MODIFIED },
  { id: 'trading-stop-loss', name: 'Stop loss', sound: TradingSound.STOP_LOSS },
  { id: 'trading-take-profit', name: 'Take profit', sound: TradingSound.TAKE_PROFIT },
  { id: 'risk', name: 'Risk alerts', sound: TradingSound.RISK_WARNING },
  { id: 'security', name: 'Security alerts', sound: TradingSound.RISK_WARNING },
  { id: 'system', name: 'System', sound: null },
];

export async function configureChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;

  for (const channel of CHANNELS) {
    await Notifications.setNotificationChannelAsync(channel.id, {
      name: channel.name,
      // MAX rather than HIGH: everything this app sends is time-critical, and
      // a heads-up notification a trader has to pull down the shade to see is
      // one they see after the position closed.
      importance: Notifications.AndroidImportance.MAX,
      ...(channel.sound === null ? { sound: null } : { sound: SOUND_ASSETS[channel.sound] }),
      vibrationPattern: [0, 250, 250, 250],
      enableVibrate: true,
    });
  }
}

/**
 * How a notification behaves while the app is open.
 *
 * `shouldPlaySound: false` is deliberate and load-bearing. In the foreground
 * the app plays the sound itself, through `SoundService`, *after* the event has
 * been deduplicated. Letting the OS play it too would make a trader hear every
 * fill twice — and it looks exactly like a duplicate-event bug when it is not.
 */
export function installForegroundHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: true,
    }),
  });
}

export interface DeviceRegistration {
  readonly platform: DevicePlatform;
  readonly installationId: string;
  readonly pushToken: string | null;
  readonly model: string | null;
  readonly osVersion: string | null;
  readonly appVersion: string | null;
  readonly locale: string | null;
}

/**
 * Asks for permission and, if granted, returns the native push token.
 *
 * `getDevicePushTokenAsync` rather than `getExpoPushTokenAsync`: this platform
 * sends through its own FCM and APNs credentials, not Expo's push service. The
 * two return different things — an FCM registration token on Android and a raw
 * APNs token on iOS — which is why the server routes by platform.
 *
 * Returns `null` rather than throwing when permission is refused. A trader who
 * declines notifications must still be able to trade.
 */
export async function requestPushToken(): Promise<string | null> {
  if (!Device.isDevice) {
    // A simulator has no push token. Returning null keeps development usable
    // instead of failing sign-in on every simulator run.
    return null;
  }

  const existing = await Notifications.getPermissionsAsync();
  const granted =
    existing.granted ||
    (
      await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowBadge: true, allowSound: true },
      })
    ).granted;

  if (!granted) return null;

  try {
    const token = await Notifications.getDevicePushTokenAsync();
    return typeof token.data === 'string' ? token.data : null;
  } catch {
    // A build without push entitlements, or a device with no Google Play
    // Services. Neither should stop the app from working.
    return null;
  }
}

export function platformOf(): DevicePlatform {
  switch (Platform.OS) {
    case 'ios':
      return DevicePlatform.IOS;
    case 'android':
      return DevicePlatform.ANDROID;
    default:
      return DevicePlatform.WEB;
  }
}

/** Categories the settings screen offers, in the order it shows them. */
export const SETTINGS_CATEGORIES = NOTIFICATION_CATEGORIES;
