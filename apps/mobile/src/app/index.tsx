import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Redirect } from 'expo-router';
import { useSession } from '../lib/session';
import { theme } from '../lib/theme';

/**
 * Decides where to start.
 *
 * A splash rather than a flash of the login screen: the session is read from the
 * keychain asynchronously, and rendering login before that finishes shows a
 * signed-in trader a sign-in form for a fraction of a second every launch.
 */
export default function Index(): React.ReactElement {
  const { signedIn, loading } = useSession();

  if (loading) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.colors.background,
        }}
      >
        <ActivityIndicator color={theme.colors.accent} />
      </View>
    );
  }

  return <Redirect href={signedIn ? '/(tabs)' : '/login'} />;
}
