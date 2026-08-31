import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { CloseReason, DomainEvent } from '@tp/shared-types';
import { withTenant } from '@tp/tenancy';
import { EventsService, type DomainEventEnvelope } from '../realtime/events.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from './notifications.service';

/**
 * Turns what happened into what the trader is told.
 *
 * ## One subscriber, not eight call sites
 *
 * Orders and positions publish domain events from eight places, and the trigger
 * engine will add more. Adding a `notifications.raise(...)` beside each one is
 * the change that gets forgotten at the ninth site — and a missing notification
 * is invisible until somebody complains that their stop loss fired without
 * telling them. Subscribing once means a new event is covered by default.
 *
 * ## Only after the fact, never on intent
 *
 * §16 is explicit: do not notify because the user pressed Buy. These events are
 * published *after the transaction commits* — the publishing services say so in
 * their own comments — so subscribing here inherits that guarantee rather than
 * restating it. There is no path from a rejected or rolled-back order to a
 * notification, because there is no event.
 *
 * ## Two instances, one notice
 *
 * A handler registered here runs on the instance that published *and* on every
 * instance that receives the envelope over Redis. So both would raise the same
 * notice. `dedupeKey` is the envelope's own `eventId`, which is generated once
 * at publication and travels with it, so the second job is a no-op at the
 * database — the same mechanism that already collapses two producers noticing
 * one margin call, reused rather than reinvented.
 */
@Injectable()
export class TradingNotificationsService implements OnModuleInit {
  private readonly logger = new Logger(TradingNotificationsService.name);
  /** accountId → owner. An account does not change hands, so this is safe to keep. */
  private readonly owners = new Map<string, AccountOwner | null>();

  constructor(
    private readonly events: EventsService,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.events.onEvent((envelope) => this.handle(envelope));
  }

  private async handle(envelope: DomainEventEnvelope): Promise<void> {
    const notice = describe(envelope);
    if (notice === null) return;

    if (envelope.tenantId === null) {
      // An event published outside any tenant scope cannot be filed anywhere.
      // Loud, because it means a publisher lost its scope, and the notice is
      // the least of what else would be wrong.
      this.logger.error(
        { event: envelope.event, eventId: envelope.eventId },
        'A domain event carried no tenant; no notification was raised',
      );
      return;
    }

    /**
     * The scope is entered explicitly, from the envelope.
     *
     * On the publishing instance a request scope is still active and this is
     * redundant. On every *other* instance the envelope arrived over Redis with
     * no request behind it, and without this the first database read throws.
     * Entering it unconditionally means the two paths are the same path.
     */
    await withTenant({ tenantId: envelope.tenantId, slug: envelope.tenantId }, async () => {
      const owner = await this.ownerOf(envelope.accountId);
      if (owner === null) return;

      await this.notifications.raise({
        userId: owner.userId,
        kind: notice.kind,
        severity: notice.severity,
        title: notice.title(owner.accountNumber),
        body: notice.body,
        data: {
          // Carried so the client can correlate this with the socket frame for
          // the same occurrence and process it once. §26.
          eventId: envelope.eventId,
          ...envelope.data,
        },
        accountId: envelope.accountId,
        dedupeKey: envelope.eventId,
      });
    });
  }

  private async ownerOf(accountId: string): Promise<AccountOwner | null> {
    const cached = this.owners.get(accountId);
    if (cached !== undefined) return cached;

    /**
     * `findFirst`, not `findUnique`.
     *
     * The tenant extension injects `tenantId` into every filter, and Prisma's
     * strict unique input refuses the extra key on models whose uniques cannot
     * accommodate it — see the note in packages/tenancy/src/scope.ts, which
     * says such models are reached through `findFirst`. `Account` happens to
     * tolerate `findUnique` today (checked, not assumed); `findFirst` is used
     * because it tolerates the extension on every model, so this line does not
     * become a runtime error the day a unique index changes shape.
     */
    const account = await this.prisma.account.findFirst({
      where: { id: accountId },
      select: { userId: true, number: true },
    });
    const owner =
      account === null ? null : { userId: account.userId, accountNumber: String(account.number) };
    this.owners.set(accountId, owner);
    return owner;
  }
}

interface AccountOwner {
  userId: string;
  accountNumber: string;
}

interface Notice {
  kind: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  title: (accountNumber: string) => string;
  body: string;
}

const text = (data: Record<string, unknown>, key: string): string | null => {
  const value = data[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

/**
 * What, if anything, to say about an event.
 *
 * Returns null for events that are not worth a notification — `BALANCE_CHANGED`
 * fires on every close and would double every trade notice, and
 * `ORDER_ACCEPTED` tells a trader something their own screen already showed
 * them a moment ago. A platform that notifies about everything is one whose
 * users turn notifications off, which costs them the two that mattered.
 *
 * Pure and exported, so the wording is testable without a database.
 */
export function describe(envelope: DomainEventEnvelope): Notice | null {
  const data = envelope.data;
  const symbol = text(data, 'symbol') ?? 'the instrument';

  switch (envelope.event) {
    case DomainEvent.POSITION_OPENED: {
      const side = text(data, 'side') ?? '';
      const volume = text(data, 'volume') ?? '';
      const price = text(data, 'entryPrice') ?? text(data, 'price') ?? '';
      return {
        kind: 'position.opened',
        severity: 'INFO',
        title: () => `${symbol} ${side} opened`,
        body: [`${volume} ${symbol}`, side, price === '' ? null : `at ${price}`]
          .filter((part) => part !== null && part !== '')
          .join(' '),
      };
    }

    case DomainEvent.POSITION_CLOSED: {
      const reason = text(data, 'reason') ?? CloseReason.MANUAL;
      const pnl = text(data, 'netPnl') ?? '0';
      const exit = text(data, 'exitPrice') ?? '';
      const partial = data['fullyClosed'] === false;

      /**
       * A stop loss and a take profit are their own categories.
       *
       * §18 and §24 both treat them separately from an ordinary close, and a
       * trader who has muted routine closes has almost certainly not muted the
       * one that took them out of a losing position.
       */
      const kind =
        reason === CloseReason.STOP_LOSS || reason === CloseReason.TRAILING_STOP
          ? 'position.stop_loss'
          : reason === CloseReason.TAKE_PROFIT
            ? 'position.take_profit'
            : partial
              ? 'position.partial_close'
              : 'position.closed';

      const headline =
        reason === CloseReason.STOP_LOSS
          ? `${symbol} stopped out`
          : reason === CloseReason.TRAILING_STOP
            ? `${symbol} trailing stop hit`
            : reason === CloseReason.TAKE_PROFIT
              ? `${symbol} take profit hit`
              : reason === CloseReason.LIQUIDATION
                ? `${symbol} liquidated`
                : partial
                  ? `${symbol} partially closed`
                  : `${symbol} closed`;

      return {
        kind,
        severity: reason === CloseReason.LIQUIDATION ? 'CRITICAL' : 'INFO',
        title: () => headline,
        // The sign is carried by the number itself; a leading '+' is added so a
        // profit reads as one at a glance on a lock screen.
        body: [exit === '' ? null : `Exit ${exit}`, `P&L ${pnl.startsWith('-') ? pnl : `+${pnl}`}`]
          .filter((part) => part !== null)
          .join(' · '),
      };
    }

    case DomainEvent.POSITION_MODIFIED: {
      const stopLoss = text(data, 'stopLoss');
      const takeProfit = text(data, 'takeProfit');
      const changes = [
        stopLoss === null ? 'stop loss removed' : `stop loss ${stopLoss}`,
        takeProfit === null ? 'take profit removed' : `take profit ${takeProfit}`,
      ];
      return {
        kind: 'position.modified',
        severity: 'INFO',
        title: () => `${symbol} position changed`,
        body: changes.join(', '),
      };
    }

    case DomainEvent.ORDER_CANCELLED: {
      const reason = text(data, 'reason');
      return {
        kind: 'order.cancelled',
        severity: 'INFO',
        title: () => `${symbol} order cancelled`,
        body: reason === null ? 'The order was cancelled.' : `Reason: ${reason.toLowerCase()}.`,
      };
    }

    /**
     * `ORDER_FILLED` deliberately raises nothing on its own.
     *
     * Every fill in this platform opens a position, and both events are
     * published together. Notifying on both would buzz a trader's phone twice
     * for one action — which is precisely the duplicate §26 is about, arriving
     * by design rather than by accident.
     */
    case DomainEvent.ORDER_FILLED:
    case DomainEvent.ORDER_CREATED:
    case DomainEvent.ORDER_ACCEPTED:
    case DomainEvent.ORDER_REJECTED:
    case DomainEvent.BALANCE_CHANGED:
    case DomainEvent.MARGIN_CALL:
    case DomainEvent.LIQUIDATION:
      /**
       * `MARGIN_CALL` and `LIQUIDATION` are raised by the risk path, which
       * knows the margin level and the thresholds and can therefore say
       * something useful. Raising them here as well would be a second source
       * for one notice.
       */
      return null;

    default:
      return null;
  }
}
