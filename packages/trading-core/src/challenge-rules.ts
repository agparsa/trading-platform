import { Decimal } from '@tp/financial-core';

/**
 * The rules of a prop-firm evaluation, and the one function that decides
 * them.
 *
 * Pure and deterministic: the same terms and the same account figures give
 * the same answer, so a decision can be replayed from the record it left.
 * Every amount is a decimal string; nothing here is a float.
 *
 * ## Definitions
 *
 * - **Initial balance** — what the phase's account was opened with.
 * - **Day start** — the account's balance and equity at the first evaluation
 *   of the trading day, in the trading server's timezone. The *reference*
 *   the daily limit is measured from is chosen per plan (`dailyBasis`):
 *   the day-start balance, the day-start equity, or the higher of the two.
 * - **Daily loss limit** — `dailyLossPct` of that reference. The rule is
 *   broken when equity (open positions marked to market) is at or below
 *   `reference − limit`.
 * - **Maximum loss** — `maxLossPct` of the initial balance. With `STATIC`
 *   drawdown the floor is `initial − limit` for the life of the phase. With
 *   `TRAILING` it is `highWater − limit`, where high water is the highest
 *   equity seen; `trailingLock` stops the floor rising above the initial
 *   balance. Broken when equity is at or below the floor.
 * - **Profit target** — `profitTargetPct` of the initial balance, reached by
 *   the *balance* (closed results only) with nothing open. Floating profit
 *   does not pass a phase: it can still be lost.
 * - **Trading day** — a day, in the server's timezone, on which at least one
 *   position was opened. `minTradingDays` of them are needed to pass.
 * - **Duration** — `maxDays` calendar days from the phase's start, counted in
 *   the server's timezone; past it, a phase that has not passed expires.
 *   `null` is unlimited.
 *
 * A breach is checked before anything else: an account that broke a rule
 * and reached its target in the same instant has broken a rule.
 */
export type DrawdownMode = 'STATIC' | 'TRAILING';
export type DailyBasis = 'BALANCE' | 'EQUITY' | 'HIGHER';

export interface ChallengeTerms {
  /** `null` for a funded account, which has no target. */
  readonly profitTargetPct: string | null;
  readonly dailyLossPct: string;
  readonly maxLossPct: string;
  readonly drawdownMode: DrawdownMode;
  readonly trailingLock: boolean;
  readonly dailyBasis: DailyBasis;
  readonly minTradingDays: number;
  readonly maxDays: number | null;
}

export interface ChallengeFigures {
  readonly initialBalance: string;
  readonly dayStartBalance: string;
  readonly dayStartEquity: string;
  /** The highest equity seen in this phase, before this observation. */
  readonly highWaterEquity: string;
  readonly balance: string;
  readonly equity: string;
  readonly openPositions: number;
  readonly tradingDays: number;
  /** Calendar days since the phase began, the first day being 1. */
  readonly dayNumber: number;
}

export type ChallengeRule = 'DAILY_LOSS' | 'MAX_LOSS' | 'MAX_DAYS';

export interface ChallengeMetrics {
  readonly dailyReference: string;
  readonly dailyLossLimit: string;
  /** Equity at or below this breaks the daily rule. */
  readonly dailyFloor: string;
  /** How far equity is below the day's reference; zero when above it. */
  readonly dailyLoss: string;
  readonly maxLossLimit: string;
  readonly highWaterEquity: string;
  /** Equity at or below this breaks the maximum-loss rule. */
  readonly maxLossFloor: string;
  /** Balance the target needs; null with no target. */
  readonly targetBalance: string | null;
  /** Closed profit as a share of the target, 0–100, two places; null with no target. */
  readonly targetProgressPct: string | null;
  readonly tradingDays: number;
  readonly minTradingDays: number;
  readonly dayNumber: number;
  readonly maxDays: number | null;
}

export type ChallengeVerdict =
  | { readonly kind: 'ONGOING'; readonly metrics: ChallengeMetrics }
  | { readonly kind: 'BREACHED'; readonly rule: ChallengeRule; readonly metrics: ChallengeMetrics }
  | { readonly kind: 'PASSED'; readonly metrics: ChallengeMetrics };

const HUNDRED = new Decimal(100);

export function evaluateChallenge(
  terms: ChallengeTerms,
  figures: ChallengeFigures,
): ChallengeVerdict {
  const initial = positive(figures.initialBalance, 'initialBalance');
  const balance = new Decimal(figures.balance);
  const equity = new Decimal(figures.equity);
  const dayBalance = new Decimal(figures.dayStartBalance);
  const dayEquity = new Decimal(figures.dayStartEquity);
  const highWater = Decimal.max(new Decimal(figures.highWaterEquity), equity, initial);

  const reference =
    terms.dailyBasis === 'BALANCE'
      ? dayBalance
      : terms.dailyBasis === 'EQUITY'
        ? dayEquity
        : Decimal.max(dayBalance, dayEquity);
  const dailyLimit = reference
    .times(percent(terms.dailyLossPct, 'dailyLossPct'))
    .dividedBy(HUNDRED);
  const dailyFloor = reference.minus(dailyLimit);
  const dailyLoss = Decimal.max(reference.minus(equity), 0);

  const maxLimit = initial.times(percent(terms.maxLossPct, 'maxLossPct')).dividedBy(HUNDRED);
  let maxFloor = initial.minus(maxLimit);
  if (terms.drawdownMode === 'TRAILING') {
    maxFloor = highWater.minus(maxLimit);
    if (terms.trailingLock) maxFloor = Decimal.min(maxFloor, initial);
  }

  const target =
    terms.profitTargetPct === null
      ? null
      : initial.plus(
          initial.times(percent(terms.profitTargetPct, 'profitTargetPct')).dividedBy(HUNDRED),
        );
  const progress =
    target === null
      ? null
      : Decimal.min(
          Decimal.max(balance.minus(initial).dividedBy(target.minus(initial)).times(HUNDRED), 0),
          HUNDRED,
        ).toFixed(2, Decimal.ROUND_DOWN);

  const metrics: ChallengeMetrics = {
    dailyReference: reference.toString(),
    dailyLossLimit: dailyLimit.toString(),
    dailyFloor: dailyFloor.toString(),
    dailyLoss: dailyLoss.toString(),
    maxLossLimit: maxLimit.toString(),
    highWaterEquity: highWater.toString(),
    maxLossFloor: maxFloor.toString(),
    targetBalance: target === null ? null : target.toString(),
    targetProgressPct: progress,
    tradingDays: figures.tradingDays,
    minTradingDays: terms.minTradingDays,
    dayNumber: figures.dayNumber,
    maxDays: terms.maxDays,
  };

  if (equity.lessThanOrEqualTo(dailyFloor))
    return { kind: 'BREACHED', rule: 'DAILY_LOSS', metrics };
  if (equity.lessThanOrEqualTo(maxFloor)) return { kind: 'BREACHED', rule: 'MAX_LOSS', metrics };

  if (
    target !== null &&
    balance.greaterThanOrEqualTo(target) &&
    figures.openPositions === 0 &&
    figures.tradingDays >= terms.minTradingDays
  ) {
    return { kind: 'PASSED', metrics };
  }

  if (terms.maxDays !== null && target !== null && figures.dayNumber > terms.maxDays) {
    return { kind: 'BREACHED', rule: 'MAX_DAYS', metrics };
  }
  return { kind: 'ONGOING', metrics };
}

/** Calendar days from `start` to `now` in a timezone, the first day being 1. */
export function dayNumber(startDay: string, today: string): number {
  const ms = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${startDay}T00:00:00Z`);
  return Math.floor(ms / 86_400_000) + 1;
}

/** A plan's terms are sane: every check the evaluator relies on. */
export function termsProblem(terms: ChallengeTerms): string | null {
  const pct = (value: string, name: string, max = 100) => {
    if (!/^\d+(\.\d{1,4})?$/.test(value)) return `${name} must be a number with up to 4 places`;
    const d = new Decimal(value);
    if (d.lessThanOrEqualTo(0) || d.greaterThan(max))
      return `${name} must be above 0 and at most ${max}`;
    return null;
  };
  return (
    (terms.profitTargetPct === null ? null : pct(terms.profitTargetPct, 'profitTargetPct', 1000)) ??
    pct(terms.dailyLossPct, 'dailyLossPct') ??
    pct(terms.maxLossPct, 'maxLossPct') ??
    (new Decimal(terms.dailyLossPct).greaterThan(terms.maxLossPct)
      ? 'dailyLossPct cannot exceed maxLossPct'
      : null) ??
    (!Number.isInteger(terms.minTradingDays) ||
    terms.minTradingDays < 0 ||
    terms.minTradingDays > 365
      ? 'minTradingDays must be a whole number from 0 to 365'
      : null) ??
    (terms.maxDays !== null &&
    (!Number.isInteger(terms.maxDays) || terms.maxDays < 1 || terms.maxDays > 3650)
      ? 'maxDays must be a whole number from 1 to 3650, or none'
      : null) ??
    (terms.maxDays !== null && terms.maxDays < terms.minTradingDays
      ? 'maxDays cannot be shorter than minTradingDays'
      : null)
  );
}

function positive(value: string, name: string): Decimal {
  const d = new Decimal(value);
  if (!d.isFinite() || d.lessThanOrEqualTo(0)) throw new Error(`${name} must be above zero`);
  return d;
}

function percent(value: string, name: string): Decimal {
  const d = new Decimal(value);
  if (!d.isFinite() || d.lessThanOrEqualTo(0)) throw new Error(`${name} must be above zero`);
  return d;
}
