import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const requestWithdrawalSchema = z
  .object({
    walletId: z.string().uuid(),
    /** A decimal string, for the reason every other money field here is one. */
    amount: z
      .string()
      .trim()
      .regex(/^\d+(\.\d{1,10})?$/, 'An amount is a positive decimal string, e.g. "250.00"')
      .max(32),
    /**
     * Where the money goes, as the person would write it for their bank: an
     * account name and number, an IBAN, a routing pair. Free text on purpose —
     * the formats differ by country and a form that knew them all would refuse
     * somebody's real account. Sealed at rest; shown whole only to the person
     * paying it, and that showing is audited.
     */
    destination: z.string().trim().min(8).max(500),
  })
  .strict();

export class RequestWithdrawalDto extends createZodDto(requestWithdrawalSchema) {}

export const decideWithdrawalSchema = z
  .object({
    outcome: z.enum(['APPROVED', 'REJECTED']),
    /** Shown to the person on a rejection; read by the next reviewer on an approval. */
    reason: z.string().trim().min(8).max(1000),
  })
  .strict();

export class DecideWithdrawalDto extends createZodDto(decideWithdrawalSchema) {}

export const startPayoutSchema = z
  .object({
    /**
     * The transfer's own reference — what the bank printed. Required: a payout
     * with no reference is a payout nobody can find on a statement.
     */
    providerReference: z.string().trim().min(3).max(200),
  })
  .strict();

export class StartPayoutDto extends createZodDto(startPayoutSchema) {}

export const settlePayoutSchema = z
  .object({
    outcome: z.enum(['PAID', 'FAILED']),
    reason: z.string().trim().min(3).max(1000),
  })
  .strict();

export class SettlePayoutDto extends createZodDto(settlePayoutSchema) {}
