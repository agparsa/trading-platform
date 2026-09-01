import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Amounts arrive as decimal **strings**, never as JSON numbers.
 *
 * `0.1 + 0.2` is the reason, and JSON has no other numeric type: a body carrying
 * `1234.56` as a number has already been through a double before any validation
 * here can see it. The same rule the trading endpoints follow.
 */
const money = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,10})?$/, 'An amount is a positive decimal string, e.g. "250.00"')
  .max(32);

export const transferSchema = z
  .object({
    accountId: z.string().uuid(),
    direction: z.enum(['to-account', 'to-wallet']),
    amount: money,
  })
  .strict();

export class TransferDto extends createZodDto(transferSchema) {}

export const walletAdjustmentSchema = z
  .object({
    type: z.enum(['DEPOSIT', 'WITHDRAWAL', 'ADJUSTMENT', 'FEE']),
    /** Signed only for ADJUSTMENT; the others take their direction from the type. */
    amount: z
      .string()
      .trim()
      .regex(/^-?\d+(\.\d{1,10})?$/, 'An amount is a decimal string')
      .max(32),
    /** The only part of this record a person will read later. */
    reason: z.string().trim().min(3).max(500),
    compensatesId: z.string().uuid().optional(),
  })
  .strict();

export class WalletAdjustmentDto extends createZodDto(walletAdjustmentSchema) {}

export const walletStatusSchema = z
  .object({
    status: z.enum(['ACTIVE', 'FROZEN']),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export class WalletStatusDto extends createZodDto(walletStatusSchema) {}
