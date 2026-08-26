import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Prices and volumes arrive as strings, never as JSON numbers.
 *
 * A client that sends `0.1` as a number has already lost precision before the
 * request left it. Requiring a decimal string makes that impossible to do by
 * accident, and the pattern rejects anything that is not an exact decimal.
 */
const decimalString = z
  .string()
  .trim()
  .regex(/^-?\d+(\.\d+)?$/, 'Must be a decimal string, e.g. "1.00"')
  .max(40);

const positiveDecimal = decimalString.refine((value) => Number(value) > 0, {
  message: 'Must be greater than zero',
});

export const openPositionSchema = z
  .object({
    accountId: z.string().uuid(),
    symbol: z.string().trim().min(1).max(20),
    side: z.enum(['BUY', 'SELL']),
    volume: positiveDecimal,
    stopLoss: positiveDecimal.nullish(),
    takeProfit: positiveDecimal.nullish(),
  })
  .strict();

export const closePositionSchema = z
  .object({
    // Omitted closes the whole position.
    volume: positiveDecimal.nullish(),
  })
  .strict();

export const modifyPositionSchema = z
  .object({
    // `null` clears a level; omitting the field leaves it unchanged. The two
    // are distinct, which is why neither defaults to the other.
    stopLoss: positiveDecimal.nullable().optional(),
    takeProfit: positiveDecimal.nullable().optional(),
    // Distance in price units the trailing stop follows behind the best price
    // seen. Setting it hands stop-loss management to the engine.
    trailingStopDistance: positiveDecimal.nullable().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.stopLoss !== undefined ||
      value.takeProfit !== undefined ||
      value.trailingStopDistance !== undefined,
    { message: 'Provide stopLoss, takeProfit or trailingStopDistance' },
  );

export const listQuerySchema = z
  .object({
    accountId: z.string().uuid(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    includeClosed: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  })
  .strict();

export class OpenPositionDto extends createZodDto(openPositionSchema) {}
export class ClosePositionDto extends createZodDto(closePositionSchema) {}
export class ModifyPositionDto extends createZodDto(modifyPositionSchema) {}
export class ListQueryDto extends createZodDto(listQuerySchema) {}

export const placePendingSchema = z
  .object({
    accountId: z.string().uuid(),
    symbol: z.string().trim().min(1).max(20),
    side: z.enum(['BUY', 'SELL']),
    type: z.enum(['LIMIT', 'STOP']),
    volume: positiveDecimal,
    price: positiveDecimal,
    stopLoss: positiveDecimal.nullish(),
    takeProfit: positiveDecimal.nullish(),
    timeInForce: z.enum(['GTC', 'DAY', 'GTD']).default('GTC'),
    // Epoch milliseconds. Required for GTD; the service rejects a missing or
    // past value rather than silently turning the order into a GTC.
    expiresAt: z.number().int().positive().nullish(),
  })
  .strict();

export const modifyPendingSchema = z
  .object({
    price: positiveDecimal.optional(),
    volume: positiveDecimal.optional(),
    // `null` clears a level; omitting the field leaves it unchanged.
    stopLoss: positiveDecimal.nullable().optional(),
    takeProfit: positiveDecimal.nullable().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.price !== undefined ||
      value.volume !== undefined ||
      value.stopLoss !== undefined ||
      value.takeProfit !== undefined,
    { message: 'Provide price, volume, stopLoss or takeProfit' },
  );

export const accountQuerySchema = z.object({ accountId: z.string().uuid() }).strict();

export class PlacePendingDto extends createZodDto(placePendingSchema) {}
export class ModifyPendingDto extends createZodDto(modifyPendingSchema) {}
export class AccountQueryDto extends createZodDto(accountQuerySchema) {}
