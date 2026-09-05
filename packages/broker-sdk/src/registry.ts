import type { BrokerAdapter, BrokerAdapterFactory } from './adapter';
import { mockBrokerAdapterFactory } from './mock-adapter';

/**
 * Which connectors this build knows how to make.
 *
 * A registry rather than a switch, so a connector is added by registering
 * it — with the documentation it was written against — and nothing else in
 * the platform changes. A kind that is not registered cannot be chosen for
 * a connection, so a database row naming a connector this build lacks is
 * refused at the point of use rather than crashing a worker.
 *
 * Only the mock is registered. That is the state of the integration, stated
 * rather than filled: a real venue's connector is **pending that venue's
 * documentation and sandbox** (see docs/broker-integration.md).
 */
export class BrokerAdapterRegistry {
  private readonly factories = new Map<string, BrokerAdapterFactory>();

  constructor(factories: readonly BrokerAdapterFactory[] = [mockBrokerAdapterFactory]) {
    for (const factory of factories) this.register(factory);
  }

  register(factory: BrokerAdapterFactory): void {
    if (factory.kind !== 'MOCK' && factory.documentation.trim().length === 0) {
      throw new Error(
        `connector ${factory.kind} names no documentation it was written against; ` +
          'a connector to a real venue is not registered without one',
      );
    }
    this.factories.set(factory.kind, factory);
  }

  kinds(): readonly BrokerAdapterFactory[] {
    return [...this.factories.values()];
  }

  has(kind: string): boolean {
    return this.factories.has(kind);
  }

  create(kind: string, options?: Readonly<Record<string, unknown>>): BrokerAdapter {
    const factory = this.factories.get(kind);
    if (factory === undefined) {
      throw new Error(`no connector of kind ${kind} in this build`);
    }
    return factory.create(options);
  }

  factory(kind: string): BrokerAdapterFactory | undefined {
    return this.factories.get(kind);
  }
}
