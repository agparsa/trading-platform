/**
 * Withdrawals, as domain logic.
 *
 * The state machine, the limits, and the payout port live here, framework-free
 * and unit tested — the parts that must not change when the rail that pays
 * people does.
 */
export {
  WithdrawalStatus,
  TERMINAL,
  RELEASING,
  COUNTS_TOWARD_LIMITS,
  canTransition,
  isTerminal,
  releasesHold,
  cancellableByRequester,
} from './state';
export {
  refusalsFor,
  needsHumanApproval,
  type WithdrawalPolicy,
  type WithdrawalHistory,
  type Applicant,
  type Refusal,
} from './limits';
export type {
  PayoutProvider,
  PayoutRequest,
  PayoutInstruction,
  PayoutWebhookDelivery,
  PayoutEvent,
} from './provider';
