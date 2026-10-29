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

const KYC_LABELS: Record<string, string> = {
  NOT_STARTED: 'Not started',
  PENDING: 'Submitted, waiting for review',
  UNDER_REVIEW: 'Being reviewed',
  VERIFIED: 'Verified',
  REJECTED: 'Not accepted',
  EXPIRED: 'Expired',
};

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
  const { api } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const slots = documentSlots(view);

  const say = (caught: unknown, fallback: string) =>
    setError(isDomainError(caught) ? caught.message : fallback);

  const send = async (slot: DocumentSlot, source: 'camera' | 'library') => {
    setError(null);
    if (source === 'camera') {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        setError('The camera was not allowed. Choose a photo instead, or allow it in settings.');
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
      say(caught, `${slot.label} could not be sent. Try again.`);
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
      say(caught, 'The documents could not be submitted. Try again.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title="Identity verification">
      <Figure label="Status" value={KYC_LABELS[view.status] ?? view.status} />
      {view.reason === null ? null : <Text style={styles.warning}>{view.reason}</Text>}
      {view.expiresAt === null ? null : (
        <Figure label="Valid until" value={new Date(view.expiresAt).toLocaleDateString()} />
      )}
      {error === null ? null : <ErrorNote message={error} />}
      {slots.length === 0 ? null : (
        <>
          <Text style={styles.note}>
            Send one identity document and a photo of you holding it. Proof of address is optional.
          </Text>
          {slots.map((slot) => (
            <View key={slot.kind} style={styles.slot}>
              <View style={styles.slotHead}>
                <Text style={styles.slotTitle}>{slot.label}</Text>
                <Text style={slot.sent ? styles.sent : styles.notSent}>
                  {slot.sent ? 'Sent' : 'Not sent'}
                </Text>
              </View>
              <View style={styles.actions}>
                <View style={styles.action}>
                  <Button
                    label="Take photo"
                    variant="quiet"
                    busy={busy === slot.kind}
                    disabled={busy !== null}
                    onPress={() => void send(slot, 'camera')}
                  />
                </View>
                <View style={styles.action}>
                  <Button
                    label="Choose photo"
                    variant="quiet"
                    disabled={busy !== null}
                    onPress={() => void send(slot, 'library')}
                  />
                </View>
              </View>
            </View>
          ))}
          {view.missing.length > 0 ? (
            <Text style={styles.note}>Still needed: {view.missing.join(' and ')}.</Text>
          ) : null}
          <Button
            label="Submit for review"
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
