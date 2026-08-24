import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import {
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  MessageBody,
  ConnectedSocket,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server } from 'socket.io';
import { z } from 'zod';
import { isDomainError, PUBLIC_CHANNELS, WsChannel, type WsEvent } from '@tp/shared-types';
import type { Tick } from '@tp/market-core';
import { TokenService } from '../auth/token.service';
import { PrismaService } from '../prisma/prisma.service';
import { QuoteService } from '../market/quote.service';
import { TickBus } from '../market/tick-bus';
import { MetricsService } from '../metrics/metrics.service';
import { RedisService } from '../redis/redis.service';
import { DOMAIN_EVENT_CHANNEL, EventsService, type DomainEventEnvelope } from './events.service';
import { initialState, type TradingSocket } from './socket.types';

const subscribeSchema = z
  .object({
    channel: z.enum([
      WsChannel.QUOTES,
      WsChannel.CANDLES,
      WsChannel.ORDERS,
      WsChannel.POSITIONS,
      WsChannel.ACCOUNT,
      WsChannel.PNL,
    ]),
    symbols: z.array(z.string().min(1).max(20)).max(100).optional(),
  })
  .strict();

/**
 * Maps a domain event onto the channel and wire event a client sees.
 * An event with no mapping is simply not broadcast — adding one is a deliberate
 * act, not something that happens because a name looked similar.
 */
const EVENT_ROUTING: Readonly<Record<string, { channel: WsChannel; wire: string }>> = {
  'order.created': { channel: WsChannel.ORDERS, wire: 'order.created' },
  'order.accepted': { channel: WsChannel.ORDERS, wire: 'order.updated' },
  'order.rejected': { channel: WsChannel.ORDERS, wire: 'order.updated' },
  'order.filled': { channel: WsChannel.ORDERS, wire: 'order.filled' },
  'order.cancelled': { channel: WsChannel.ORDERS, wire: 'order.cancelled' },
  'position.opened': { channel: WsChannel.POSITIONS, wire: 'position.created' },
  'position.modified': { channel: WsChannel.POSITIONS, wire: 'position.updated' },
  'position.closed': { channel: WsChannel.POSITIONS, wire: 'position.closed' },
  'balance.changed': { channel: WsChannel.ACCOUNT, wire: 'account.updated' },
  'margin.call': { channel: WsChannel.ACCOUNT, wire: 'account.updated' },
  liquidation: { channel: WsChannel.POSITIONS, wire: 'position.closed' },
};

@Injectable()
@WebSocketGateway({
  path: '/ws',
  // The browser client is served from a different origin in development; the
  // allowlist is applied in main.ts and mirrored here.
  cors: { origin: true, credentials: true },
})
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnApplicationShutdown
{
  private readonly logger = new Logger(RealtimeGateway.name);
  private readonly sockets = new Set<TradingSocket>();
  private unsubscribeTicks: (() => void) | null = null;
  private unsubscribeEvents: (() => void) | null = null;

  /**
   * Held for room-based broadcast in a later phase. Fan-out today is explicit:
   * every frame is filtered per socket against its account set, because a
   * Socket.IO room would have to be trusted to contain the right sockets and
   * this filter can be read in one place.
   */
  @WebSocketServer()
  readonly server!: Server;

  constructor(
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
    private readonly quotes: QuoteService,
    private readonly ticks: TickBus,
    private readonly events: EventsService,
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
  ) {}

  async afterInit(): Promise<void> {
    this.unsubscribeTicks = this.ticks.subscribe((tick) => this.onTick(tick));
    this.unsubscribeEvents = this.events.onEvent((envelope) => this.onDomainEvent(envelope));

    // Frames produced by other API instances arrive here.
    await this.redis.subscriber.subscribe(DOMAIN_EVENT_CHANNEL);
    this.redis.subscriber.on('message', (channel, payload) => {
      if (channel !== DOMAIN_EVENT_CHANNEL) return;
      try {
        this.onDomainEvent(JSON.parse(payload) as DomainEventEnvelope);
      } catch (error) {
        this.logger.error({ err: error }, 'Unreadable domain event from Redis');
      }
    });

    this.logger.log('WebSocket gateway ready on /ws');
  }

  async onApplicationShutdown(): Promise<void> {
    this.unsubscribeTicks?.();
    this.unsubscribeEvents?.();
    await this.redis.subscriber.unsubscribe(DOMAIN_EVENT_CHANNEL).catch(() => undefined);
  }

  /**
   * Authentication happens at connect, not at subscribe.
   *
   * A socket that cannot prove who it is may still connect — public quotes are
   * public — but it never acquires an account, and every private channel is
   * filtered by account membership. There is no message a client can send that
   * grants it access it did not arrive with.
   */
  async handleConnection(client: TradingSocket): Promise<void> {
    client.state = initialState();
    this.sockets.add(client);
    this.metrics.websocketConnections.inc({ event: 'connect' });

    const token = extractToken(client);
    if (token === null) return;

    try {
      const claims = await this.tokens.verifyAccessToken(token);
      const accounts = await this.prisma.account.findMany({
        where: { userId: claims.sub },
        select: { id: true },
      });
      client.state.userId = claims.sub;
      // The account set is resolved from the database at connect, never taken
      // from anything the client sends.
      for (const account of accounts) client.state.accountIds.add(account.id);
    } catch (error) {
      this.metrics.websocketConnections.inc({ event: 'auth_failed' });
      client.emit('error', {
        code: isDomainError(error) ? error.code : 'UNAUTHENTICATED',
        message: 'Authentication failed; only public channels are available',
      });
    }
  }

  handleDisconnect(client: TradingSocket): void {
    this.sockets.delete(client);
    this.metrics.websocketConnections.inc({ event: 'disconnect' });
  }

  @SubscribeMessage('subscribe')
  handleSubscribe(
    @ConnectedSocket() client: TradingSocket,
    @MessageBody() body: unknown,
  ): { ok: boolean; channel?: string; error?: string } {
    const parsed = subscribeSchema.safeParse(body);
    if (!parsed.success) {
      return { ok: false, error: 'Invalid subscribe message' };
    }
    const { channel, symbols } = parsed.data;

    const isPublic = PUBLIC_CHANNELS.includes(channel);
    if (!isPublic && client.state.userId === null) {
      return { ok: false, channel, error: 'This channel requires authentication' };
    }

    client.state.channels.add(channel);
    if (symbols !== undefined) {
      for (const symbol of symbols) client.state.symbols.add(symbol.toUpperCase());
    }
    return { ok: true, channel };
  }

  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(
    @ConnectedSocket() client: TradingSocket,
    @MessageBody() body: unknown,
  ): { ok: boolean } {
    const parsed = subscribeSchema.safeParse(body);
    if (!parsed.success) return { ok: false };
    client.state.channels.delete(parsed.data.channel);
    return { ok: true };
  }

  /** Lets a client confirm what the server believes about it. */
  @SubscribeMessage('whoami')
  handleWhoami(@ConnectedSocket() client: TradingSocket): {
    authenticated: boolean;
    accounts: number;
    channels: string[];
    seq: number;
  } {
    return {
      authenticated: client.state.userId !== null,
      accounts: client.state.accountIds.size,
      channels: [...client.state.channels],
      seq: client.state.seq,
    };
  }

  private onTick(tick: Tick): void {
    const quote = this.quotes.toDto(tick);
    for (const socket of this.sockets) {
      if (!socket.state.channels.has(WsChannel.QUOTES)) continue;
      // An empty symbol set means "everything"; a non-empty one filters.
      if (socket.state.symbols.size > 0 && !socket.state.symbols.has(tick.symbol)) continue;
      this.send(socket, 'quote.update', quote);
    }
  }

  private onDomainEvent(envelope: DomainEventEnvelope): void {
    const route = EVENT_ROUTING[envelope.event];
    if (route === undefined) return;

    for (const socket of this.sockets) {
      if (!socket.state.channels.has(route.channel)) continue;
      // The account filter is the whole of the private-channel guarantee.
      if (!socket.state.accountIds.has(envelope.accountId)) continue;
      this.send(socket, route.wire, envelope.data);
    }
  }

  /** Pushes a frame to one account's sockets. Used by the tick-driven valuations. */
  sendToAccount(accountId: string, channel: WsChannel, event: string, data: unknown): number {
    let delivered = 0;
    for (const socket of this.sockets) {
      if (!socket.state.channels.has(channel)) continue;
      if (!socket.state.accountIds.has(accountId)) continue;
      this.send(socket, event, data);
      delivered += 1;
    }
    return delivered;
  }

  /** Accounts with at least one socket listening on a channel. */
  listeningAccounts(channel: WsChannel): Set<string> {
    const accounts = new Set<string>();
    for (const socket of this.sockets) {
      if (!socket.state.channels.has(channel)) continue;
      for (const accountId of socket.state.accountIds) accounts.add(accountId);
    }
    return accounts;
  }

  get connectionCount(): number {
    return this.sockets.size;
  }

  private send(socket: TradingSocket, event: string, data: unknown): void {
    socket.state.seq += 1;
    socket.emit('frame', {
      event: event as WsEvent,
      data,
      seq: socket.state.seq,
      timestamp: Date.now(),
    });
  }
}

/**
 * Reads the access token from the handshake.
 *
 * `auth` is preferred over a query parameter: query strings end up in proxy
 * logs, and a bearer token in a log file is a credential leak.
 */
function extractToken(client: TradingSocket): string | null {
  const auth = client.handshake.auth as { token?: unknown } | undefined;
  if (typeof auth?.token === 'string' && auth.token.length > 0) return auth.token;

  const header = client.handshake.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim();
  }
  return null;
}
