import type { WithdrawalStatus } from './state';

/**
 * The port a payout rail implements.
 *
 * ## Why there is no bank-API, PSP-payout or crypto adapter here
 *
 * The same reason there is no Stripe adapter in `@tp/payments-core` and no
 * Sumsub adapter in `@tp/kyc-core`: which rail pays people is a commercial
 * decision — fees, currencies, settlement times, who signs — and an adapter
 * written against public documentation for a contract nobody has signed would
 * be an integration that has never paid anybody, sitting here looking finished.
 *
 * What exists instead is real, and is how most firms pay their first
 * withdrawals: an operator holding `withdrawals.pay` sends the transfer from
 * the firm's bank, records the reference, and marks the request paid. That is
 * a human act with a capability behind it and an audit row after it.
 *
 * An automated rail, when chosen, implements this interface. Its `initiate`
 * moves a request to PROCESSING; its webhook moves it to PAID or FAILED. The
 * concrete adapter is **pending provider selection**.
 */
export interface PayoutProvider {
  /** Stable machine name. Stored on the request so a payout says who made it. */
  readonly name: string;

  /**
   * Starts a payout for an approved request.
   *
   * Returns the rail's own reference and whether it has already settled —
   * most rails answer PROCESSING and report PAID by webhook; some settle
   * synchronously.
   */
  initiate(request: PayoutRequest): Promise<PayoutInstruction>;

  /**
   * Turns a raw webhook into an outcome the platform understands, or refuses
   * it. `null` means "not for me, or not authentic", and the caller treats
   * both the same way on purpose.
   */
  parseWebhook(raw: PayoutWebhookDelivery): Promise<PayoutEvent | null>;
}

export interface PayoutRequest {
  /** The platform's own withdrawal id. Carried by the rail and matched on return. */
  readonly reference: string;
  readonly amount: string;
  readonly currency: string;
  /** Where the money goes, as the person gave it. Opened for this call only. */
  readonly destination: string;
}

export interface PayoutInstruction {
  readonly providerReference?: string;
  readonly status: Extract<WithdrawalStatus, 'PROCESSING' | 'PAID'>;
}

export interface PayoutWebhookDelivery {
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
}

export interface PayoutEvent {
  /** The rail's id for this delivery; unique per rail, so a repeat is harmless. */
  readonly eventId: string;
  readonly reference: string;
  readonly outcome: Extract<WithdrawalStatus, 'PAID' | 'FAILED'>;
  readonly providerStatus: string;
  readonly providerReference?: string;
  readonly reason?: string;
}
