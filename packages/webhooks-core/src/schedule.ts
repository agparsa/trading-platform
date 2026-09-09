/**
 * When to try a failed delivery again, and when to stop.
 *
 * Backoff widens because a receiver that is down is usually down for a while,
 * and hammering it every second helps nobody. Jitter is the caller's business
 * (it has the clock and the random source); this is the deterministic part.
 */

export interface RetryPolicy {
  /** Wait before the second attempt, in milliseconds. */
  readonly baseDelayMs: number;
  /** Each attempt waits this many times longer than the last. */
  readonly factor: number;
  /** No wait is longer than this. */
  readonly maxDelayMs: number;
  /** Attempts in total, the first included. */
  readonly maxAttempts: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  baseDelayMs: 30_000,
  factor: 4,
  maxDelayMs: 6 * 60 * 60 * 1000,
  maxAttempts: 8,
};

/** Delay before attempt number `attempt` (1-based), or null when there is no next attempt. */
export function nextDelayMs(
  attemptJustFailed: number,
  policy: RetryPolicy = DEFAULT_RETRY,
): number | null {
  if (!Number.isInteger(attemptJustFailed) || attemptJustFailed < 1) {
    throw new Error('attempts are counted from 1');
  }
  if (attemptJustFailed >= policy.maxAttempts) return null;
  const raw = policy.baseDelayMs * policy.factor ** (attemptJustFailed - 1);
  return Math.min(raw, policy.maxDelayMs);
}

/**
 * Whether an endpoint should be switched off.
 *
 * Counted in consecutive failed *deliveries*, not attempts: one event that
 * exhausts its retries is one failure. An endpoint that has failed this many
 * deliveries in a row is not a receiver with a bad hour, it is a receiver
 * nobody is running, and continuing to send to it fills a log with noise
 * that hides the next real failure.
 */
export function shouldDisable(consecutiveFailures: number, threshold: number): boolean {
  if (threshold < 1) throw new Error('a disable threshold below one would disable on success');
  return consecutiveFailures >= threshold;
}

/**
 * Whether a response means the delivery worked.
 *
 * 2xx only. A 3xx is not followed — a webhook that redirects is a webhook
 * pointing somewhere the firm did not register, and following it would let a
 * compromised receiver forward signed events elsewhere.
 */
export function delivered(status: number): boolean {
  return status >= 200 && status <= 299;
}
