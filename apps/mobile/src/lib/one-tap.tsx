import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { NotificationCategory, type OrderSide } from '@tp/shared-types';
import { useAccounts } from './accounts';
import { useFeatures, useMobileTrading } from './features';
import { useT } from './i18n';
import { refusalText } from './messages';
import { secureStore } from './secure-store';
import { useSession } from './session';
import { openedKey } from './trade-sound';

/**
 * One-tap trading: a press on SELL or BUY sends a market order at once.
 *
 * Off by default, and switched on only by the trader, after a sentence that
 * says what it means. Only where the firm allows it (`quick_trading`, and
 * `mobile_trading` for opening from this app at all). It is the ticket's
 * request without the ticket's review step — the server checks margin, risk,
 * session and the price exactly as it does for every order, and its refusal is
 * shown in its own words. "Opened" is said only from the server's answer.
 *
 * Kept in the keychain like the rest of this device's settings, so a phone
 * that is handed to someone else does not arrive armed after a reinstall
 * restored from backup.
 */
export interface OneTapNotice {
  readonly tone: 'ok' | 'error' | 'info';
  readonly text: string;
  readonly at: number;
}

interface OneTapValue {
  /** The firm allows it and the trader switched it on. */
  readonly armed: boolean;
  /** The firm allows it at all; when false the switch is not offered. */
  readonly allowed: boolean;
  setArmed(on: boolean): void;
  /** The lots a one-tap order sends, shared by every screen that offers it. */
  readonly lots: string;
  setLots(lots: string): void;
  /** `symbol:side` while that order is on the wire. */
  readonly busy: string | null;
  send(symbol: string, side: OrderSide): Promise<void>;
  readonly notice: OneTapNotice | null;
  dismiss(): void;
}

const ARMED_KEY = 'tp.oneTap.armed';
const LOTS_KEY = 'tp.oneTap.lots';

interface OrderAck {
  positionId?: string | null;
  status: string;
  symbol: string;
  side: OrderSide;
  volume: string;
  price: string;
}

const OneTapContext = createContext<OneTapValue | null>(null);

export function OneTapProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const t = useT();
  const { api, tradeSound } = useSession();
  const { selected } = useAccounts();
  const features = useFeatures();
  const mobileTrading = useMobileTrading();
  const allowed = features?.['quick_trading'] !== false && mobileTrading.mayOpen;
  const [on, setOn] = useState(false);
  const [lots, setLotsState] = useState('0.10');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<OneTapNotice | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setOn((await secureStore.get(ARMED_KEY)) === '1');
        const stored = await secureStore.get(LOTS_KEY);
        if (stored !== null && /^\d+(\.\d+)?$/.test(stored)) setLotsState(stored);
      } catch {
        // Nothing remembered: off, and the default lots.
      }
    })();
  }, []);

  const setArmed = useCallback((next: boolean) => {
    setOn(next);
    void secureStore.set(ARMED_KEY, next ? '1' : '0').catch(() => undefined);
  }, []);

  const setLots = useCallback((next: string) => {
    setLotsState(next);
    if (/^\d+(\.\d+)?$/.test(next.trim())) {
      void secureStore.set(LOTS_KEY, next.trim()).catch(() => undefined);
    }
  }, []);

  const send = useCallback(
    async (symbol: string, side: OrderSide) => {
      if (selected === null || busy !== null) return;
      const key = `${symbol}:${side}`;
      setBusy(key);
      setNotice({
        tone: 'info',
        text: t('oneTap.sending', {
          side: t(side === 'BUY' ? 'common.BUY' : 'common.SELL'),
          lots,
          symbol,
        }),
        at: Date.now(),
      });
      try {
        const ack = await api.post<OrderAck>(
          '/orders',
          {
            accountId: selected.id,
            symbol,
            side,
            volume: lots.trim(),
            stopLoss: null,
            takeProfit: null,
          },
          // One key per press: a retry of this request is the same order.
          { idempotencyKey: `one-tap:${selected.id}:${symbol}:${side}:${Date.now()}` },
        );
        if (typeof ack.positionId === 'string') {
          tradeSound(openedKey(ack.positionId), NotificationCategory.TRADE_OPENED);
        }
        setNotice({
          tone: 'ok',
          text:
            typeof ack.positionId === 'string'
              ? t('oneTap.opened', {
                  side: t(ack.side === 'BUY' ? 'common.BUY' : 'common.SELL'),
                  lots: ack.volume,
                  symbol: ack.symbol,
                  price: ack.price,
                })
              : t('oneTap.accepted', { symbol: ack.symbol, status: ack.status }),
          at: Date.now(),
        });
      } catch (caught) {
        setNotice({
          tone: 'error',
          text: refusalText(caught, 'ticket.placeFailed', t),
          at: Date.now(),
        });
      } finally {
        setBusy(null);
      }
    },
    [api, selected, busy, lots, t, tradeSound],
  );

  const value = useMemo<OneTapValue>(
    () => ({
      armed: allowed && on,
      allowed,
      setArmed,
      lots,
      setLots,
      busy,
      send,
      notice,
      dismiss: () => setNotice(null),
    }),
    [allowed, on, setArmed, lots, setLots, busy, send, notice],
  );
  return <OneTapContext.Provider value={value}>{children}</OneTapContext.Provider>;
}

export function useOneTap(): OneTapValue {
  const value = useContext(OneTapContext);
  if (value === null) throw new Error('useOneTap must be used inside a OneTapProvider');
  return value;
}
