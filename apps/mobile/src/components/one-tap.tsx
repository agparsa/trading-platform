import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useT } from '../lib/i18n';
import { useOneTap } from '../lib/one-tap';
import { theme } from '../lib/theme';
import { Button } from './ui';

/**
 * The one-tap switch, with the question it asks before arming: what a press
 * will do from now on, in a sentence. Not offered where the firm switched
 * quick trading off.
 */
export function OneTapSwitch(): React.ReactElement | null {
  const t = useT();
  const { allowed, armed, setArmed } = useOneTap();
  const [asking, setAsking] = useState(false);
  if (!allowed) return null;
  return (
    <View style={[styles.switchBox, armed ? styles.switchArmed : null]}>
      <View style={styles.switchRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.switchTitle}>{t('oneTap.title')}</Text>
          <Text style={styles.switchHint}>{armed ? t('oneTap.on') : t('oneTap.off')}</Text>
        </View>
        <Switch
          accessibilityLabel={t('oneTap.title')}
          value={armed}
          onValueChange={(next) => {
            if (next) setAsking(true);
            else setArmed(false);
          }}
          trackColor={{ true: theme.colors.warning, false: theme.colors.surfaceRaised }}
          thumbColor="#FFFFFF"
        />
      </View>
      {asking ? (
        <View style={styles.ask}>
          <Text style={styles.askText}>{t('oneTap.ask')}</Text>
          <Button
            label={t('oneTap.turnOn')}
            onPress={() => {
              setAsking(false);
              setArmed(true);
            }}
          />
          <Button label={t('common.cancel')} variant="quiet" onPress={() => setAsking(false)} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * What became of a one-tap order, over every screen: sending, opened (from
 * the server's answer, with its price), or refused in the server's words.
 * A success fades after a few seconds; a refusal stays until dismissed.
 */
export function OneTapNotice(): React.ReactElement | null {
  const { notice, dismiss } = useOneTap();
  const insets = useSafeAreaInsets();
  const [shown, setShown] = useState(notice);
  useEffect(() => {
    setShown(notice);
    if (notice === null || notice.tone !== 'ok') return;
    const timer = setTimeout(dismiss, 4_000);
    return () => clearTimeout(timer);
  }, [notice, dismiss]);
  if (shown === null) return null;
  const tone =
    shown.tone === 'ok'
      ? theme.colors.positive
      : shown.tone === 'error'
        ? theme.colors.negative
        : theme.colors.accent;
  return (
    <Pressable
      accessibilityRole="alert"
      onPress={dismiss}
      style={[styles.notice, { top: insets.top + 8, borderColor: tone }]}
    >
      <View style={[styles.dot, { backgroundColor: tone }]} />
      <Text style={styles.noticeText}>{shown.text}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  switchBox: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    padding: theme.spacing(1.5),
    marginBottom: theme.spacing(1.5),
  },
  switchArmed: { borderColor: theme.colors.warning, backgroundColor: theme.colors.warningTint },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing(1) },
  switchTitle: { fontFamily: theme.font.bold, color: theme.colors.text, fontSize: theme.type.body },
  switchHint: {
    fontFamily: theme.font.regular,
    color: theme.colors.textMuted,
    fontSize: theme.type.label,
    marginTop: 4,
  },
  ask: { marginTop: theme.spacing(1) },
  askText: {
    fontFamily: theme.font.medium,
    color: theme.colors.text,
    fontSize: theme.type.body,
    lineHeight: 21,
  },
  notice: {
    position: 'absolute',
    left: 12,
    right: 12,
    zIndex: 100,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: theme.colors.surfaceRaised,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 12,
    elevation: 8,
  },
  dot: { width: 8, height: 8, borderRadius: theme.radius.xs },
  noticeText: {
    flex: 1,
    fontFamily: theme.font.semibold,
    color: theme.colors.text,
    fontSize: theme.type.body,
  },
});
