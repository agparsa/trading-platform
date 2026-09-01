import React, { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { DomainError } from '@tp/shared-types';
import { useSession } from '../../lib/session';
import { Button, Card, Empty, ErrorNote, Figure, Screen } from '../../components/ui';
import { theme } from '../../lib/theme';

interface Profile {
  id: string;
  email: string;
  displayName: string;
  role: string;
  emailVerified: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

interface KycSummary {
  status: string;
  reason: string | null;
  verified: boolean;
  expiresAt: string | null;
  missing: string[];
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
 * ## Verification
 *
 * §17 of the specification wants verification states on this screen. Until
 * phase 6 there was no KYC anywhere in the platform and this screen said so
 * rather than invent a status. There is one now — a record, a review queue, a
 * decision with a name against it — and the status shown here is that record's.
 *
 * What this screen does *not* do is take documents. Uploading a photograph of
 * a passport needs the camera and the file picker, which are native modules
 * this build does not carry, and a button that opened nothing would be worse
 * than the sentence that sends people to the web. When the modules are added
 * the endpoint is the same one: `PUT /kyc/documents/:kind`, bytes as the body.
 */
const KYC_LABELS: Record<string, string> = {
  NOT_STARTED: 'Not started',
  PENDING: 'Submitted, waiting for review',
  UNDER_REVIEW: 'Being reviewed',
  VERIFIED: 'Verified',
  REJECTED: 'Not accepted',
  EXPIRED: 'Expired',
};

export default function ProfileScreen(): React.ReactElement {
  const { api, signOut } = useSession();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [totp, setTotp] = useState<TotpStatus | null>(null);
  const [kyc, setKyc] = useState<KycSummary | null>(null);
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
        api.get<KycSummary>('/kyc').catch(() => null),
      ]);
      setProfile(me);
      setTotp(twoFactor);
      setKyc(verification);
      setSessions(sessionList);
      setDevices(deviceList);
      setError(null);
    } catch {
      setError('Could not load your profile.');
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
      setError(caught instanceof DomainError ? caught.message : 'The session was not ended.');
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
      setError(caught instanceof DomainError ? caught.message : 'The device was not removed.');
    } finally {
      setBusy(null);
    }
  };

  if (profile === null) {
    return (
      <Screen>
        {error === null ? null : <ErrorNote message={error} />}
        <Empty message="Loading…" />
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

        <Card title="You">
          <Figure label="Name" value={profile.displayName} />
          <Figure label="Email" value={profile.email} />
          <Figure label="Email verified" value={profile.emailVerified ? 'Yes' : 'No'} />
          <Figure label="Role" value={profile.role} />
          <Figure
            label="Last signed in"
            value={
              profile.lastLoginAt === null ? '—' : new Date(profile.lastLoginAt).toLocaleString()
            }
          />
        </Card>

        {kyc === null ? null : (
          <Card title="Identity verification">
            <Figure label="Status" value={KYC_LABELS[kyc.status] ?? kyc.status} />
            {kyc.reason === null ? null : <Text style={styles.warning}>{kyc.reason}</Text>}
            {kyc.expiresAt === null ? null : (
              <Figure label="Valid until" value={new Date(kyc.expiresAt).toLocaleDateString()} />
            )}
            {kyc.missing.length > 0 ? (
              <Text style={styles.note}>
                To verify, sign in on the web and add {kyc.missing.join(' and ')}. Uploading from
                this app is not available yet.
              </Text>
            ) : null}
          </Card>
        )}

        <Card title="Two-factor authentication">
          <Figure label="Status" value={totp?.enabled === true ? 'On' : 'Off'} />
          {totp?.pending === true ? (
            <Text style={styles.warning}>
              Enrolment was started and never completed. Until you enter a code, two-factor is off.
            </Text>
          ) : null}
          {totp?.enabled === true ? (
            <Figure label="Recovery codes left" value={String(totp.recoveryCodesRemaining)} />
          ) : null}
          {totp?.enabled === true && totp.recoveryCodesRemaining === 0 ? (
            <Text style={styles.warning}>
              No recovery codes remain. If you lose your authenticator you will not be able to sign
              in.
            </Text>
          ) : null}
          {/*
            Enrolment is deliberately not offered here. It shows a shared secret
            once and never again, and a screen that can display a secret is a
            screen that can be shoulder-surfed. It belongs on the web terminal,
            where it can be printed.
          */}
          <Text style={styles.note}>Set up or change two-factor from the web terminal.</Text>
        </Card>

        <Card title="Where you are signed in">
          {sessions.length === 0 ? (
            <Text style={styles.note}>No other sessions.</Text>
          ) : (
            sessions.map((session) => (
              <View key={session.id} style={styles.entry}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.entryTitle}>
                    {session.device}
                    {session.current ? ' · this device' : ''}
                  </Text>
                  <Text style={styles.entryDetail}>
                    {session.ipAddress ?? 'unknown address'} · last seen{' '}
                    {new Date(session.lastSeenAt).toLocaleString()}
                  </Text>
                </View>
                {session.current ? null : (
                  <Button
                    label="End"
                    variant="quiet"
                    busy={busy === session.id}
                    onPress={() => void revokeSession(session)}
                  />
                )}
              </View>
            ))
          )}
        </Card>

        <Card title="Devices receiving notifications">
          {devices.length === 0 ? (
            <Text style={styles.note}>No devices registered.</Text>
          ) : (
            devices.map((device) => (
              <View key={device.id} style={styles.entry}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.entryTitle}>
                    {device.model ?? device.platform}
                    {device.isActive ? '' : ' · removed'}
                  </Text>
                  <Text style={styles.entryDetail}>
                    {device.hasPushToken
                      ? `notifications on · ${device.pushTokenFingerprint ?? '????'}`
                      : 'notifications off'}
                    {device.pushTokenRejectedAt === null ? '' : ' · token rejected'}
                    {device.appVersion === null ? '' : ` · v${device.appVersion}`}
                  </Text>
                </View>
                {device.isActive ? (
                  <Button
                    label="Remove"
                    variant="quiet"
                    busy={busy === device.id}
                    onPress={() => void revokeDevice(device)}
                  />
                ) : null}
              </View>
            ))
          )}
        </Card>

        <Button label="Sign out" variant="danger" onPress={() => void signOut()} />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  entry: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: theme.spacing(0.75),
    gap: theme.spacing(1),
  },
  entryTitle: { color: theme.colors.text, fontSize: 15 },
  entryDetail: { color: theme.colors.textMuted, fontSize: 12 },
  warning: { color: theme.colors.warning, fontSize: 13, marginTop: theme.spacing(0.5) },
  note: { color: theme.colors.textMuted, fontSize: 13, marginTop: theme.spacing(0.5) },
});
