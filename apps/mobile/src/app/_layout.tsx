import React from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SessionProvider } from '../lib/session';
import { AccountsProvider } from '../lib/accounts';
import { FeaturesProvider } from '../lib/features';
import { LiveProvider } from '../lib/live';
import { OneTapProvider } from '../lib/one-tap';
import { OneTapNotice } from '../components/one-tap';
import { LocaleProvider, useT } from '../lib/i18n';
import { useFonts } from 'expo-font';
import { View } from 'react-native';
import { FONT_FILES } from '../lib/fonts';
import { theme } from '../lib/theme';

export default function RootLayout(): React.ReactElement {
  // A dark screen for the instant the faces load, rather than a flash of the
  // system font. A face that fails to load falls back to the system's.
  const [fontsLoaded, fontsFailed] = useFonts(FONT_FILES);
  if (!fontsLoaded && fontsFailed === null) {
    return <View style={{ flex: 1, backgroundColor: theme.colors.background }} />;
  }
  return (
    <SafeAreaProvider>
      {/* Outermost after the safe area: every screen, the sign-in form
          included, speaks the chosen language and lays out in its direction. */}
      <LocaleProvider>
        <SessionProvider>
          {/* Inside the session, because the flags are the signed-in firm's. */}
          <FeaturesProvider>
            {/* Above the navigator: the ticket lives outside the tabs, and it
                must act on the same account the tabs are showing. */}
            <AccountsProvider>
              {/* One socket for every screen: the tabs and the ticket read it. */}
              <LiveProvider>
                {/* Under the socket and the account: a one-tap order goes to
                    the account on screen, and sounds like any other fill. */}
                <OneTapProvider>
                  <StatusBar style="light" />
                  <AppStack />
                  <OneTapNotice />
                </OneTapProvider>
              </LiveProvider>
            </AccountsProvider>
          </FeaturesProvider>
        </SessionProvider>
      </LocaleProvider>
    </SafeAreaProvider>
  );
}

function AppStack(): React.ReactElement {
  const t = useT();
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.background },
        headerTintColor: theme.colors.text,
        headerShadowVisible: false,
        headerTitleStyle: { fontFamily: theme.font.bold },
        contentStyle: { backgroundColor: theme.colors.background },
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="login" options={{ headerShown: false, title: t('screen.signIn') }} />
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      {/* The instrument screens name themselves once they know the symbol. */}
      <Stack.Screen name="chart/[symbol]" options={{ title: '' }} />
      <Stack.Screen name="trade/[symbol]" options={{ title: '' }} />
    </Stack>
  );
}
