import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { isDomainError } from '@tp/shared-types';
import {
  canSubmitNow,
  checkPicked,
  documentSlots,
  type DocumentSlot,
  type KycView,
} from '../lib/kyc-upload';
import { useSession } from '../lib/session';
import { theme } from '../lib/theme';
import { Button, Card, ErrorNote, Figure } from './ui';
import { useT } from '../lib/i18n';
import { MESSAGES, serverWords, type MessageKey, type Translate } from '../lib/messages';

/** A server word, in the reader's language when there is a message for it. */
function words(prefix: string, value: string, t: Translate): string {
  const key = `${prefix}.${value}`;
  return key in MESSAGES.en ? t(key as MessageKey) : value;
}

/**
 * Identity verification on the phone: the status, and — while the record is
 * taking documents — a photo of each, taken or chosen, then a submission.
 *
 * Every step is the server's: `PUT /kyc/documents/:kind` with the bytes as
 * the body (the web's endpoint), then `POST /kyc/submit`, and the card is
 * redrawn from `GET /kyc` after each, so "sent" means the server holds it
 * and the submit button follows the server's own list of what is missing.
 * The camera is asked for only when the trader taps "Take photo".
 */
export function KycCard({
  view,
  onChanged,
}: {
  view: KycView;
  onChanged: () => Promise<void>;
}): React.ReactElement {
  const t = useT();
  const { api } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const slots = documentSlots(view);

  const say = (caught: unknown, fallback: string) =>
    setError(isDomainError(caught) ? serverWords(caught.code, caught.message, t) : fallback);

  const send = async (slot: DocumentSlot, source: 'camera' | 'library') => {
    setError(null);
    if (source === 'camera') {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        setError(t('kyc.cameraDenied'));
        return;
      }
    }
    const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.8 };
    const picked =
      source === 'camera'
        ? await ImagePicker.launchCameraAsync(options)
        : await ImagePicker.launchImageLibraryAsync(options);
    const asset = picked.canceled ? undefined : picked.assets[0];
    if (asset === undefined) return;

    const checked = checkPicked(asset, slot.kind);
    if (!checked.ok) {
      setError(checked.reason);
      return;
    }
    setBusy(slot.kind);
    try {
      const bytes = await (await fetch(asset.uri)).blob();
      await api.putBytes(`/kyc/documents/${slot.kind.toLowerCase()}`, bytes, {
        contentType: checked.contentType,
        filename: checked.filename,
      });
      await onChanged();
    } catch (caught) {
      say(caught, t('kyc.sendFailed', { document: words('kyc.kind', slot.kind, t) }));
    } finally {
      setBusy(null);
    }
  };

  const submit = async () => {
    setError(null);
    setBusy('submit');
    try {
      await api.post('/kyc/submit', {}, { idempotencyKey: `kyc-submit:${Date.now()}` });
      await onChanged();
    } catch (caught) {
      say(caught, t('kyc.submitFailed'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title={t('kyc.title')}>
      <Figure label={t('kyc.status')} value={words('kyc.status', view.status, t)} />
      {view.reason === null ? null : <Text style={styles.warning}>{view.reason}</Text>}
      {view.expiresAt === null ? null : (
        <Figure label={t('kyc.validUntil')} value={new Date(view.expiresAt).toLocaleDateString()} />
      )}
      {error === null ? null : <ErrorNote message={error} />}
      {slots.length === 0 ? null : (
        <>
          <Text style={styles.note}>{t('kyc.intro')}</Text>
          {slots.map((slot) => (
            <View key={slot.kind} style={styles.slot}>
              <View style={styles.slotHead}>
                <Text style={styles.slotTitle}>{words('kyc.kind', slot.kind, t)}</Text>
                <Text style={slot.sent ? styles.sent : styles.notSent}>
                  {slot.sent ? t('kyc.sent') : t('kyc.notSent')}
                </Text>
              </View>
              <View style={styles.actions}>
                <View style={styles.action}>
                  <Button
                    label={t('kyc.takePhoto')}
                    variant="quiet"
                    busy={busy === slot.kind}
                    disabled={busy !== null}
                    onPress={() => void send(slot, 'camera')}
                  />
                </View>
                <View style={styles.action}>
                  <Button
                    label={t('kyc.choosePhoto')}
                    variant="quiet"
                    disabled={busy !== null}
                    onPress={() => void send(slot, 'library')}
                  />
                </View>
              </View>
            </View>
          ))}
          {view.missing.length > 0 ? (
            <Text style={styles.note}>
              {t('kyc.stillNeeded', {
                list: view.missing.map((kind) => words('kyc.kind', kind, t)).join(t('levels.and')),
              })}
            </Text>
          ) : null}
          <Button
            label={t('kyc.submit')}
            busy={busy === 'submit'}
            disabled={!canSubmitNow(view) || busy !== null}
            onPress={() => void submit()}
          />
        </>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  warning: { color: theme.colors.warning, fontSize: 13, marginTop: theme.spacing(0.5) },
  note: { color: theme.colors.textMuted, fontSize: 13, marginVertical: theme.spacing(0.75) },
  slot: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    paddingVertical: theme.spacing(1),
  },
  slotHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  slotTitle: { color: theme.colors.text, fontSize: 15, flexShrink: 1 },
  sent: { color: theme.colors.positive, fontSize: 13 },
  notSent: { color: theme.colors.textMuted, fontSize: 13 },
  actions: { flexDirection: 'row', gap: theme.spacing(1), marginTop: theme.spacing(0.75) },
  action: { flex: 1 },
});
