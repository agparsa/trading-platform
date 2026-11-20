/**
 * What an admin alert rule can watch.
 *
 * Every metric is a count the database already holds, so it is exact,
 * cheap to read every minute and the same whoever reads it — no figure here
 * needs a price, which is what keeps a market-data outage from becoming an
 * alert storm. Each names what it counts in the words the panel shows.
 */
export const AdminAlertMetric = {
  WITHDRAWALS_WAITING: 'WITHDRAWALS_WAITING',
  VERIFICATIONS_WAITING: 'VERIFICATIONS_WAITING',
  RECONCILIATION_OPEN: 'RECONCILIATION_OPEN',
  RISK_EVENTS_1H: 'RISK_EVENTS_1H',
  REJECTED_ORDERS_1H: 'REJECTED_ORDERS_1H',
  CONNECTIONS_FAILING: 'CONNECTIONS_FAILING',
  REGISTRATIONS_24H: 'REGISTRATIONS_24H',
} as const;
export type AdminAlertMetric = (typeof AdminAlertMetric)[keyof typeof AdminAlertMetric];

export const ADMIN_ALERT_METRICS: ReadonlyArray<{
  readonly metric: AdminAlertMetric;
  readonly label: string;
  readonly description: string;
}> = [
  {
    metric: 'WITHDRAWALS_WAITING',
    label: 'Withdrawals waiting',
    description: 'Withdrawal requests requested or under review, not yet decided.',
  },
  {
    metric: 'VERIFICATIONS_WAITING',
    label: 'Verifications waiting',
    description: 'Identity verifications submitted and not yet decided.',
  },
  {
    metric: 'RECONCILIATION_OPEN',
    label: 'Reconciliation mismatches open',
    description: 'Reconciliation findings that are open, acknowledged or being investigated.',
  },
  {
    metric: 'RISK_EVENTS_1H',
    label: 'Risk events, last hour',
    description: 'Margin calls, stop-outs and limit breaches recorded in the last 60 minutes.',
  },
  {
    metric: 'REJECTED_ORDERS_1H',
    label: 'Rejected orders, last hour',
    description: 'Orders refused in the last 60 minutes, for any reason.',
  },
  {
    metric: 'CONNECTIONS_FAILING',
    label: 'Venue connections failing',
    description: 'Enabled venue connections disconnected, refused or rate-limited.',
  },
  {
    metric: 'REGISTRATIONS_24H',
    label: 'Sign-ups, last 24 hours',
    description: 'People who opened an account in the last 24 hours.',
  },
];

export function isAdminAlertMetric(value: string): value is AdminAlertMetric {
  return Object.prototype.hasOwnProperty.call(AdminAlertMetric, value);
}

export type AdminAlertComparator = 'ABOVE' | 'BELOW';

/**
 * Whether a reading breaches a rule. Strict: "above 10" fires at 11, so a
 * threshold of 0 with ABOVE fires on the first one.
 */
export function breaches(
  value: number,
  comparator: AdminAlertComparator,
  threshold: number,
): boolean {
  return comparator === 'ABOVE' ? value > threshold : value < threshold;
}

/**
 * Whether a breach raises an alert now. Edge-triggered — the first reading
 * over the line raises one — and repeated while it stays over only once the
 * quiet period has passed, so a rule left breached does not page every minute.
 */
export function shouldRaise(args: {
  readonly breached: boolean;
  readonly wasBreached: boolean;
  readonly lastRaisedAt: Date | null;
  readonly cooldownMinutes: number;
  readonly now: Date;
}): boolean {
  if (!args.breached) return false;
  if (!args.wasBreached) return true;
  if (args.lastRaisedAt === null) return true;
  return args.now.getTime() - args.lastRaisedAt.getTime() >= args.cooldownMinutes * 60_000;
}
