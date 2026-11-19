import React from 'react';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { ChartView } from '../../components/chart-view';
import { Button, Screen } from '../../components/ui';
import { useT } from '../../lib/i18n';

/** One instrument's chart, opened from anywhere that names it. */
export default function Chart(): React.ReactElement {
  const { symbol } = useLocalSearchParams<{ symbol: string }>();
  const router = useRouter();
  const t = useT();
  return (
    <Screen>
      <Stack.Screen options={{ title: String(symbol) }} />
      <ChartView symbol={String(symbol)} />
      <Button label={t('chart.trade')} onPress={() => router.push(`/trade/${String(symbol)}`)} />
    </Screen>
  );
}
