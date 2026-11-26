import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '../components/icons';
import { Button, ErrorNote, Segmented } from '../components/ui';
import { useT } from '../lib/i18n';
import { brandName, useBranding } from '../lib/branding';
import { useSession } from '../lib/session';
import { signInErrorText } from '../lib/sign-in-error';
import { apiBaseUrl } from '../lib/api';
import { theme } from '../lib/theme';

/**
 * Signing in, and opening an account.
 *
 * Registration is the server's own — `POST /auth/register` — and leaves the
 * person to sign in: the server sends the address a confirmation link, and
 * nothing here pretends the address is confirmed. A platform open by
 * invitation asks for its code; the field is offered, never required here,
 * because only the server knows which kind of platform it is.
 */
export default function Login(): React.ReactElement {
  const t = useT();
  const { api, signIn, completeTwoFactor } = useSession();
  const branding = useBranding(api);
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [mode, setMode] = useState<'signIn' | 'register' | 'forgot'>('signIn');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const attempt = async (run: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await run();
    } catch (caught) {
      // The server's message when it answered; otherwise what went wrong.
      setError(signInErrorText(caught, t, apiHost()));
    } finally {
      setBusy(false);
    }
  };

  const field = (
    value: string,
    onChange: (value: string) => void,
    label: string,
    extra: Partial<React.ComponentProps<typeof TextInput>> = {},
  ) => (
    <TextInput
      style={styles.input}
      value={value}
      onChangeText={onChange}
      accessibilityLabel={label}
      placeholder={label}
      placeholderTextColor={theme.colors.textFaint}
      {...extra}
    />
  );

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: theme.colors.background }}
    >
      {/* Light behind the mark: two washes of the accent, decoration only. */}
      <View pointerEvents="none" style={styles.glowA} />
      <View pointerEvents="none" style={styles.glowB} />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + theme.spacing(2) }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.brand}>
          <View style={styles.logoRing}>
            <View style={styles.logo}>
              <Icon name="chart" color="#FFFFFF" size={32} />
            </View>
          </View>
          <Text style={styles.title}>{brandName(branding, t('app.name'))}</Text>
          <Text style={styles.subtitle}>{t('login.welcome')}</Text>
          <View style={styles.features}>
            {(
              [
                ['quotes', 'login.feature.prices'],
                ['shield', 'login.feature.secure'],
                ['trade', 'login.feature.fast'],
              ] as const
            ).map(([icon, key]) => (
              <View key={key} style={styles.feature}>
                <Icon name={icon} color={theme.colors.accent} size={16} />
                <Text style={styles.featureText}>{t(key)}</Text>
              </View>
            ))}
          </View>
        </View>

        {challengeToken !== null ? (
          <View style={styles.card}>
            <Text style={styles.heading}>{t('login.twoFactor')}</Text>
            <Text style={styles.hint}>{t('login.twoFactorHint')}</Text>
            {error === null ? null : <ErrorNote message={error} />}
            {field(code, setCode, t('login.twoFactor'), {
              keyboardType: 'number-pad',
              maxLength: 8,
              autoFocus: true,
              placeholder: '000000',
              style: [styles.input, styles.code],
            })}
            <Button
              label={t('login.verify')}
              busy={busy}
              disabled={code.length < 6}
              onPress={() => {
                void attempt(async () => {
                  await completeTwoFactor(challengeToken, code);
                  router.replace('/(tabs)/market');
                });
              }}
            />
            <Button
              label={t('common.cancel')}
              variant="quiet"
              onPress={() => {
                setChallengeToken(null);
                setCode('');
              }}
            />
          </View>
        ) : (
          <View style={styles.card}>
            <Segmented
              value={mode === 'forgot' ? 'signIn' : mode}
              onChange={(next) => {
                setMode(next);
                setError(null);
                setNotice(null);
              }}
              options={[
                { value: 'signIn', label: t('login.signIn') },
                { value: 'register', label: t('login.register') },
              ]}
            />
            <View style={{ height: theme.spacing(2) }} />
            {notice === null ? null : (
              <View style={styles.notice}>
                <Text style={styles.noticeText}>{notice}</Text>
              </View>
            )}
            {error === null ? null : <ErrorNote message={error} />}
            {mode === 'register'
              ? field(name, setName, t('login.name'), { autoComplete: 'name' })
              : null}
            {field(email, setEmail, t('login.email'), {
              autoCapitalize: 'none',
              autoComplete: 'email',
              keyboardType: 'email-address',
              textContentType: 'emailAddress',
            })}
            {mode === 'forgot'
              ? null
              : field(password, setPassword, t('login.password'), {
                  secureTextEntry: true,
                  autoComplete: mode === 'register' ? 'new-password' : 'current-password',
                })}
            {mode === 'register' ? (
              <>
                <Text
                  style={[
                    styles.hint,
                    styles.rule,
                    password.length > 0 && password.length < 12 ? styles.ruleShort : null,
                  ]}
                >
                  {t('login.passwordRule')}
                  {password.length > 0 ? `  ·  ${password.length}/12` : ''}
                </Text>
                {field(inviteCode, setInviteCode, t('login.inviteCode'), {
                  autoCapitalize: 'none',
                  autoCorrect: false,
                })}
                <Text style={[styles.hint, styles.rule]}>{t('login.inviteHint')}</Text>
              </>
            ) : null}
            <Button
              label={
                mode === 'register'
                  ? t('login.register')
                  : mode === 'forgot'
                    ? t('login.sendReset')
                    : t('login.signIn')
              }
              busy={busy}
              disabled={
                email.trim() === '' ||
                (mode !== 'forgot' && password === '') ||
                (mode === 'register' && (name.trim() === '' || password.length < 12))
              }
              onPress={() => {
                void attempt(async () => {
                  if (mode === 'forgot') {
                    await api.post(
                      '/auth/password-reset',
                      { email: email.trim() },
                      { idempotencyKey: `reset:${email.trim()}:${Date.now()}` },
                    );
                    // The same words whether or not the address is registered.
                    setNotice(t('login.forgotSent', { email: email.trim() }));
                    setMode('signIn');
                    return;
                  }
                  if (mode === 'register') {
                    await api.post(
                      '/auth/register',
                      {
                        email: email.trim(),
                        password,
                        displayName: name.trim(),
                        // Sent only when typed: on an open platform an empty
                        // code is no code.
                        ...(inviteCode.trim() === '' ? {} : { inviteCode: inviteCode.trim() }),
                      },
                      { idempotencyKey: `register:${email.trim()}:${Date.now()}` },
                    );
                    setNotice(t('login.registered', { email: email.trim() }));
                    setMode('signIn');
                    return;
                  }
                  const result = await signIn(email.trim(), password);
                  if (result.twoFactorRequired) {
                    // The challenge travels back on the response and is
                    // single-use; it belongs to this screen's flow.
                    setChallengeToken(result.challengeToken);
                    return;
                  }
                  router.replace('/(tabs)/market');
                });
              }}
            />
            {mode === 'register' ? null : (
              <Button
                label={mode === 'forgot' ? t('login.backToSignIn') : t('login.forgot')}
                variant="quiet"
                onPress={() => {
                  setMode(mode === 'forgot' ? 'signIn' : 'forgot');
                  setError(null);
                  setNotice(null);
                }}
              />
            )}
          </View>
        )}
        {branding?.supportEmail === null || branding?.supportEmail === undefined ? null : (
          <Text style={styles.support}>{t('login.help', { email: branding.supportEmail })}</Text>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  content: { padding: theme.spacing(2.5), paddingBottom: theme.spacing(6) },
  brand: { alignItems: 'center', marginTop: theme.spacing(6), marginBottom: theme.spacing(3.5) },
  glowA: {
    position: 'absolute',
    top: -220,
    alignSelf: 'center',
    width: 520,
    height: 520,
    borderRadius: 260,
    backgroundColor: 'rgba(59, 130, 246, 0.07)',
  },
  glowB: {
    position: 'absolute',
    top: -120,
    alignSelf: 'center',
    width: 320,
    height: 320,
    borderRadius: 160,
    backgroundColor: 'rgba(59, 130, 246, 0.07)',
  },
  logoRing: {
    padding: 6,
    borderRadius: 28,
    backgroundColor: theme.colors.accentTint,
    marginBottom: theme.spacing(2.5),
  },
  logo: {
    width: 72,
    height: 72,
    borderRadius: 22,
    backgroundColor: theme.colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontFamily: theme.font.heavy,
    color: theme.colors.text,
    fontSize: 28,
    letterSpacing: 0.2,
  },
  subtitle: {
    fontFamily: theme.font.regular,
    color: theme.colors.textMuted,
    fontSize: 15,
    marginTop: theme.spacing(0.75),
    textAlign: 'center',
  },
  features: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: theme.spacing(1),
    marginTop: theme.spacing(2.5),
  },
  feature: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: theme.colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  featureText: { fontFamily: theme.font.semibold, color: theme.colors.textMuted, fontSize: 12 },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    padding: theme.spacing(2),
  },
  heading: { fontFamily: theme.font.bold, color: theme.colors.text, fontSize: 18, marginBottom: 6 },
  hint: {
    fontFamily: theme.font.regular,
    color: theme.colors.textMuted,
    fontSize: 12,
    marginBottom: theme.spacing(1),
  },
  rule: { marginTop: -theme.spacing(0.75), marginBottom: theme.spacing(1.5) },
  ruleShort: { color: theme.colors.warning },
  input: {
    fontFamily: theme.font.regular,
    backgroundColor: theme.colors.surfaceSunken,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    color: theme.colors.text,
    fontSize: 16,
    minHeight: 50,
    paddingHorizontal: theme.spacing(1.5),
    marginBottom: theme.spacing(1.5),
  },
  code: { fontFamily: theme.font.mono, textAlign: 'center', letterSpacing: 8, fontSize: 22 },
  notice: {
    backgroundColor: 'rgba(22, 199, 132, 0.12)',
    borderRadius: theme.radius.sm,
    padding: theme.spacing(1.5),
    marginBottom: theme.spacing(1.5),
  },
  noticeText: { fontFamily: theme.font.regular, color: theme.colors.positive, fontSize: 14 },
  support: {
    fontFamily: theme.font.regular,
    color: theme.colors.textMuted,
    fontSize: 12,
    textAlign: 'center',
    marginTop: theme.spacing(2),
  },
});

/** The host the app talks to, for an error that says which one it could not reach. */
function apiHost(): string | undefined {
  // Parsed by hand: React Native's URL leaves `host` unimplemented.
  try {
    return /^[a-z]+:\/\/([^/?#]+)/i.exec(apiBaseUrl())?.[1];
  } catch {
    return undefined;
  }
}
