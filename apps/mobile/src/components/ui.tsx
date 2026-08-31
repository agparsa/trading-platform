import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { NUMERIC_DIRECTION } from '../lib/direction';
import { formatSigned, signColor, theme } from '../lib/theme';

/**
 * The handful of pieces every screen needs.
 *
 * Deliberately small. A design system is worth building when there are twenty
 * screens disagreeing about padding; before that it is a way of not writing the
 * screens.
 */

export function Screen({ children }: { children: React.ReactNode }): React.ReactElement {
  return <View style={styles.screen}>{children}</View>;
}

export function Card({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <View style={styles.card}>
      {title === undefined ? null : <Text style={styles.cardTitle}>{title}</Text>}
      {children}
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
      <Text
        style={[
          styles.figureValue,
          { writingDirection: NUMERIC_DIRECTION },
          signed ? { color: signColor(value) } : null,
        ]}
      >
        {signed ? formatSigned(value) : value}
      </Text>
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
  variant?: 'primary' | 'danger' | 'quiet';
  busy?: boolean;
  disabled?: boolean;
}): React.ReactElement {
  const background =
    variant === 'danger'
      ? theme.colors.negative
      : variant === 'quiet'
        ? theme.colors.surfaceRaised
        : theme.colors.accent;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: background, opacity: disabled || busy ? 0.5 : pressed ? 0.8 : 1 },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={theme.colors.text} />
      ) : (
        <Text style={styles.buttonLabel}>{label}</Text>
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

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background, padding: theme.spacing(2) },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    padding: theme.spacing(2),
    marginBottom: theme.spacing(1.5),
  },
  cardTitle: {
    color: theme.colors.textMuted,
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: theme.spacing(1),
  },
  figure: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: theme.spacing(0.75),
  },
  figureLabel: { color: theme.colors.textMuted, fontSize: 14 },
  figureValue: {
    color: theme.colors.text,
    fontSize: 16,
    fontFamily: theme.font.mono,
  },
  button: {
    // 48pt: the smallest target a thumb hits reliably, and the one thing worth
    // being strict about on a screen where a mistap places an order.
    minHeight: 48,
    borderRadius: theme.radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing(2),
    marginTop: theme.spacing(1),
  },
  buttonLabel: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
  empty: { padding: theme.spacing(4), alignItems: 'center' },
  emptyText: { color: theme.colors.textMuted, fontSize: 14, textAlign: 'center' },
  error: {
    backgroundColor: 'rgba(234, 57, 67, 0.12)',
    borderRadius: theme.radius.sm,
    padding: theme.spacing(1.5),
    marginBottom: theme.spacing(1.5),
  },
  errorText: { color: theme.colors.negative, fontSize: 14 },
});
