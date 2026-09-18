import { Feature } from '@tp/shared-types';

/**
 * Whether this app may open a position, and what to say when it may not.
 *
 * `mobile_trading` is a FIRM flag with CLIENT enforcement, and
 * `features.ts` says what that means: *the client honours it*.
 * `feature-flags.md` was more specific still — the "Where" column for this flag
 * read **"the mobile app"**. It did not. Nothing in `apps/mobile` fetched
 * `GET /features` at all, so an operator could switch mobile trading off in the
 * panel, watch the switch move, and have changed nothing.
 *
 * ## What it is not
 *
 * Not a security control, and `feature-flags.md` says so in the same breath:
 * "nobody reads 'mobile trading: off' as a security guarantee. It is not one:
 * the same person can trade from the web." It is a product choice a firm makes
 * about its own traders. That is exactly why it can be honoured on the client —
 * and exactly why the failure modes below resolve the way they do.
 */
export interface MobileTradingDecision {
  /** May the trader open a new position from this app? */
  readonly mayOpen: boolean;
  /** May the trader close or modify what they already hold? Always. */
  readonly mayClose: boolean;
  /** Shown to the trader when `mayOpen` is false. Never blank. */
  readonly reason: string | null;
}

const REFUSAL =
  'Your firm has switched off trading from the mobile app. You can still close ' +
  'and modify your open positions here, and trade from the web terminal.';

/**
 * Decides from the effective flags the API returned.
 *
 * **Unknown means yes**, and that is a deliberate inversion of the usual rule.
 * A flag that has not loaded, a network that is down, a response missing the
 * key: every one of those is a *client* problem, and this is not a control — so
 * failing closed would stop a trader placing an order because their phone
 * briefly lost signal, to enforce a product preference. The server refuses
 * nothing here either way, which is what makes failing open safe rather than
 * merely convenient. `false` is the only value that means no, matching the
 * terminal's own `!== false` for `quick_trading`.
 */
export function mobileTradingDecision(
  features: Readonly<Record<string, boolean>> | undefined,
): MobileTradingDecision {
  const allowed = features?.[Feature.MOBILE_TRADING] !== false;
  return {
    mayOpen: allowed,
    /**
     * Closing is never gated, for the same reason `trailing_stop` lets a trader
     * clear a trail it will not let them set: a firm turning a product off must
     * not leave somebody holding a position they cannot get out of from the
     * device in their hand. Switching a feature off may remove a way in. It may
     * not remove the way out.
     */
    mayClose: true,
    reason: allowed ? null : REFUSAL,
  };
}
