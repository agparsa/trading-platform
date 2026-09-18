import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useSession } from './session';
import { mobileTradingDecision, type MobileTradingDecision } from './mobile-trading';

/**
 * The firm's effective feature flags, as this app sees them.
 *
 * `GET /features` is the route `feature-flags.md` describes as "the effective
 * flags a client honours". The terminal has read it since the flags existed;
 * this app never did, which is why `mobile_trading` was a switch that moved and
 * changed nothing.
 *
 * Read once per session rather than polled. A flag is a switch a person throws,
 * and the API's own comment allows five seconds of disagreement between
 * instances — a phone that learns about the change when it next opens the app
 * is inside the spirit of that. It re-reads on sign-in because that is when the
 * firm might have changed.
 */
const FeaturesContext = createContext<Readonly<Record<string, boolean>> | undefined>(undefined);

export function FeaturesProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const { api, signedIn } = useSession();
  const [features, setFeatures] = useState<Readonly<Record<string, boolean>> | undefined>(
    undefined,
  );

  useEffect(() => {
    if (!signedIn) {
      setFeatures(undefined);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const answer = await api.get<{ features: Record<string, boolean> }>('/features');
        if (!cancelled) setFeatures(answer.features);
      } catch {
        /**
         * Left undefined, which `mobileTradingDecision` reads as "allowed".
         * A product preference must not be enforced by a failed request — see
         * the reasoning there.
         */
        if (!cancelled) setFeatures(undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, signedIn]);

  return <FeaturesContext.Provider value={features}>{children}</FeaturesContext.Provider>;
}

/** The effective flags, or undefined while they are unknown. */
export function useFeatures(): Readonly<Record<string, boolean>> | undefined {
  return useContext(FeaturesContext);
}

/** Whether this app may open a position, and what to tell the trader if not. */
export function useMobileTrading(): MobileTradingDecision {
  const features = useFeatures();
  return useMemo(() => mobileTradingDecision(features), [features]);
}
