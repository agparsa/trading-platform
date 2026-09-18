import { AccountPicker } from '../../components/account-picker';
import { useAccounts } from '../../lib/accounts';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { DomainError, type OrderSide } from '@tp/shared-types';
import { useSession } from '../../lib/session';
import { useMobileTrading } from '../../lib/features';
import { Button, Card, ErrorNote, Figure, Screen } from '../../components/ui';
import { theme } from '../../lib/theme';

interface OrderPreview {
  symbol: string;
  side: OrderSide;
  volume: string;
  price: string;
  bid: string;
  ask: string;
  spread: string;
  notional: string;
  requiredMargin: string;
  estimatedCommission: string;
  accountCurrency: string;
  freeMarginBefore: string;
  freeMarginAfter: string;
  marginLevelAfter: string | null;
  wouldBeAccepted: boolean;
  violations: string[];
  warnings: string[];
}

/**
 * The order ticket.
 *
 * ## Every figure comes from the server
 *
 * §14 asks this screen to show estimated commission and margin before
 * submission, and none of it is computed here. `POST /orders/preview` runs the
 * same margin and commission functions the order itself will run, so what the
 * trader reads is what they will be charged — rather than a client-side
 * approximation in floating point that drifts from the engine and from the
 * other two clients.
 *
 * ## Two steps, always
 *
 * §43: dangerous actions require confirmation, and placing a trade is the most
 * dangerous thing in the app. The first press previews; the second commits. The
 * confirmation shows the *snapped* volume and the crossed price, because those
 * are what will actually happen and they are not always what was typed.
 */
export default function OrderTicket(): React.ReactElement {
  const { symbol } = useLocalSearchParams<{ symbol: string }>();
  const { api } = useSession();
  /**
   * The firm's `mobile_trading` flag, which this screen is the whole reason
   * exists. Refused out loud rather than by hiding the button: an action that
   * quietly stops being possible is worse than one that fails with a sentence.
   */
  const mobileTrading = useMobileTrading();
  const router = useRouter();

  // The account this ticket sends to — the one the app is on, not whichever
  // the server listed first. See lib/accounts.tsx.
  const { selected: account, error: accountError } = useAccounts();
  const [side, setSide] = useState<OrderSide>('BUY');
  const [volume, setVolume] = useState('0.10');
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [preview, setPreview] = useState<OrderPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const request = useMemo(
    () =>
      account === null
        ? null
        : {
            accountId: account.id,
            symbol: String(symbol),
            side,
            volume,
            stopLoss: stopLoss.length === 0 ? null : stopLoss,
            takeProfit: takeProfit.length === 0 ? null : takeProfit,
          },
    [account, symbol, side, volume, stopLoss, takeProfit],
  );

  const refreshPreview = useCallback(async () => {
    if (request === null) return;
    try {
      setPreview(
        await api.post<OrderPreview>('/orders/preview', request, {
          /**
           * Stable, and derived from the request itself.
           *
           * The preview route does not read the header — it writes nothing, so
           * there is nothing to make idempotent. The client's `post` requires
           * one regardless, which is the right default for a method that
           * usually mutates. A key that repeats for an identical request is at
           * least honest about what it means, where a random one would imply
           * these were different operations.
           */
          idempotencyKey: `preview:${request.symbol}:${request.side}:${request.volume}`,
        }),
      );
      setError(null);
    } catch (caught) {
      setPreview(null);
      setError(caught instanceof DomainError ? caught.message : 'Could not price that order.');
    }
  }, [api, request]);

  useEffect(() => {
    // Debounced: the ticket previews as the trader types, and a request per
    // keystroke would both hammer the server and race itself into showing the
    // figures for a volume that has since changed.
    const timer = setTimeout(() => void refreshPreview(), 300);
    return () => clearTimeout(timer);
  }, [refreshPreview]);

  const submit = async () => {
    if (request === null) return;
    // Checked here as well as on the button: a disabled control is a rendering,
    // and this is the line that actually posts.
    if (!mobileTrading.mayOpen) {
      setError(mobileTrading.reason);
      setConfirming(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post('/orders', request, {
        // One key per attempt, so a retry after a timeout cannot open a second
        // position — the server recognises the repeat and returns the first
        // result.
        idempotencyKey: `order:${account?.id}:${symbol}:${side}:${volume}:${Date.now()}`,
      });
      router.replace('/(tabs)/positions');
    } catch (caught) {
      setError(caught instanceof DomainError ? caught.message : 'The order was not placed.');
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <ScrollView keyboardShouldPersistTaps="handled">
        <Text style={styles.heading}>{String(symbol)}</Text>
        <AccountPicker />
        {error === null ? null : <ErrorNote message={error} />}
        {accountError === null ? null : <ErrorNote message={accountError} />}

        <View style={styles.sides}>
          <Button
            label={`Sell ${preview?.bid ?? ''}`}
            variant={side === 'SELL' ? 'danger' : 'quiet'}
            onPress={() => setSide('SELL')}
          />
          <View style={{ width: theme.spacing(1) }} />
          <Button
            label={`Buy ${preview?.ask ?? ''}`}
            variant={side === 'BUY' ? 'primary' : 'quiet'}
            onPress={() => setSide('BUY')}
          />
        </View>

        <Card title="Order">
          <Field label="Volume (lots)" value={volume} onChange={setVolume} keyboard="decimal-pad" />
          <Field
            label="Stop loss"
            value={stopLoss}
            onChange={setStopLoss}
            keyboard="decimal-pad"
            placeholder="optional"
          />
          <Field
            label="Take profit"
            value={takeProfit}
            onChange={setTakeProfit}
            keyboard="decimal-pad"
            placeholder="optional"
          />
        </Card>

        {preview === null ? null : (
          <Card title="Before you place it">
            <Figure label="Symbol" value={preview.symbol} />
            <Figure label="Side" value={preview.side} />
            {/* The snapped volume, not what was typed. They differ whenever the
                requested size is off the lot grid, and the ticket must show
                what will actually trade. */}
            <Figure label="Volume" value={preview.volume} />
            <Figure label="Price" value={preview.price} />
            <Figure label="Spread" value={preview.spread} />
            <Figure label="Notional" value={`${preview.notional} ${preview.accountCurrency}`} />
            <Figure
              label="Required margin"
              value={`${preview.requiredMargin} ${preview.accountCurrency}`}
            />
            <Figure
              label="Estimated commission"
              value={`${preview.estimatedCommission} ${preview.accountCurrency}`}
            />
            <Figure label="Free margin after" value={preview.freeMarginAfter} />
            <Figure label="Margin level after" value={preview.marginLevelAfter ?? '—'} />
          </Card>
        )}

        {preview !== null && (preview.warnings.length > 0 || preview.violations.length > 0) ? (
          <ErrorNote message={[...preview.warnings, ...preview.violations].join('\n')} />
        ) : null}

        {mobileTrading.mayOpen ? null : <ErrorNote message={mobileTrading.reason ?? ''} />}

        {confirming ? (
          <Card title="Confirm">
            <Text style={styles.confirm}>
              {preview === null
                ? 'Pricing…'
                : `${preview.side} ${preview.volume} ${preview.symbol} at ${preview.price}. ` +
                  `Margin ${preview.requiredMargin} ${preview.accountCurrency}, ` +
                  `commission ${preview.estimatedCommission} ${preview.accountCurrency}.`}
            </Text>
            <Button
              label="Place order"
              variant={side === 'SELL' ? 'danger' : 'primary'}
              busy={busy}
              disabled={preview === null || !preview.wouldBeAccepted || !mobileTrading.mayOpen}
              onPress={() => void submit()}
            />
            <Button label="Cancel" variant="quiet" onPress={() => setConfirming(false)} />
          </Card>
        ) : (
          <Button
            label="Review order"
            disabled={preview === null || !preview.wouldBeAccepted || !mobileTrading.mayOpen}
            onPress={() => setConfirming(true)}
          />
        )}
      </ScrollView>
    </Screen>
  );
}

function Field({
  label,
  value,
  onChange,
  keyboard,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  keyboard?: 'decimal-pad';
  placeholder?: string;
}): React.ReactElement {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        keyboardType={keyboard ?? 'default'}
        accessibilityLabel={label}
        placeholder={placeholder ?? ''}
        placeholderTextColor={theme.colors.textMuted}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  heading: {
    color: theme.colors.text,
    fontSize: 24,
    fontWeight: '700',
    marginBottom: theme.spacing(1),
  },
  sides: { flexDirection: 'row', marginBottom: theme.spacing(1) },
  field: { marginBottom: theme.spacing(1) },
  fieldLabel: { color: theme.colors.textMuted, fontSize: 13, marginBottom: theme.spacing(0.5) },
  input: {
    backgroundColor: theme.colors.surfaceRaised,
    borderRadius: theme.radius.sm,
    color: theme.colors.text,
    fontSize: 16,
    fontFamily: theme.font.mono,
    minHeight: 48,
    paddingHorizontal: theme.spacing(1.5),
  },
  confirm: { color: theme.colors.text, fontSize: 15, lineHeight: 22 },
});
