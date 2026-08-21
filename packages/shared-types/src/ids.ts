/**
 * Branded identifier types.
 *
 * Every public identifier is a UUID string. Sequential database keys are never
 * exposed outside the persistence layer. Branding stops an accountId being
 * passed where an orderId is expected — a mistake TypeScript cannot otherwise
 * catch because both are `string`.
 */
declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type UserId = Brand<string, 'UserId'>;
export type AccountId = Brand<string, 'AccountId'>;
export type OrderId = Brand<string, 'OrderId'>;
export type PositionId = Brand<string, 'PositionId'>;
export type ExecutionId = Brand<string, 'ExecutionId'>;
export type TradeId = Brand<string, 'TradeId'>;
export type LedgerEntryId = Brand<string, 'LedgerEntryId'>;
export type SymbolCode = Brand<string, 'SymbolCode'>;
export type RequestId = Brand<string, 'RequestId'>;
export type IdempotencyKey = Brand<string, 'IdempotencyKey'>;

/** Unsafe cast helpers. Use only at trust boundaries, after validation. */
export const asUserId = (v: string): UserId => v as UserId;
export const asAccountId = (v: string): AccountId => v as AccountId;
export const asOrderId = (v: string): OrderId => v as OrderId;
export const asPositionId = (v: string): PositionId => v as PositionId;
export const asExecutionId = (v: string): ExecutionId => v as ExecutionId;
export const asTradeId = (v: string): TradeId => v as TradeId;
export const asSymbolCode = (v: string): SymbolCode => v as SymbolCode;
export const asRequestId = (v: string): RequestId => v as RequestId;
export const asIdempotencyKey = (v: string): IdempotencyKey => v as IdempotencyKey;
