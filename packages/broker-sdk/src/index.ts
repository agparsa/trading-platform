/**
 * The broker adapter SDK.
 *
 * The port a connector implements, the capability vocabulary, the connection
 * state machine, a scripted mock venue, and the contract suite every
 * connector must pass — framework-free, so a connector can be written and
 * proven without booting the platform. No venue is assumed: the only
 * connector here is the mock, and a real one is pending its venue's
 * documentation. See docs/broker-adapter-sdk.md.
 */
export type { BrokerAdapter, BrokerAdapterFactory } from './adapter';
export {
  BrokerAdapterError,
  BrokerCredentialKind,
  BrokerErrorCode,
  BrokerEventKind,
  ConnectionState,
  NO_CAPABILITIES,
  OrderOutcome,
  capabilityForOrderType,
  type AdapterHealth,
  type BrokerAccountSnapshot,
  type BrokerCapabilities,
  type BrokerCredentials,
  type BrokerEvent,
  type BrokerFill,
  type BrokerInstrument,
  type BrokerOrder,
  type BrokerPosition,
  type BrokerQuote,
  type NormalisedOrder,
  type OrderResult,
} from './types';
export {
  ConnectionMonitor,
  DEFAULT_MONITOR_OPTIONS,
  type MonitorOptions,
  type MonitorSnapshot,
  type Transition,
} from './connection-monitor';
export {
  MockBrokerAdapter,
  mockBrokerAdapterFactory,
  type MockBehaviour,
  type MockOptions,
} from './mock-adapter';
export { BrokerAdapterRegistry } from './registry';
export {
  credentialMetadata,
  deserialiseCredentials,
  fingerprintCredentials,
  redactCredentialValues,
  serialiseCredentials,
  type BrokerCredentialMetadata,
  type SealedCredentialPayload,
} from './credentials';
export { brokerAdapterContract, type ContractHarness, type ExpectLike } from './contract';
