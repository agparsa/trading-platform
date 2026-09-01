/**
 * Payments, as domain logic.
 *
 * The state machine and the provider port live here, framework-free and unit
 * tested, for the same reason the trading engine's do: they are the parts that
 * must not change when the provider does.
 */
export { PaymentStatus, TERMINAL, isTerminal, react, type Reaction } from './state';
export type {
  PaymentProvider,
  PaymentRequest,
  PaymentInstruction,
  WebhookDelivery,
  ProviderEvent,
} from './provider';
