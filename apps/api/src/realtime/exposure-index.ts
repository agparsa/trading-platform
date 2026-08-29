import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { DomainEvent } from '@tp/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { EventsService, type DomainEventEnvelope } from './events.service';

/**
 * Which accounts hold a position in which instrument.
 *
 * ## Why this exists
 *
 * A tick arrives and the realtime valuation has to answer one question: of the
 * accounts currently watching, which are exposed to this symbol? That used to be
 * a `position.findMany` — **on every tick, before the throttle applied**. Six
 * instruments at 250ms is roughly twenty-four queries a second with a single
 * socket connected, and turning the valuation interval up did not reduce it by
 * one.
 *
 * ## Why it is safe to hold in memory
 *
 * Because it is a routing hint and never an input to money. Nothing here decides
 * a balance, a P&L or a margin figure; it decides only *whether to bother
 * valuing an account now*. The valuation itself still reads PostgreSQL.
 *
 * That framing sets the tolerances, and they are deliberately asymmetric:
 *
 * - **Over-including is free.** An account listed against a symbol it no longer
 *   holds gets one valuation it did not need. The numbers are still correct.
 * - **Under-including is not.** An account missing from a symbol it does hold
 *   sees its P&L stop moving, which looks exactly like a broken terminal.
 *
 * So every path that could add exposure adds it immediately, and nothing removes
 * exposure on the spot. Removal happens on the periodic rebuild, which is
 * allowed to be late because being late means being generous.
 *
 * ## How it stays true
 *
 * Three ways in, one way out:
 *
 * 1. An account nobody has indexed yet is loaded on the first tick that cares —
 *    once per connection, not once per tick.
 * 2. `position.opened` adds the pair as it happens.
 * 3. A rebuild every `refreshMs` re-derives the whole thing from the database
 *    for the accounts still being watched, so any drift — a missed event, a
 *    position closed by the trigger engine, a manual database change — heals on
 *    its own within one interval rather than persisting for the life of the
 *    process.
 */
@Injectable()
export class ExposureIndex implements OnApplicationShutdown {
  private readonly logger = new Logger(ExposureIndex.name);

  /** symbol code → accounts holding an open position in it. */
  private readonly bySymbol = new Map<string, Set<string>>();
  /** Accounts this index has been populated for. */
  private readonly known = new Set<string>();

  private unsubscribe: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  /**
   * When the whole indexed set was last re-derived from the database.
   *
   * Seeded at construction, not left at zero. At zero the very first comparison
   * — `now - 0 >= refreshMs` — is true, so every call rebuilt the entire index:
   * a full re-read per tick, which is strictly worse than the scoped per-tick
   * query this class exists to remove. An empty set is trivially current, so
   * construction time is the honest starting value.
   */
  private lastRebuiltAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly refreshMs: number,
  ) {
    this.unsubscribe = this.events.onEvent((envelope) => this.onDomainEvent(envelope));
  }

  onApplicationShutdown(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * The accounts among `listening` that hold a position in `symbol`.
   *
   * Loads any account it has not seen before, and rebuilds when the interval has
   * elapsed. Both are bounded by the number of accounts online, not registered.
   */
  async exposedTo(
    symbol: string,
    listening: ReadonlySet<string>,
    nowMs: number,
  ): Promise<string[]> {
    if (listening.size === 0) return [];

    const unknown = [...listening].filter((accountId) => !this.known.has(accountId));
    if (unknown.length > 0) await this.load(unknown);
    else if (nowMs - this.lastRebuiltAt >= this.refreshMs)
      await this.rebuild([...listening], nowMs);

    const holders = this.bySymbol.get(symbol);
    if (holders === undefined) return [];

    const exposed: string[] = [];
    for (const accountId of holders) if (listening.has(accountId)) exposed.push(accountId);
    return exposed;
  }

  /**
   * Drops an account nobody is watching.
   *
   * Called when the last socket for an account goes away. Without it both this
   * map and the valuation throttle's grow for the life of the process — small,
   * unbounded, and invisible to a soak that runs for fifteen minutes.
   */
  forget(accountId: string): void {
    this.known.delete(accountId);
    for (const [symbol, holders] of this.bySymbol) {
      holders.delete(accountId);
      if (holders.size === 0) this.bySymbol.delete(symbol);
    }
  }

  /** Exposed for tests and for the metrics endpoint. */
  get size(): { symbols: number; accounts: number } {
    return { symbols: this.bySymbol.size, accounts: this.known.size };
  }

  private onDomainEvent(envelope: DomainEventEnvelope): void {
    // Only the widening direction is handled here. Closing a position leaves the
    // pair in place until the rebuild removes it, which costs one unnecessary
    // valuation and cannot cost a missed one.
    if (envelope.event !== DomainEvent.POSITION_OPENED) return;
    const symbol = envelope.data['symbol'];
    if (typeof symbol !== 'string') return;
    this.add(symbol, envelope.accountId);
  }

  private add(symbol: string, accountId: string): void {
    const holders = this.bySymbol.get(symbol);
    if (holders === undefined) this.bySymbol.set(symbol, new Set([accountId]));
    else holders.add(accountId);
  }

  /** Populates the index for accounts it has never seen. One query, once each. */
  private async load(accountIds: readonly string[]): Promise<void> {
    const rows = await this.read(accountIds);
    for (const accountId of accountIds) this.known.add(accountId);
    for (const row of rows) this.add(row.symbol, row.accountId);
  }

  /**
   * Re-derives the whole index from the database.
   *
   * Clears first, so a position closed while nobody was looking disappears. The
   * clear is scoped to the accounts being rebuilt: an account that is between
   * ticks must not lose its entry because a different account was refreshed.
   */
  private async rebuild(accountIds: readonly string[], nowMs: number): Promise<void> {
    this.lastRebuiltAt = nowMs;
    let rows: Array<{ accountId: string; symbol: string }>;
    try {
      rows = await this.read(accountIds);
    } catch (error) {
      // A failed rebuild leaves the previous index in place, which is stale in
      // the safe direction. Silence would not be safe, so it is logged.
      this.logger.error({ err: error }, 'Exposure index rebuild failed; serving the previous one');
      return;
    }

    const rebuilding = new Set(accountIds);
    for (const [symbol, holders] of this.bySymbol) {
      for (const accountId of holders) if (rebuilding.has(accountId)) holders.delete(accountId);
      if (holders.size === 0) this.bySymbol.delete(symbol);
    }
    for (const row of rows) this.add(row.symbol, row.accountId);
  }

  private async read(
    accountIds: readonly string[],
  ): Promise<Array<{ accountId: string; symbol: string }>> {
    const positions = await this.prisma.position.findMany({
      where: { status: { in: ['OPEN', 'CLOSING'] }, accountId: { in: [...accountIds] } },
      select: { accountId: true, symbol: { select: { code: true } } },
    });
    return positions.map((position) => ({
      accountId: position.accountId,
      symbol: position.symbol.code,
    }));
  }
}
