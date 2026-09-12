/**
 * The notification platform's wire contract.
 *
 * Lives here rather than in the API because three clients read it — the web
 * terminal, the mobile app and, eventually, a PropFA product subscribing to the
 * event seam. A category renamed in one place and not the others is a silently
 * muted alert, which is the failure this file exists to prevent.
 */

/** The operating system a registered device runs. */
export const DevicePlatform = {
  IOS: 'IOS',
  ANDROID: 'ANDROID',
  WEB: 'WEB',
} as const;
export type DevicePlatform = (typeof DevicePlatform)[keyof typeof DevicePlatform];

/**
 * A group of notifications a person can turn off as a unit.
 *
 * Coarser than a notification `kind` on purpose: a trader wants one switch for
 * "tell me when a stop loss fires", not one per instrument.
 */
export const NotificationCategory = {
  TRADE_OPENED: 'TRADE_OPENED',
  TRADE_CLOSED: 'TRADE_CLOSED',
  TRADE_MODIFIED: 'TRADE_MODIFIED',
  ORDER_FILLED: 'ORDER_FILLED',
  ORDER_CANCELLED: 'ORDER_CANCELLED',
  STOP_LOSS: 'STOP_LOSS',
  TAKE_PROFIT: 'TAKE_PROFIT',
  RISK_ALERT: 'RISK_ALERT',
  SECURITY_ALERT: 'SECURITY_ALERT',
  /**
   * A level the trader asked to be told about. Its own category, and a mutable
   * one: unlike a margin call, nothing happens to the account if it is missed,
   * and a trader who has decided they no longer want to hear about levels is
   * entitled to that.
   */
  PRICE_ALERT: 'PRICE_ALERT',
  SYSTEM: 'SYSTEM',
} as const;
export type NotificationCategory = (typeof NotificationCategory)[keyof typeof NotificationCategory];

export const NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = Object.values(
  NotificationCategory,
) as NotificationCategory[];

/**
 * Categories a person may not turn off.
 *
 * §24 of the specification: business-critical security notices must not be
 * silently disabled. "Silently" is the operative word — the API does not
 * pretend to accept the change and then ignore it; it refuses, so the client
 * can say why. `RISK_ALERT` is here for the same reason a margin call is not a
 * matter of taste: a trader who has muted it still gets liquidated.
 */
export const UNMUTABLE_CATEGORIES: readonly NotificationCategory[] = [
  NotificationCategory.SECURITY_ALERT,
  NotificationCategory.RISK_ALERT,
];

export function isUnmutable(category: NotificationCategory): boolean {
  return UNMUTABLE_CATEGORIES.includes(category);
}

/**
 * The sound a client plays for an event.
 *
 * §18 requires that modifying a trade sounds different from opening one, so the
 * mapping from category to sound is part of the contract rather than a choice
 * each client makes. A client that lacks an asset falls back to its default
 * rather than playing the wrong one.
 */
export const TradingSound = {
  TRADE_OPENED: 'trade_opened',
  TRADE_CLOSED: 'trade_closed',
  TRADE_MODIFIED: 'trade_modified',
  ORDER_FILLED: 'order_filled',
  ORDER_CANCELLED: 'order_cancelled',
  STOP_LOSS: 'stop_loss',
  TAKE_PROFIT: 'take_profit',
  RISK_WARNING: 'risk_warning',
  PRICE_ALERT: 'price_alert',
} as const;
export type TradingSound = (typeof TradingSound)[keyof typeof TradingSound];

/** Which sound a category plays. `null` means the client stays silent. */
export const SOUND_FOR_CATEGORY: Readonly<Record<NotificationCategory, TradingSound | null>> = {
  TRADE_OPENED: TradingSound.TRADE_OPENED,
  TRADE_CLOSED: TradingSound.TRADE_CLOSED,
  TRADE_MODIFIED: TradingSound.TRADE_MODIFIED,
  ORDER_FILLED: TradingSound.ORDER_FILLED,
  ORDER_CANCELLED: TradingSound.ORDER_CANCELLED,
  STOP_LOSS: TradingSound.STOP_LOSS,
  TAKE_PROFIT: TradingSound.TAKE_PROFIT,
  RISK_ALERT: TradingSound.RISK_WARNING,
  SECURITY_ALERT: TradingSound.RISK_WARNING,
  PRICE_ALERT: TradingSound.PRICE_ALERT,
  SYSTEM: null,
};

/**
 * Which category a notification `kind` belongs to.
 *
 * An unknown kind maps to `SYSTEM` rather than being dropped. Dropping it would
 * mean a notice added to the backend and not to this table silently reaches
 * nobody — the worst possible failure for a system whose job is telling people
 * things.
 */
export const CATEGORY_FOR_KIND: Readonly<Record<string, NotificationCategory>> = {
  'position.opened': NotificationCategory.TRADE_OPENED,
  'position.closed': NotificationCategory.TRADE_CLOSED,
  'position.partial_close': NotificationCategory.TRADE_CLOSED,
  'position.modified': NotificationCategory.TRADE_MODIFIED,
  'position.stop_loss': NotificationCategory.STOP_LOSS,
  'position.take_profit': NotificationCategory.TAKE_PROFIT,
  'order.filled': NotificationCategory.ORDER_FILLED,
  'order.cancelled': NotificationCategory.ORDER_CANCELLED,
  'order.modified': NotificationCategory.TRADE_MODIFIED,
  'price.alert': NotificationCategory.PRICE_ALERT,
  'risk.margin_call': NotificationCategory.RISK_ALERT,
  'risk.stop_out': NotificationCategory.RISK_ALERT,
  'risk.drawdown_warning': NotificationCategory.RISK_ALERT,
  'account.suspended': NotificationCategory.SECURITY_ALERT,
  'security.new_device': NotificationCategory.SECURITY_ALERT,
  'security.password_changed': NotificationCategory.SECURITY_ALERT,
  'security.login_from_new_ip': NotificationCategory.SECURITY_ALERT,
  // Verification decisions are about the person, not a trade, and not a
  // threat: SYSTEM is right. Listed so a reader sees they were considered.
  'kyc.verified': NotificationCategory.SYSTEM,
  'kyc.rejected': NotificationCategory.SYSTEM,
  'kyc.revoked': NotificationCategory.SYSTEM,
  'kyc.expired': NotificationCategory.SYSTEM,
  'withdrawal.rejected': NotificationCategory.SYSTEM,
  'withdrawal.failed': NotificationCategory.SYSTEM,
  'withdrawal.paid': NotificationCategory.SYSTEM,
  // A key minted or revoked is something its holder must hear about whatever
  // their preferences: the first is how they learn of one they did not mint.
  'api_key.minted': NotificationCategory.SYSTEM,
  'api_key.revoked': NotificationCategory.SYSTEM,
};

export function categoryForKind(kind: string): NotificationCategory {
  return CATEGORY_FOR_KIND[kind] ?? NotificationCategory.SYSTEM;
}

/**
 * A device as its owner sees it.
 *
 * §28: the push token is never in here. `pushTokenFingerprint` is four
 * characters — enough for someone on a support call to say which device stopped
 * receiving, not enough to send anything to it.
 */
export interface DeviceDto {
  id: string;
  platform: DevicePlatform;
  installationId: string;
  model: string | null;
  osVersion: string | null;
  appVersion: string | null;
  locale: string | null;
  hasPushToken: boolean;
  pushTokenFingerprint: string | null;
  pushTokenRejectedAt: string | null;
  isActive: boolean;
  lastSeenAt: string;
  createdAt: string;
}

/**
 * A device as staff see it (§13-14): everything its owner sees, plus whether
 * staff revoked it. Deliberately an extension of `DeviceDto` rather than a
 * parallel shape, so there is no admin-only field that could one day be a
 * push token.
 */
export interface AdminDeviceDto extends DeviceDto {
  revokedByStaffAt: string | null;
}

export interface NotificationPreferenceDto {
  category: NotificationCategory;
  inApp: boolean;
  push: boolean;
  sound: boolean;
  email: boolean;
  /** True when the API will refuse to turn this category off. */
  unmutable: boolean;
}

export interface NotificationSettingsDto {
  tradingEnabled: boolean;
  pushEnabled: boolean;
  soundEnabled: boolean;
  vibrationEnabled: boolean;
  soundVolume: number;
  quietHoursStartMinute: number | null;
  quietHoursEndMinute: number | null;
  quietHoursTimezone: string | null;
  categories: NotificationPreferenceDto[];
}

/**
 * The physical feedback a client gives for an event.
 *
 * Deliberately a much shorter list than the sounds. A phone can render three or
 * four distinguishable taps and no more — beyond that a trader feels "something
 * buzzed", which is worse than one clear pattern, not better. So haptics answer
 * a coarser question than sound does: did something happen, did something go
 * against you, or is this urgent.
 */
export const TradingHaptic = {
  /** A light tap: something happened and it was routine. */
  LIGHT: 'light',
  /** A firmer tap: money moved. */
  MEDIUM: 'medium',
  /** The platform's "success" pattern: an intention completed. */
  SUCCESS: 'success',
  /** The platform's "warning" pattern: attention, now. */
  WARNING: 'warning',
} as const;
export type TradingHaptic = (typeof TradingHaptic)[keyof typeof TradingHaptic];

/**
 * Which pattern a category vibrates.
 *
 * `null` means the device stays still. Most notices are in that group on
 * purpose: a phone that buzzes at everything is a phone whose owner turns
 * haptics off, which costs them the two that were worth feeling.
 *
 * A stop-out and a margin call share WARNING with a security alert. That is not
 * laziness — all three mean "look at this now", and giving each its own pattern
 * would ask a trader to distinguish by feel three things they must in any case
 * look at.
 */
export const HAPTIC_FOR_CATEGORY: Readonly<Record<NotificationCategory, TradingHaptic | null>> = {
  TRADE_OPENED: TradingHaptic.LIGHT,
  TRADE_CLOSED: TradingHaptic.MEDIUM,
  TRADE_MODIFIED: TradingHaptic.LIGHT,
  ORDER_FILLED: TradingHaptic.SUCCESS,
  ORDER_CANCELLED: TradingHaptic.LIGHT,
  // A protective level firing is money moving without the trader asking, which
  // is the case they most want to feel in a pocket rather than read later.
  STOP_LOSS: TradingHaptic.WARNING,
  TAKE_PROFIT: TradingHaptic.SUCCESS,
  RISK_ALERT: TradingHaptic.WARNING,
  SECURITY_ALERT: TradingHaptic.WARNING,
  PRICE_ALERT: TradingHaptic.MEDIUM,
  SYSTEM: null,
};
