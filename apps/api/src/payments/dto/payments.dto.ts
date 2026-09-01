import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const startPaymentSchema = z
  .object({
    provider: z.string().trim().min(1).max(64),
    /** A decimal string, for the reason every other money field here is one. */
    amount: z
      .string()
      .trim()
      .regex(/^\d+(\.\d{1,10})?$/, 'An amount is a positive decimal string, e.g. "250.00"')
      .max(32),
    currency: z.string().trim().length(3).toUpperCase(),
  })
  .strict();

export class StartPaymentDto extends createZodDto(startPaymentSchema) {}

export const settlePaymentSchema = z
  .object({
    outcome: z.enum(['SUCCEEDED', 'FAILED', 'CANCELLED']),
    /**
     * What an operator saw, in words somebody can act on later.
     *
     * Required, and it is the only part of a manual confirmation that explains
     * why money appeared. "Matched to statement line 4412, 12 Sept" is a record;
     * a blank field is a decision nobody can review.
     */
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export class SettlePaymentDto extends createZodDto(settlePaymentSchema) {}
