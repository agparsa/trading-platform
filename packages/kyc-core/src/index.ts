/**
 * Identity verification, as domain logic.
 *
 * The state machine, what a document may be, and the provider port live here,
 * framework-free and unit tested — the parts that must not change when the
 * provider does, or when a jurisdiction asks for one more kind of document.
 */
export {
  KycStatus,
  KycDocumentKind,
  IDENTITY_KINDS,
  SUBMITTABLE,
  AWAITING_DECISION,
  ACCEPTED_CONTENT_TYPES,
  MAX_DOCUMENT_BYTES,
  canTransition,
  isSubmittable,
  isAwaitingDecision,
  isCurrentlyVerified,
  submissionShortfalls,
} from './state';
export type {
  KycProvider,
  KycRequest,
  KycInstruction,
  KycWebhookDelivery,
  KycProviderEvent,
} from './provider';
export { sniffContentType } from './sniff';
