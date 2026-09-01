import { Injectable } from '@nestjs/common';
import {
  PaymentStatus,
  type PaymentInstruction,
  type PaymentProvider,
  type PaymentRequest,
  type ProviderEvent,
} from '@tp/payments-core';

/**
 * Money that arrives by bank transfer, confirmed by a person.
 *
 * ## Why this is a real provider and not a placeholder
 *
 * It is how most firms take their first deposits and how many take their
 * largest ones. The payer is given account details and a reference to quote; an
 * operator sees the money land and confirms it. Nothing about that is simulated:
 * the confirmation is a human act, recorded, with a capability behind it.
 *
 * What it deliberately does **not** do is pretend to be an automated provider.
 * It has no webhook — `parseWebhook` returns null for everything — because
 * nobody is going to send one. An operator confirms through the administrative
 * endpoint, which is a different door with a different capability and its own
 * audit record.
 *
 * The details a payer is shown come from configuration. A hard-coded IBAN in a
 * repository is somebody else's bank account by the second deployment.
 */
@Injectable()
export class ManualBankTransferProvider implements PaymentProvider {
  readonly name = 'manual-bank-transfer';
  readonly action = 'instructions' as const;

  constructor(
    private readonly details: string | undefined,
    private readonly currencies: readonly string[],
  ) {}

  supports(currency: string): boolean {
    return this.currencies.includes(currency.toUpperCase());
  }

  begin(request: PaymentRequest): Promise<PaymentInstruction> {
    /**
     * The reference is the intent id, and the payer is told to quote it.
     *
     * It is the only thing tying a line on a bank statement to a person here.
     * An operator matching a transfer with no reference is guessing, and a
     * guess in this direction credits the wrong account.
     */
    const instructions = [
      this.details ?? 'Bank details have not been configured. Ask support before transferring.',
      '',
      `Amount: ${request.amount} ${request.currency}`,
      `Reference (quote this exactly): ${request.reference}`,
      '',
      'Funds appear once someone here has matched the transfer to this reference.',
      'Transfers without the reference take longer and may be returned.',
    ].join('\n');

    return Promise.resolve({
      instructions,
      status: PaymentStatus.REQUIRES_ACTION,
    });
  }

  /**
   * Nothing sends webhooks for a bank transfer.
   *
   * Returning null rather than throwing, because the caller treats "not for me"
   * and "not authentic" identically on purpose — telling an unauthenticated
   * caller which of the two it was tells them how to get closer.
   */
  parseWebhook(): Promise<ProviderEvent | null> {
    return Promise.resolve(null);
  }
}
