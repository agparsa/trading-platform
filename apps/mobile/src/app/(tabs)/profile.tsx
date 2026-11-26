import React, { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSession } from '../../lib/session';
import { Button, Card, Empty, ErrorNote, Figure, Screen } from '../../components/ui';
import { KycCard } from '../../components/kyc-card';
import type { KycView } from '../../lib/kyc-upload';
import { theme } from '../../lib/theme';
import { refusalText } from '../../lib/messages';
import { useT } from '../../lib/i18n';

interface Profile {
  id: string;
  email: string;
  displayName: string;
  role: string;
  emailVerified: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

interface TotpStatus {
  enabled: boolean;
  enabledAt: string | null;
  pending: boolean;
  recoveryCodesRemaining: number;
}

/** A rotation family — one sign-in, however often its token has rotated. */
interface SessionSummary {
  id: string;
  device: string;
  ipAddress: string | null;
  signedInAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
}

interface DeviceSummary {
  id: string;
  platform: string;
  model: string | null;
  appVersion: string | null;
  hasPushToken: boolean;
  pushTokenFingerprint: string | null;
  pushTokenRejectedAt: string | null;
  isActive: boolean;
  lastSeenAt: string;
}

/**
 * Who you are, and what has access to your account.
 *
 * ## Why sessions and devices are on the same screen
 *
 * Because they answer one question — *is one of these not me?* — and a person
 * trying to answer it should not have to know that a sign-in and a push
 * registration are different records. Both are revocable from here, and
 * revoking either is immediate.
 *
 * The card used to be titled "Devices receiving notifications" and its button
 * said "Remove", which was the truth at the time and a trap: revoking a device
 * stopped its notifications and left it signed in. Somebody seeing a handset
 * they did not recognise and tapping the button would have believed they had
 * shut it out. Revoking a device now ends the sessions that device holds, so
 * the card is titled for access and the button says what it does.
 *
 * ## Verification
 *
 * §17 of the specification wants verification states on this screen. Until
 * phase 6 there was no KYC anywhere in the platform and this screen said so
 * rather than invent a status. There is one now — a record, a review queue, a
 * decision with a name against it — and the status shown here is that record's.
 *
 * Documents are taken here too (`components/kyc-card.tsx`): a photo of each,
 * from the camera or the library, sent to the same `PUT /kyc/documents/:kind`
 * the web uses, then submitted. Until 29 October this card sent people to the
 * web, because the build carried no camera or picker module.
 */

export default function ProfileScreen(): React.ReactElement {
  const t = useT();
  const { api, signOut } = useSession();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [totp, setTotp] = useState<TotpStatus | null>(null);
  const [kyc, setKyc] = useState<KycView | null>(null);
  const [resend, setResend] = useState<'idle' | 'busy' | 'sent'>('idle');
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [me, twoFactor, sessionList, deviceList, verification] = await Promise.all([
        api.get<Profile>('/users/me'),
        api.get<TotpStatus>('/auth/2fa'),
        api.get<SessionSummary[]>('/auth/sessions'),
        api.get<DeviceSummary[]>('/devices'),
        // Its own catch: a role without `kyc.read` must not lose the whole
        // profile over one refused row.
        api.get<KycView>('/kyc').catch(() => null),
      ]);
      setProfile(me);
      setTotp(twoFactor);
      setKyc(verification);
      setSessions(sessionList);
      setDevices(deviceList);
      setError(null);
    } catch {
      setError(t('profile.loadFailed'));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const revokeSession = async (session: SessionSummary) => {
    setBusy(session.id);
    setError(null);
    try {
      await api.delete(`/auth/sessions/${session.id}`, {
        idempotencyKey: `revoke-session:${session.id}`,
      });
      await load();
    } catch (caught) {
      setError(refusalText(caught, 'profile.endFailed', t));
    } finally {
      setBusy(null);
    }
  };

  const revokeDevice = async (device: DeviceSummary) => {
    setBusy(device.id);
    setError(null);
    try {
      await api.delete(`/devices/${device.id}`, { idempotencyKey: `revoke-device:${device.id}` });
      await load();
    } catch (caught) {
      setError(refusalText(caught, 'profile.revokeFailed', t));
    } finally {
      setBusy(null);
    }
  };

  if (profile === null) {
    return (
      <Screen>
        {error === null ? null : <ErrorNote message={error} />}
        <Empty message={t('common.loading')} />
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load().finally(() => setRefreshing(false));
            }}
          />
        }
      >
        {error === null ? null : <ErrorNote message={error} />}

        <Card title={t('profile.you')}>
          <Figure label={t('profile.name')} value={profile.displayName} />
          <Figure label={t('profile.email')} value={profile.email} />
          <Figure
            label={t('profile.verified')}
            value={profile.emailVerified ? t('common.yes') : t('common.no')}
          />
          {profile.emailVerified ? null : (
            <View style={styles.pending}>
              <Text style={styles.pendingText}>{t('profile.emailPending')}</Text>
              {resend === 'sent' ? (
                <Text style={styles.sentText}>{t('profile.resent')}</Text>
              ) : (
                <Button
                  label={t('profile.resend')}
                  variant="quiet"
                  busy={resend === 'busy'}
                  onPress={() => {
                    setResend('busy');
                    api
                      .post(
                        '/auth/verify-email/resend',
                        {},
                        {
                          idempotencyKey: `resend-verification:${Date.now()}`,
                        },
                      )
                      .then(() => setResend('sent'))
                      .catch((caught: unknown) => {
                        setResend('idle');
                        setError(caught instanceof Error ? caught.message : String(caught));
                      });
                  }}
                />
              )}
            </View>
          )}
          <Figure label={t('profile.role')} value={profile.role} />
          <Figure
            label={t('profile.lastSignIn')}
            value={
              profile.lastLoginAt === null ? '—' : new Date(profile.lastLoginAt).toLocaleString()
            }
          />
        </Card>

        {kyc === null ? null : <KycCard view={kyc} onChanged={load} />}

        <Card title={t('profile.twoFactor')}>
          <Figure
            label={t('profile.status')}
            value={totp?.enabled === true ? t('common.on') : t('common.off')}
          />
          {totp?.pending === true ? (
            <Text style={styles.warning}>{t('profile.pending')}</Text>
          ) : null}
          {totp?.enabled === true ? (
            <Figure label={t('profile.codesLeft')} value={String(totp.recoveryCodesRemaining)} />
          ) : null}
          {totp?.enabled === true && totp.recoveryCodesRemaining === 0 ? (
            <Text style={styles.warning}>{t('profile.noCodes')}</Text>
          ) : null}
          {/*
            Enrolment is deliberately not offered here. It shows a shared secret
            once and never again, and a screen that can display a secret is a
            screen that can be shoulder-surfed. It belongs on the web terminal,
            where it can be printed.
          */}
          <Text style={styles.note}>{t('profile.setUpOnWeb')}</Text>
        </Card>

        <Card title={t('profile.sessions')}>
          {sessions.length === 0 ? (
            <Text style={styles.note}>{t('profile.noSessions')}</Text>
          ) : (
            sessions.map((session) => (
              <View key={session.id} style={styles.entry}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.entryTitle}>
                    {session.device}
                    {session.current ? ` · ${t('profile.thisDevice')}` : ''}
                  </Text>
                  <Text style={styles.entryDetail}>
                    {session.ipAddress ?? t('profile.unknownAddress')} ·{' '}
                    {t('profile.lastSeen', { when: new Date(session.lastSeenAt).toLocaleString() })}
                  </Text>
                </View>
                {session.current ? null : (
                  <Button
                    label={t('profile.end')}
                    variant="quiet"
                    busy={busy === session.id}
                    onPress={() => void revokeSession(session)}
                  />
                )}
              </View>
            ))
          )}
        </Card>

        <Card title={t('profile.devices')}>
          {devices.length === 0 ? (
            <Text style={styles.note}>{t('profile.noDevices')}</Text>
          ) : (
            devices.map((device) => (
              <View key={device.id} style={styles.entry}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.entryTitle}>
                    {device.model ?? device.platform}
                    {device.isActive ? '' : ` · ${t('profile.removed')}`}
                  </Text>
                  <Text style={styles.entryDetail}>
                    {device.hasPushToken
                      ? t('profile.pushOn', { fingerprint: device.pushTokenFingerprint ?? '????' })
                      : t('profile.pushOff')}
                    {device.pushTokenRejectedAt === null ? '' : ` · ${t('profile.tokenRejected')}`}
                    {device.appVersion === null ? '' : ` · v${device.appVersion}`}
                  </Text>
                </View>
                {device.isActive ? (
                  <Button
                    label={t('profile.revoke')}
                    variant="quiet"
                    busy={busy === device.id}
                    onPress={() => void revokeDevice(device)}
                  />
                ) : null}
              </View>
            ))
          )}
        </Card>

        <Button label={t('common.signOut')} variant="danger" onPress={() => void signOut()} />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  pending: {
    marginTop: theme.spacing(1),
    padding: theme.spacing(1.5),
    borderRadius: theme.radius.sm,
    backgroundColor: 'rgba(240, 167, 10, 0.10)',
  },
  pendingText: {
    fontFamily: theme.font.regular,
    color: theme.colors.warning,
    fontSize: theme.type.small,
    marginBottom: theme.spacing(1),
  },
  sentText: {
    fontFamily: theme.font.regular,
    color: theme.colors.positive,
    fontSize: theme.type.small,
  },
  entry: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: theme.spacing(0.75),
    gap: theme.spacing(1),
  },
  entryTitle: {
    fontFamily: theme.font.regular,
    color: theme.colors.text,
    fontSize: theme.type.body,
  },
  entryDetail: {
    fontFamily: theme.font.regular,
    color: theme.colors.textMuted,
    fontSize: theme.type.label,
  },
  warning: {
    fontFamily: theme.font.regular,
    color: theme.colors.warning,
    fontSize: theme.type.small,
    marginTop: theme.spacing(0.5),
  },
  note: {
    fontFamily: theme.font.regular,
    color: theme.colors.textMuted,
    fontSize: theme.type.small,
    marginTop: theme.spacing(0.5),
  },
});
