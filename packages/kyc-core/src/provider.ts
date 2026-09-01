import type { KycStatus } from './state';

/**
 * The port an automated identity-verification provider implements.
 *
 * ## Why there is no Sumsub, Onfido or Veriff adapter in this repository
 *
 * The same reason there is no Stripe adapter in `@tp/payments-core`: choosing
 * one is a commercial decision — pricing per check, which countries, which
 * document types, data residency, who signs the processing agreement — and an
 * adapter written against public documentation for a contract nobody has signed
 * would be an integration that has never verified anybody, sitting here looking
 * finished.
 *
 * What exists instead is real: a person submits documents, an operator with the
 * capability reviews them, and the decision is recorded with a name against it.
 * That is how a firm's first verifications are done and how many firms do all of
 * them. An automated provider, when chosen, implements this interface and slots
 * in *beside* the manual path, not instead of it — a provider's "needs manual
 * review" outcome lands in the same operator queue.
 *
 * The concrete adapter is **pending provider selection**.
 */
export interface KycProvider {
  /** Stable machine name. Stored on the record so a decision says who made it. */
  readonly name: string;

  /**
   * Begins an automated check for a submission.
   *
   * Returns what the provider needs the person to do next, if anything. A
   * provider that takes the documents the platform already holds returns
   * `none`; one that runs its own capture flow returns a `redirect`.
   */
  begin(request: KycRequest): Promise<KycInstruction>;

  /**
   * Turns a raw webhook into a decision the platform understands, or refuses it.
   *
   * The adapter owns signature verification, because only it knows the scheme.
   * `null` means "not for me, or not authentic", and the caller treats both the
   * same way on purpose.
   */
  parseWebhook(raw: KycWebhookDelivery): Promise<KycProviderEvent | null>;
}

export interface KycRequest {
  /** The platform's own record id. Carried by the provider and matched on return. */
  readonly reference: string;
  readonly applicant: {
    readonly userId: string;
    readonly email: string;
  };
  /** Which kinds were submitted, so a provider can refuse a set it cannot check. */
  readonly documentKinds: readonly string[];
}

export interface KycInstruction {
  readonly providerReference?: string;
  readonly redirectUrl?: string;
  readonly action: 'none' | 'redirect';
}

export interface KycWebhookDelivery {
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** The raw body. A signature is over bytes, not a re-serialised object. */
  readonly body: string;
}

export interface KycProviderEvent {
  /** The provider's id for this delivery; unique per provider, so a repeat is harmless. */
  readonly eventId: string;
  /** The platform's record id, as the adapter recovered it. */
  readonly reference: string;
  /**
   * What the provider concluded. `PENDING` here means "we could not decide;
   * a person should" — it lands in the operator queue like any other.
   */
  readonly outcome: Extract<KycStatus, 'VERIFIED' | 'REJECTED' | 'PENDING'>;
  /** The provider's own wording, kept verbatim for an operator reading the trail. */
  readonly providerStatus: string;
  readonly reason?: string;
}
