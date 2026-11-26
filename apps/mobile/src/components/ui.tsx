import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Icon } from './icons';
import { useLocale } from '../lib/i18n';
import { NUMERIC_DIRECTION } from '../lib/direction';
import { moved, theme } from '../lib/theme';
import { useReducedMotion } from '../lib/use-reduced-motion';
import { instrumentMark } from '../lib/instrument-mark';
import { PnlText } from './pnl-text';

/**
 * The pieces every screen is built from.
 *
 * The look is a trading terminal's: near-black, cards with a hairline edge,
 * prices in tabular figures, buy green and sell red as tinted tiles, money
 * made blue. Twenty screens now share it, which is when a kit earns its keep.
 */

export function Screen({ children }: { children: React.ReactNode }): React.ReactElement {
  return <View style={styles.screen}>{children}</View>;
}

export function Card({
  title,
  action,
  children,
}: {
  title?: string;
  /** Something small on the title's line: a link, a count. */
  action?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <View style={styles.card}>
      {title === undefined ? null : (
        <View style={styles.cardHead}>
          <Text style={styles.cardTitle}>{title}</Text>
          {action ?? null}
        </View>
      )}
      {children}
    </View>
  );
}

/**
 * An instrument's mark: a disc in its family's colour with a short glyph.
 * Decoration for the eye — the code beside it is what is read aloud.
 */
export function InstrumentBadge({
  code,
  size = 36,
}: {
  code: string;
  size?: number;
}): React.ReactElement {
  const mark = instrumentMark(code);
  if (mark.flags !== undefined) {
    // A pair: the base's flag, and the quote's tucked under its corner.
    const big = Math.round(size * 0.7);
    const small = Math.round(size * 0.54);
    return (
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ width: size, height: size }}
      >
        {/* The quote's flag first, so the base's sits over it, in front. */}
        <View
          style={[
            styles.flag,
            styles.flagQuote,
            { width: small, height: small, borderRadius: small / 2 },
          ]}
        >
          <Text style={{ fontSize: small * 0.62, lineHeight: small * 0.9 }}>{mark.flags[1]}</Text>
        </View>
        <View style={[styles.flag, { width: big, height: big, borderRadius: big / 2 }]}>
          <Text style={{ fontSize: big * 0.62, lineHeight: big * 0.9 }}>{mark.flags[0]}</Text>
        </View>
      </View>
    );
  }
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: `${mark.color}26`,
        borderWidth: 1,
        borderColor: `${mark.color}66`,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text
        style={{
          fontFamily: theme.font.heavy,
          color: mark.color,
          fontSize: mark.glyph.length > 1 ? size * 0.34 : size * 0.44,
        }}
      >
        {mark.glyph}
      </Text>
    </View>
  );
}

/**
 * One side of the book as a tile: SELL at the bid, BUY at the ask, tinted in
 * the side's colour, the price in tabular figures. Pressing it opens that
 * side's ticket — it never sends an order by itself.
 */
export function PriceTile({
  side,
  label,
  price,
  onPress,
  accessibilityLabel,
  compact = false,
  armed = false,
  busy = false,
}: {
  side: 'BUY' | 'SELL';
  label: string;
  price: string | null;
  /** Kept for callers that colour by the last move; the tile now works it out. */
  tone?: string;
  onPress: () => void;
  accessibilityLabel: string;
  compact?: boolean;
  /** One-tap is on: a press sends the order, so the tile says so. */
  armed?: boolean;
  /** An order from this tile is on its way; the tile waits. */
  busy?: boolean;
}): React.ReactElement {
  const buy = side === 'BUY';
  const still = useReducedMotion();
  const previous = useRef(price);
  const wash = useRef(new Animated.Value(0)).current;
  const [direction, setDirection] = useState<'up' | 'down' | null>(null);

  // Each new price: the digits take the colour of the move, and the tile
  // washes in it for a moment — the figure itself is never animated, only lit.
  useEffect(() => {
    const move = moved(previous.current, price);
    previous.current = price;
    if (move === null) return;
    setDirection(move);
    if (still) return;
    wash.setValue(1);
    Animated.timing(wash, { toValue: 0, duration: 600, useNativeDriver: false }).start();
  }, [price, still, wash]);

  const flash = wash.interpolate({
    inputRange: [0, 1],
    outputRange: [
      'rgba(0,0,0,0)',
      direction === 'down' ? 'rgba(234,57,67,0.24)' : 'rgba(22,199,132,0.24)',
    ],
  });

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ busy, disabled: busy }}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.tile,
        compact ? styles.tileCompact : null,
        {
          backgroundColor: buy ? theme.colors.buyTint : theme.colors.sellTint,
          borderColor: armed
            ? theme.colors.warning
            : buy
              ? 'rgba(22,199,132,0.35)'
              : 'rgba(234,57,67,0.35)',
          opacity: busy ? 0.55 : pressed ? 0.75 : 1,
          transform: [{ scale: pressed ? 0.97 : 1 }],
        },
      ]}
    >
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: flash, borderRadius: theme.radius.md }]}
      />
      <Text
        style={[styles.tileLabel, { color: buy ? theme.colors.positive : theme.colors.negative }]}
      >
        {armed ? `⚡ ${label}` : label}
      </Text>
      {busy ? (
        <ActivityIndicator color={theme.colors.text} size="small" />
      ) : (
        <Text
          style={[
            styles.tilePrice,
            compact ? styles.tilePriceCompact : null,
            {
              color:
                direction === 'up'
                  ? theme.colors.positive
                  : direction === 'down'
                    ? theme.colors.negative
                    : theme.colors.text,
              writingDirection: NUMERIC_DIRECTION,
            },
          ]}
          numberOfLines={1}
          adjustsFontSizeToFit
        >
          {price ?? '—'}
        </Text>
      )}
    </Pressable>
  );
}

/** A small filter or choice, pill-shaped; active ones fill with the accent. */
export function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}): React.ReactElement {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[styles.chip, active ? styles.chipActive : null]}
    >
      <Text style={[styles.chipLabel, active ? styles.chipLabelActive : null]}>{label}</Text>
    </Pressable>
  );
}

/** A side as a small coloured tag: BUY 0.10, SELL 1.00. */
export function SideTag({
  side,
  label,
}: {
  side: 'BUY' | 'SELL';
  label: string;
}): React.ReactElement {
  const buy = side === 'BUY';
  return (
    <View
      style={[
        styles.sideTag,
        { backgroundColor: buy ? theme.colors.buyTint : theme.colors.sellTint },
      ]}
    >
      <Text
        style={[
          styles.sideTagLabel,
          { color: buy ? theme.colors.positive : theme.colors.negative },
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

/**
 * A labelled figure.
 *
 * `writingDirection` is pinned left-to-right on the value. A price is a number
 * in every locale, and mirroring `-1,204.50` under an RTL layout produces
 * something that is not a number.
 */
export function Figure({
  label,
  value,
  signed = false,
}: {
  label: string;
  value: string;
  signed?: boolean;
}): React.ReactElement {
  return (
    <View style={styles.figure}>
      <Text style={styles.figureLabel}>{label}</Text>
      {signed ? (
        <PnlText value={/\d/.test(value) ? value : null} style={styles.figureValue} />
      ) : (
        <Text style={[styles.figureValue, { writingDirection: NUMERIC_DIRECTION }]}>{value}</Text>
      )}
    </View>
  );
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  busy = false,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'danger' | 'quiet' | 'buy' | 'outline';
  busy?: boolean;
  disabled?: boolean;
}): React.ReactElement {
  const background =
    variant === 'danger'
      ? theme.colors.negative
      : variant === 'buy'
        ? theme.colors.positive
        : variant === 'quiet'
          ? theme.colors.surfaceRaised
          : variant === 'outline'
            ? 'transparent'
            : theme.colors.accent;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        variant === 'outline' ? styles.buttonOutline : null,
        { backgroundColor: background, opacity: disabled || busy ? 0.5 : pressed ? 0.8 : 1 },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={theme.colors.text} />
      ) : (
        <Text
          style={[
            styles.buttonLabel,
            variant === 'quiet' || variant === 'outline' ? { color: theme.colors.text } : null,
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

export function Empty({ message }: { message: string }): React.ReactElement {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyText}>{message}</Text>
    </View>
  );
}

export function ErrorNote({ message }: { message: string }): React.ReactElement {
  return (
    <View style={styles.error}>
      {/* Stated, not swallowed. A screen that silently shows nothing when a
          request fails is one a trader cannot tell from an empty account. */}
      <Text style={styles.errorText}>{message}</Text>
    </View>
  );
}

/**
 * Choices side by side, one active — Positions | Orders, Sign in | Register.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}): React.ReactElement {
  return (
    <View style={styles.segmented} accessibilityRole="tablist">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(option.value)}
            style={[styles.segment, active ? styles.segmentActive : null]}
          >
            <Text style={[styles.segmentLabel, active ? styles.segmentLabelActive : null]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * The back arrow for a screen reached from More. Those screens live among the
 * tabs (so the tab bar stays), and a tab has no back button of its own.
 */
export function BackButton(): React.ReactElement {
  const router = useRouter();
  const { rtl } = useLocale();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Back"
      hitSlop={12}
      onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/more'))}
      style={{ paddingHorizontal: 12, transform: [{ scaleX: rtl ? 1 : -1 }] }}
    >
      <Icon name="chevron" color={theme.colors.text} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  segmented: {
    flexDirection: 'row',
    backgroundColor: theme.colors.surfaceSunken,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    padding: 3,
    gap: 3,
  },
  segment: {
    flex: 1,
    minHeight: 38,
    borderRadius: theme.radius.sm + 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentActive: {
    backgroundColor: theme.colors.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderStrong,
  },
  segmentLabel: { fontFamily: theme.font.semibold, color: theme.colors.textMuted, fontSize: 14 },
  segmentLabelActive: { fontFamily: theme.font.bold, color: theme.colors.text },
  screen: { flex: 1, backgroundColor: theme.colors.background, padding: theme.spacing(2) },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    padding: theme.spacing(2),
    marginBottom: theme.spacing(1.5),
  },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: theme.spacing(1),
  },
  cardTitle: {
    fontFamily: theme.font.bold,
    color: theme.colors.textMuted,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
  },
  figure: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: theme.spacing(0.9),
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  figureLabel: { fontFamily: theme.font.regular, color: theme.colors.textMuted, fontSize: 14 },
  figureValue: {
    fontFamily: theme.font.mono,
    color: theme.colors.text,
    fontSize: 15,
  },
  button: {
    // 48pt: the smallest target a thumb hits reliably, and the one thing worth
    // being strict about on a screen where a mistap places an order.
    minHeight: 50,
    borderRadius: theme.radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing(2),
    marginTop: theme.spacing(1),
  },
  buttonOutline: { borderWidth: 1, borderColor: theme.colors.borderStrong },
  buttonLabel: { fontFamily: theme.font.bold, color: '#FFFFFF', fontSize: 16, letterSpacing: 0.2 },
  flag: {
    position: 'absolute',
    top: 0,
    left: 0,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surfaceRaised,
    borderWidth: 1.5,
    borderColor: theme.colors.surface,
  },
  flagQuote: { top: undefined, left: undefined, right: 0, bottom: 0 },
  tile: {
    flex: 1,
    overflow: 'hidden',
    minHeight: 50,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    paddingHorizontal: theme.spacing(1),
    paddingVertical: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileCompact: { minHeight: 44, paddingVertical: 4 },
  tileLabel: { fontFamily: theme.font.heavy, fontSize: 10, letterSpacing: 1 },
  tilePrice: { fontFamily: theme.font.monoBold, fontSize: 17, marginTop: 1 },
  tilePriceCompact: { fontFamily: theme.font.regular, fontSize: 15 },
  chip: {
    paddingHorizontal: theme.spacing(1.75),
    minHeight: 34,
    justifyContent: 'center',
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  chipActive: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accentTint },
  chipLabel: { fontFamily: theme.font.semibold, color: theme.colors.textMuted, fontSize: 13 },
  chipLabelActive: { color: theme.colors.text },
  sideTag: { borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
  sideTagLabel: { fontFamily: theme.font.monoHeavy, fontSize: 12 },
  empty: { padding: theme.spacing(5), alignItems: 'center' },
  emptyText: {
    fontFamily: theme.font.regular,
    color: theme.colors.textMuted,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  error: {
    backgroundColor: theme.colors.sellTint,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(234,57,67,0.4)',
    padding: theme.spacing(1.5),
    marginBottom: theme.spacing(1.5),
  },
  errorText: { fontFamily: theme.font.regular, color: theme.colors.negative, fontSize: 14 },
});
