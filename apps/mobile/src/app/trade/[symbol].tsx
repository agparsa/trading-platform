import { AccountPicker } from '../../components/account-picker';
import { useAccounts } from '../../lib/accounts';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { entrySideOf } from '@tp/financial-core';
import { priceFromPoints, stepLots } from '../../lib/level-points';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import type { OrderSide } from '@tp/shared-types';
import { useSession } from '../../lib/session';
import { useFeatures, useMobileTrading } from '../../lib/features';
import {
  offeredOrderKinds,
  offersTrailing,
  orderRequest,
  restingFieldsProblem,
  restingOrderRequest,
  restingSummary,
  type OrderKind,
} from '../../lib/order-request';
import { Button, Card, ErrorNote, Figure, Screen, Segmented } from '../../components/ui';
import { theme } from '../../lib/theme';
import { useT } from '../../lib/i18n';
import { refusalText } from '../../lib/messages';

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
 *
 * ## Market, or resting
 *
 * The same ticket places limit, stop and stop-limit orders through
 * `POST /orders/pending`. The preview is still today's market — that is what
 * it prices — and is labelled as such: a resting order holds no margin and is
 * checked again when it fires, so a preview that says "insufficient margin
 * now" does not stop one from being placed. Which side of the market each
 * price belongs on is the server's rule; its refusal is shown in its words.
 */
export default function OrderTicket(): React.ReactElement {
  const { symbol, side: askedSide } = useLocalSearchParams<{ symbol: string; side?: string }>();
  const t = useT();
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
  const [side, setSide] = useState<OrderSide>(askedSide === 'SELL' ? 'SELL' : 'BUY');
  const [volume, setVolume] = useState('0.10');
  const [typedStopLoss, setStopLoss] = useState('');
  const [typedTakeProfit, setTakeProfit] = useState('');
  /**
   * How the stop and target are typed: as prices, or as whole points from the
   * price the order opens at — the market's for a market order, the resting
   * price for one that waits.
   */
  const [levelUnit, setLevelUnit] = useState<'price' | 'points'>('price');
  const [stopPoints, setStopPoints] = useState('');
  const [takePoints, setTakePoints] = useState('');
  const [fromPoints, setFromPoints] = useState<{
    stopLoss: string | null;
    takeProfit: string | null;
    /** The price the points were measured from — shown, so the hint is true. */
    from: string | null;
  }>({
    stopLoss: null,
    takeProfit: null,
    from: null,
  });
  const [trailing, setTrailing] = useState('');
  const features = useFeatures();
  const trailingOffered = offersTrailing(features);
  const kinds = offeredOrderKinds(features);
  const [chosenKind, setKind] = useState<OrderKind>('MARKET');
  // A kind the firm has since switched off is not kept selected.
  const kind: OrderKind = kinds.includes(chosenKind) ? chosenKind : 'MARKET';
  const [restingPrice, setRestingPrice] = useState('');
  const [stopTrigger, setStopTrigger] = useState('');
  const [timeInForce, setTimeInForce] = useState<'GTC' | 'DAY'>('GTC');
  const [preview, setPreview] = useState<OrderPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  /**
   * Points resolved to prices when the points, the side or the order's own
   * price change — not on every quote. Re-resolving on each tick would change
   * the request each tick, and the preview below would become a poll. The
   * price used is shown beside the field, and the server checks the level it
   * receives as it checks every level.
   */
  const reference =
    kind === 'MARKET'
      ? preview === null
        ? null
        : preview[entrySideOf(side)]
      : restingPrice.trim() === ''
        ? null
        : restingPrice.trim();
  const referenceRef = useRef(reference);
  referenceRef.current = reference;
  /**
   * The instrument's own price precision, asked of the server. Not inferred
   * from a price string: the server writes 4584.40 as "4584.4", and counting
   * its decimals made 500 points on gold 50.0 instead of 5.00.
   */
  const [decimals, setDecimals] = useState<number | null>(null);
  /** The lot grid, for the stepper; the server checks the volume either way. */
  const [step, setStep] = useState<{ step: string; min: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api
      .get<{ pricePrecision: number; volumeStep: string; minVolume: string }>(
        `/symbols/${String(symbol)}`,
      )
      .then((row) => {
        if (cancelled) return;
        setDecimals(row.pricePrecision);
        setStep({ step: row.volumeStep, min: row.minVolume });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, symbol]);
  const haveReference = reference !== null && decimals !== null;
  useEffect(() => {
    const from = decimals === null ? null : referenceRef.current;
    const places = decimals ?? 0;
    setFromPoints({
      stopLoss: priceFromPoints(stopPoints, from, places, side, 'STOP_LOSS'),
      takeProfit: priceFromPoints(takePoints, from, places, side, 'TAKE_PROFIT'),
      from,
    });
  }, [stopPoints, takePoints, side, kind, restingPrice, haveReference, decimals]);
  const stopLoss = levelUnit === 'points' ? (fromPoints.stopLoss ?? '') : typedStopLoss;
  const takeProfit = levelUnit === 'points' ? (fromPoints.takeProfit ?? '') : typedTakeProfit;

  const request = useMemo(
    () =>
      account === null
        ? null
        : orderRequest({
            accountId: account.id,
            symbol: String(symbol),
            side,
            volume,
            stopLoss,
            takeProfit,
            // A trail the firm has switched off is not sent even if one was
            // typed before the flags arrived; the field is gone from view.
            trailingDistance: trailingOffered ? trailing : '',
          }),
    [account, symbol, side, volume, stopLoss, takeProfit, trailing, trailingOffered],
  );

  const resting = useMemo(
    () =>
      request === null || kind === 'MARKET'
        ? null
        : restingOrderRequest({
            accountId: request.accountId,
            symbol: request.symbol,
            side,
            volume,
            stopLoss,
            takeProfit,
            trailingDistance: trailingOffered ? trailing : '',
            kind,
            price: restingPrice,
            stopPrice: stopTrigger,
            timeInForce,
          }),
    [
      request,
      kind,
      side,
      volume,
      stopLoss,
      takeProfit,
      trailing,
      trailingOffered,
      restingPrice,
      stopTrigger,
      timeInForce,
    ],
  );
  const restingProblem = restingFieldsProblem(kind, restingPrice, stopTrigger, t);
  /**
   * Whether the ticket may go to review. A market order needs the preview's
   * yes; a resting one needs its prices, and a preview at all (no price means
   * the market is shut, where the server refuses it anyway) — not the
   * preview's verdict on margin today.
   */
  const reviewable =
    preview !== null &&
    mobileTrading.mayOpen &&
    (kind === 'MARKET' ? preview.wouldBeAccepted : restingProblem === null);

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
      setError(refusalText(caught, 'ticket.priceFailed', t));
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
      if (resting !== null) {
        await api.post('/orders/pending', resting, {
          idempotencyKey: `pending:${account?.id}:${symbol}:${side}:${resting.type}:${Date.now()}`,
        });
        router.replace('/(tabs)/trade');
        return;
      }
      await api.post('/orders', request, {
        // One key per attempt, so a retry after a timeout cannot open a second
        // position — the server recognises the repeat and returns the first
        // result.
        idempotencyKey: `order:${account?.id}:${symbol}:${side}:${volume}:${Date.now()}`,
      });
      router.replace('/(tabs)/trade');
    } catch (caught) {
      setError(refusalText(caught, 'ticket.placeFailed', t));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <ScrollView keyboardShouldPersistTaps="handled">
        <Stack.Screen options={{ title: t('screen.ticket', { symbol: String(symbol) }) }} />
        <AccountPicker />
        {error === null ? null : <ErrorNote message={error} />}
        {accountError === null ? null : <ErrorNote message={accountError} />}

        {/* Sell at the bid on the left, buy at the ask on the right — the
            ladder every terminal shares. The chosen side fills. */}
        <View style={styles.sides}>
          {(['SELL', 'BUY'] as const).map((value) => {
            const chosen = side === value;
            const buy = value === 'BUY';
            const price = preview === null ? null : preview[entrySideOf(value)];
            return (
              <Pressable
                key={value}
                accessibilityRole="button"
                accessibilityState={{ selected: chosen }}
                accessibilityLabel={`${buy ? t('common.buy') : t('common.sell')} ${price ?? ''}`}
                onPress={() => setSide(value)}
                style={[
                  styles.sideTile,
                  {
                    backgroundColor: chosen
                      ? buy
                        ? theme.colors.positive
                        : theme.colors.negative
                      : buy
                        ? theme.colors.buyTint
                        : theme.colors.sellTint,
                    borderColor: buy ? theme.colors.positive : theme.colors.negative,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.sideLabel,
                    {
                      color: chosen
                        ? '#FFFFFF'
                        : buy
                          ? theme.colors.positive
                          : theme.colors.negative,
                    },
                  ]}
                >
                  {buy ? t('common.BUY') : t('common.SELL')}
                </Text>
                <Text
                  style={[styles.sidePrice, { color: chosen ? '#FFFFFF' : theme.colors.text }]}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                >
                  {price ?? '—'}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.block}>
          <Segmented
            value={kind}
            onChange={(value) => {
              setKind(value);
              setConfirming(false);
            }}
            options={kinds.map((value) => ({ value, label: t(`orders.kind.${value}`) }))}
          />
        </View>

        <Card title={t('ticket.order')}>
          <Text style={styles.fieldLabel}>{t('ticket.volume')}</Text>
          <View style={styles.stepper}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('ticket.decrease')}
              onPress={() => setVolume((current) => stepLots(current, step, -1))}
              style={styles.stepButton}
            >
              <Text style={styles.stepGlyph}>−</Text>
            </Pressable>
            <TextInput
              style={styles.stepInput}
              value={volume}
              onChangeText={setVolume}
              keyboardType="decimal-pad"
              accessibilityLabel={t('ticket.volume')}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('ticket.increase')}
              onPress={() => setVolume((current) => stepLots(current, step, 1))}
              style={styles.stepButton}
            >
              <Text style={styles.stepGlyph}>+</Text>
            </Pressable>
          </View>
          {kind === 'STOP_LIMIT' ? (
            <Field
              label={t('ticket.stopActivates')}
              value={stopTrigger}
              onChange={setStopTrigger}
              keyboard="decimal-pad"
              placeholder={side === 'BUY' ? t('ticket.aboveAsk') : t('ticket.belowBid')}
            />
          ) : null}
          {kind === 'MARKET' ? null : (
            <Field
              label={kind === 'STOP' ? t('orders.stopPrice') : t('orders.limitPrice')}
              value={restingPrice}
              onChange={setRestingPrice}
              keyboard="decimal-pad"
              placeholder={
                kind === 'STOP_LIMIT'
                  ? t('ticket.fillsHere')
                  : kind === 'LIMIT'
                    ? side === 'BUY'
                      ? t('ticket.belowAsk')
                      : t('ticket.aboveBid')
                    : side === 'BUY'
                      ? t('ticket.aboveAsk')
                      : t('ticket.belowBid')
              }
            />
          )}
          {kind === 'MARKET' ? null : (
            <View style={styles.sides}>
              {(['GTC', 'DAY'] as const).map((value) => (
                <View key={value} style={styles.kind}>
                  <Button
                    label={value === 'GTC' ? t('ticket.gtc') : t('ticket.day')}
                    variant={value === timeInForce ? 'primary' : 'quiet'}
                    onPress={() => setTimeInForce(value)}
                  />
                </View>
              ))}
            </View>
          )}
          <View style={styles.block}>
            <Segmented
              value={levelUnit}
              onChange={setLevelUnit}
              options={[
                { value: 'price', label: t('ticket.unitPrice') },
                { value: 'points', label: t('ticket.unitPoints') },
              ]}
            />
          </View>
          {levelUnit === 'price' ? (
            <>
              <Field
                label={t('positions.stopLoss')}
                value={typedStopLoss}
                onChange={setStopLoss}
                keyboard="decimal-pad"
                placeholder={t('common.optional')}
              />
              <Field
                label={t('positions.takeProfit')}
                value={typedTakeProfit}
                onChange={setTakeProfit}
                keyboard="decimal-pad"
                placeholder={t('common.optional')}
              />
            </>
          ) : (
            <>
              <Field
                label={`${t('positions.stopLoss')} (${t('ticket.unitPoints')})`}
                value={stopPoints}
                onChange={setStopPoints}
                keyboard="decimal-pad"
                placeholder={t('common.optional')}
                hint={pointsHint(stopPoints, fromPoints.stopLoss, fromPoints.from, t)}
                tone="loss"
              />
              <Field
                label={`${t('positions.takeProfit')} (${t('ticket.unitPoints')})`}
                value={takePoints}
                onChange={setTakePoints}
                keyboard="decimal-pad"
                placeholder={t('common.optional')}
                hint={pointsHint(takePoints, fromPoints.takeProfit, fromPoints.from, t)}
                tone="profit"
              />
            </>
          )}
          {/*
            A trail from the fill onward, in price units: the stop follows the
            best exit price seen at this distance and never moves back. The
            position opens already trailing. Hidden when the firm switched
            trailing off; the server refuses one either way.
          */}
          {trailingOffered ? (
            <Field
              label={t('ticket.trailing')}
              value={trailing}
              onChange={setTrailing}
              keyboard="decimal-pad"
              placeholder={t('common.optional')}
            />
          ) : null}
        </Card>

        {preview === null ? null : (
          <Card title={kind === 'MARKET' ? t('ticket.before') : t('ticket.atMarket')}>
            <Figure label={t('ticket.symbol')} value={preview.symbol} />
            <Figure
              label={t('ticket.side')}
              value={t(preview.side === 'BUY' ? 'common.BUY' : 'common.SELL')}
            />
            {/* The snapped volume, not what was typed. They differ whenever the
                requested size is off the lot grid, and the ticket must show
                what will actually trade. */}
            <Figure label={t('orders.volume')} value={preview.volume} />
            <Figure label={t('ticket.price')} value={preview.price} />
            <Figure label={t('ticket.spread')} value={preview.spread} />
            <Figure
              label={t('ticket.notional')}
              value={`${preview.notional} ${preview.accountCurrency}`}
            />
            <Figure
              label={t('ticket.margin')}
              value={`${preview.requiredMargin} ${preview.accountCurrency}`}
            />
            <Figure
              label={t('ticket.commission')}
              value={`${preview.estimatedCommission} ${preview.accountCurrency}`}
            />
            <Figure label={t('ticket.freeAfter')} value={preview.freeMarginAfter} />
            <Figure label={t('ticket.levelAfter')} value={preview.marginLevelAfter ?? '—'} />
          </Card>
        )}

        {preview !== null && (preview.warnings.length > 0 || preview.violations.length > 0) ? (
          <ErrorNote
            message={
              (kind === 'MARKET' ? '' : `${t('ticket.ifFilled')}\n`) +
              [...preview.warnings, ...preview.violations].join('\n')
            }
          />
        ) : null}
        {kind !== 'MARKET' && restingProblem !== null ? (
          <ErrorNote message={restingProblem} />
        ) : null}

        {mobileTrading.mayOpen ? null : <ErrorNote message={mobileTrading.reason ?? ''} />}

        {confirming ? (
          <Card title={t('ticket.confirm')}>
            <Text style={styles.confirm}>
              {preview === null
                ? t('ticket.pricing')
                : resting !== null
                  ? `${restingSummary(resting, t)} ${t('ticket.noMarginHeld')}`
                  : t('ticket.marketSummary', {
                      side: t(preview.side === 'BUY' ? 'common.BUY' : 'common.SELL'),
                      volume: preview.volume,
                      symbol: preview.symbol,
                      price: preview.price,
                      margin: preview.requiredMargin,
                      commission: preview.estimatedCommission,
                      currency: preview.accountCurrency,
                    })}
            </Text>
            <Button
              label={t('ticket.place')}
              variant={side === 'SELL' ? 'danger' : 'buy'}
              busy={busy}
              disabled={!reviewable}
              onPress={() => void submit()}
            />
            <Button
              label={t('common.cancel')}
              variant="quiet"
              onPress={() => setConfirming(false)}
            />
          </Card>
        ) : (
          <Button
            label={`${t('ticket.review')} · ${side === 'BUY' ? t('common.BUY') : t('common.SELL')}`}
            variant={side === 'BUY' ? 'buy' : 'danger'}
            disabled={!reviewable}
            onPress={() => setConfirming(true)}
          />
        )}
      </ScrollView>
    </Screen>
  );
}

/** What a points field resolves to, or why it resolves to nothing yet. */
function pointsHint(
  points: string,
  price: string | null,
  reference: string | null,
  t: ReturnType<typeof useT>,
): string | undefined {
  if (points.trim() === '') return undefined;
  if (reference === null) return t('ticket.pointsNoPrice');
  if (price === null) return t('ticket.pointsBad');
  return t('ticket.pointsAt', { price, from: reference });
}

function Field({
  label,
  value,
  onChange,
  keyboard,
  placeholder,
  hint,
  tone,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  keyboard?: 'decimal-pad';
  placeholder?: string;
  /** A line under the field: what a points entry resolves to. */
  hint?: string | undefined;
  tone?: 'loss' | 'profit';
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
      {hint === undefined ? null : (
        <Text
          style={[
            styles.fieldHint,
            tone === 'loss'
              ? { color: theme.colors.negative }
              : tone === 'profit'
                ? { color: theme.colors.profit }
                : null,
          ]}
        >
          {hint}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  heading: {
    fontFamily: theme.font.bold,
    color: theme.colors.text,
    fontSize: 24,
    marginBottom: theme.spacing(1),
  },
  sides: { flexDirection: 'row', gap: theme.spacing(1), marginBottom: theme.spacing(1.5) },
  sideTile: {
    flex: 1,
    minHeight: 68,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing(1),
  },
  sideLabel: { fontFamily: theme.font.heavy, fontSize: 12, letterSpacing: 1.2 },
  sidePrice: { fontFamily: theme.font.monoHeavy, fontSize: 22, marginTop: 2 },
  block: { marginBottom: theme.spacing(1.5) },
  kind: { flex: 1, marginHorizontal: theme.spacing(0.25) },
  field: { marginBottom: theme.spacing(1.25) },
  fieldLabel: {
    fontFamily: theme.font.semibold,
    color: theme.colors.textMuted,
    fontSize: 12,
    marginBottom: theme.spacing(0.75),
  },
  fieldHint: {
    fontFamily: theme.font.regular,
    color: theme.colors.textMuted,
    fontSize: 12,
    marginTop: theme.spacing(0.5),
  },
  input: {
    fontFamily: theme.font.mono,
    backgroundColor: theme.colors.surfaceSunken,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    color: theme.colors.text,
    fontSize: 16,
    minHeight: 50,
    paddingHorizontal: theme.spacing(1.5),
  },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceSunken,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    marginBottom: theme.spacing(1.5),
  },
  stepButton: {
    width: 56,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepGlyph: { fontFamily: theme.font.medium, color: theme.colors.text, fontSize: 24 },
  stepInput: {
    fontFamily: theme.font.monoBold,
    flex: 1,
    color: theme.colors.text,
    fontSize: 20,
    textAlign: 'center',
    minHeight: 52,
  },
  confirm: {
    fontFamily: theme.font.regular,
    color: theme.colors.text,
    fontSize: 15,
    lineHeight: 22,
  },
});
