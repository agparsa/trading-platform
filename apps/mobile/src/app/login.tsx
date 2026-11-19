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
import { useSession } from '../lib/session';
import { signInErrorText } from '../lib/sign-in-error';
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
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [mode, setMode] = useState<'signIn' | 'register'>('signIn');
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
      setError(signInErrorText(caught, t));
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
      placeholderTextColor={theme.colors.textMuted}
      {...extra}
    />
  );

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: theme.colors.background }}
    >
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + theme.spacing(2) }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.brand}>
          <View style={styles.logo}>
            <Icon name="chart" color="#FFFFFF" size={30} />
          </View>
          <Text style={styles.title}>{t('app.name')}</Text>
          <Text style={styles.subtitle}>{t('login.welcome')}</Text>
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
              value={mode}
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
            {field(password, setPassword, t('login.password'), {
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
              label={mode === 'register' ? t('login.register') : t('login.signIn')}
              busy={busy}
              disabled={
                email.trim() === '' ||
                password === '' ||
                (mode === 'register' && (name.trim() === '' || password.length < 12))
              }
              onPress={() => {
                void attempt(async () => {
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
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  content: { padding: theme.spacing(2.5), paddingBottom: theme.spacing(6) },
  brand: { alignItems: 'center', marginTop: theme.spacing(7), marginBottom: theme.spacing(4) },
  logo: {
    width: 64,
    height: 64,
    borderRadius: 18,
    backgroundColor: theme.colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: theme.spacing(2),
  },
  title: { color: theme.colors.text, fontSize: 24, fontWeight: '800' },
  subtitle: { color: theme.colors.textMuted, fontSize: 14, marginTop: theme.spacing(0.75) },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    padding: theme.spacing(2),
  },
  heading: { color: theme.colors.text, fontSize: 18, fontWeight: '700', marginBottom: 6 },
  hint: { color: theme.colors.textMuted, fontSize: 12, marginBottom: theme.spacing(1) },
  rule: { marginTop: -theme.spacing(0.75), marginBottom: theme.spacing(1.5) },
  ruleShort: { color: theme.colors.warning },
  input: {
    backgroundColor: theme.colors.background,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    color: theme.colors.text,
    fontSize: 16,
    minHeight: 50,
    paddingHorizontal: theme.spacing(1.5),
    marginBottom: theme.spacing(1.5),
  },
  code: { textAlign: 'center', letterSpacing: 8, fontFamily: theme.font.mono, fontSize: 22 },
  notice: {
    backgroundColor: 'rgba(22, 199, 132, 0.12)',
    borderRadius: theme.radius.sm,
    padding: theme.spacing(1.5),
    marginBottom: theme.spacing(1.5),
  },
  noticeText: { color: theme.colors.positive, fontSize: 14 },
});
