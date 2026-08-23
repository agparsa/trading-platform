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
  })
  .strict()
  .refine((value) => value.stopLoss !== undefined || value.takeProfit !== undefined, {
    message: 'Provide stopLoss, takeProfit, or both',
  });

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
