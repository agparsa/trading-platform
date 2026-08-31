import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { DomainError } from '@tp/shared-types';
import { useSession } from '../lib/session';
import { Button, ErrorNote, Screen } from '../components/ui';
import { theme } from '../lib/theme';

export default function Login(): React.ReactElement {
  const { signIn, completeTwoFactor } = useSession();
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const attempt = async (run: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await run();
    } catch (caught) {
      /**
       * The server's message, not a generic one.
       *
       * "Too many attempts, try again in 15 minutes" is actionable; "Sign-in
       * failed" is not, and a trader locked out of a moving position deserves
       * to know which of the two is happening.
       */
      setError(
        caught instanceof DomainError ? caught.message : 'Could not reach the server. Try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  if (challengeId !== null) {
    return (
      <Screen>
        <Text style={styles.heading}>Two-factor code</Text>
        <Text style={styles.hint}>Enter the six-digit code from your authenticator app.</Text>
        {error === null ? null : <ErrorNote message={error} />}
        <TextInput
          style={styles.input}
          value={code}
          onChangeText={setCode}
          keyboardType="number-pad"
          maxLength={8}
          autoFocus
          accessibilityLabel="Two-factor code"
          placeholderTextColor={theme.colors.textMuted}
          placeholder="000000"
        />
        <Button
          label="Verify"
          busy={busy}
          disabled={code.length < 6}
          onPress={() => {
            void attempt(async () => {
              await completeTwoFactor(challengeId, code);
              router.replace('/(tabs)');
            });
          }}
        />
      </Screen>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}
    >
      <Screen>
        <Text style={styles.heading}>Sign in</Text>
        {error === null ? null : <ErrorNote message={error} />}
        <View>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            accessibilityLabel="Email"
            placeholder="you@example.com"
            placeholderTextColor={theme.colors.textMuted}
          />
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="current-password"
            accessibilityLabel="Password"
            placeholder="Password"
            placeholderTextColor={theme.colors.textMuted}
          />
        </View>
        <Button
          label="Sign in"
          busy={busy}
          disabled={email.length === 0 || password.length === 0}
          onPress={() => {
            void attempt(async () => {
              const result = await signIn(email, password);
              if (result.twoFactorRequired) {
                // The challenge id travels back on the response; the session
                // provider does not keep it, because it is single-use and
                // belongs to this screen's flow.
                setChallengeId('pending');
                return;
              }
              router.replace('/(tabs)');
            });
          }}
        />
      </Screen>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  heading: {
    color: theme.colors.text,
    fontSize: 28,
    fontWeight: '700',
    marginBottom: theme.spacing(2),
  },
  hint: { color: theme.colors.textMuted, marginBottom: theme.spacing(2) },
  input: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    color: theme.colors.text,
    fontSize: 16,
    minHeight: 48,
    paddingHorizontal: theme.spacing(1.5),
    marginBottom: theme.spacing(1.5),
  },
});
