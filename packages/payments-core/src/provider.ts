import type { PaymentStatus } from './state';

/**
 * The port every payment provider implements.
 *
 * ## Why there is no Stripe adapter in this repository
 *
 * Choosing a payment provider is a commercial decision — pricing, settlement
 * terms, which countries and which methods — and the implementation plan says
 * so: it gates this phase. Writing a Stripe adapter against documentation
 * nobody has signed a contract for would be inventing an integration, and the
 * one thing worse than a missing provider is a provider that looks present and
 * has never been through a real payment.
 *
 * So this interface exists, `ManualBankTransferProvider` implements it for real,
 * and the concrete third-party adapter is **pending provider selection**. That
 * is a deliberate gap and it is stated here rather than filled with a guess.
 */
export interface PaymentProvider {
  /** Stable machine name. Stored on every intent and used to route webhooks. */
  readonly name: string;

  /**
   * What a payer has to do next, if anything.
   *
   * `none` means the money moves without the platform showing anything —
   * true for a provider that debits a stored method. `instructions` means the
   * payer is shown text, which is what a bank transfer needs. `redirect` means
   * the payer is sent to the provider.
   */
  readonly action: 'none' | 'instructions' | 'redirect';

  /** Currencies this provider will take. Checked before an intent is created. */
  supports(currency: string): boolean;

  /**
   * Begins a payment and returns what the payer must be shown.
   *
   * `reference` is the platform's own intent id. Every provider that has a field
   * for it must carry it, because it is what a webhook is matched on when the
   * provider's own id is not yet known.
   */
  begin(request: PaymentRequest): Promise<PaymentInstruction>;

  /**
   * Turns a raw webhook into something the platform understands, or refuses it.
   *
   * The adapter owns signature verification, because only it knows the scheme.
   * Returning `null` means "not for me, or not authentic" — and the caller
   * treats both the same way, deliberately: telling an unauthenticated caller
   * which of the two it was is telling them how to get closer.
   */
  parseWebhook(raw: WebhookDelivery): Promise<ProviderEvent | null>;
}

export interface PaymentRequest {
  readonly reference: string;
  readonly amount: string;
  readonly currency: string;
  readonly payer: { readonly userId: string; readonly email: string };
}

export interface PaymentInstruction {
  /** The provider's own identifier, when it has one at this point. */
  readonly providerReference?: string;
  /** Shown to the payer verbatim. Bank details, a note to quote, a redirect URL. */
  readonly instructions?: string;
  readonly redirectUrl?: string;
  /** Where the payment starts. Usually REQUIRES_ACTION; never SUCCEEDED. */
  readonly status: PaymentStatus;
}

export interface WebhookDelivery {
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** The raw body, unparsed. A signature is over bytes, not over a re-serialised object. */
  readonly body: string;
}

export interface ProviderEvent {
  /**
   * The provider's id for this delivery.
   *
   * The whole reason webhooks are safe: a provider will deliver the same event
   * twice — after a timeout, after a retry, after an outage — and the platform
   * stores this with a unique constraint so the second delivery changes nothing.
   */
  readonly eventId: string;
  /** The platform's intent id, as the adapter recovered it. */
  readonly reference: string;
  readonly status: PaymentStatus;
  /** What the provider called it, kept verbatim for an operator reading the trail. */
  readonly providerStatus: string;
  readonly providerReference?: string;
  /** Present when the provider states one; checked against the intent. */
  readonly amount?: string;
  readonly currency?: string;
}
