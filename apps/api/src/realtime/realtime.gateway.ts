import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
import {
  DomainError,
  TradingErrorCode,
  isDomainError,
  PUBLIC_CHANNELS,
  WsChannel,
  WsEvent,
  type QuoteDto,
} from '@tp/shared-types';
import type { Tick } from '@tp/market-core';
import { TokenService } from '../auth/token.service';
import { PrismaService } from '../prisma/prisma.service';
import { QuoteService } from '../market/quote.service';
import { TickBus } from '../market/tick-bus';
import { CandleBus, type CandleUpdate } from '../market/candle-bus';
import { MetricsService } from '../metrics/metrics.service';
import { RedisService } from '../redis/redis.service';
import { DOMAIN_EVENT_CHANNEL, EventsService, type DomainEventEnvelope } from './events.service';
import { rateLimits, socketCorsOrigins, type Env } from '../config/env.schema';
import { initialState, type TradingSocket } from './socket.types';
import { TenantResolver } from '../tenancy/tenant-resolver.service';
import { buildMarker } from '@tp/crypto-core';
import { withTenant, type TenantContext } from '@tp/tenancy';

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
    // Candle resolutions, e.g. ['1', '15']. Ignored on other channels.
    resolutions: z.array(z.string().min(1).max(4)).max(10).optional(),
  })
  .strict();

/** What a candle subscription gets when it does not name a resolution. */
const DEFAULT_RESOLUTION = '1';

/**
 * How often every authenticated socket's authority is re-checked.
 *
 * A minute of over-delivery on a revoked link is not nothing, and it is a great
 * deal less than the alternative, which was until the client happened to
 * reconnect.
 */
const SOCKET_REFRESH_MS = 60_000;

/** The inbound-message window. Fixed, and the same length as the HTTP one. */
const SOCKET_WINDOW_MS = 60_000;

/**
 * Maps a domain event onto the channel and wire event a client sees.
 * An event with no mapping is simply not broadcast — adding one is a deliberate
 * act, not something that happens because a name looked similar.
 */
export const EVENT_ROUTING: Readonly<Record<string, { channel: WsChannel; wire: WsEvent }>> = {
  'order.created': { channel: WsChannel.ORDERS, wire: WsEvent.ORDER_CREATED },
  'order.accepted': { channel: WsChannel.ORDERS, wire: WsEvent.ORDER_UPDATED },
  // Its own wire event, not `order.updated`. See WsEvent.ORDER_REJECTED.
  'order.rejected': { channel: WsChannel.ORDERS, wire: WsEvent.ORDER_REJECTED },
  'order.filled': { channel: WsChannel.ORDERS, wire: WsEvent.ORDER_FILLED },
  'order.cancelled': { channel: WsChannel.ORDERS, wire: WsEvent.ORDER_CANCELLED },
  'position.opened': { channel: WsChannel.POSITIONS, wire: WsEvent.POSITION_CREATED },
  'position.modified': { channel: WsChannel.POSITIONS, wire: WsEvent.POSITION_UPDATED },
  'position.closed': { channel: WsChannel.POSITIONS, wire: WsEvent.POSITION_CLOSED },
  /*
   * `balance.changed` and `margin.call` are deliberately not here. Both were
   * routed to `account.updated`, whose contract (see WsEvent.ACCOUNT_UPDATED)
   * is the whole consistent set of account figures in one frame — and both
   * carried their own small payloads instead: `{ balance, cause }` after every
   * close. The terminal applied it as the account, replacing every figure it
   * held with a two-field object; only the header's account-id guard kept the
   * screen from showing it. The figures a close changes arrive with the next
   * valuation, the REST refetch the close triggers, and — for a margin call —
   * `risk.updated`. Found by `pnpm smoke:contracts`, which checks real frames
   * against the types the clients read them as.
   */
  liquidation: { channel: WsChannel.POSITIONS, wire: WsEvent.POSITION_CLOSED },
};

/**
 * The response header on the Engine.IO handshake that names the running build.
 * Read by `scripts/verify-production.ts`; the value is `buildMarker()`.
 */
export const BUILD_HEADER = 'x-tp-build';

@Injectable()
@WebSocketGateway({
  path: '/ws',
  /**
   * The same allowlist the HTTP side uses.
   *
   * This was `origin: true`, which reflects whatever `Origin` the request
   * carried — so any site on the internet could open an authenticated socket
   * against this API from a logged-in trader's browser and read their
   * positions, orders and account in real time. The HTTP side had been on an
   * allowlist since it was written; the socket had not.
   *
   * Read from `process.env` rather than `ConfigService` because a decorator is
   * evaluated before the container exists. See `socketCorsOrigins`.
   */
  cors: { origin: socketCorsOrigins(), credentials: true },
})
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnApplicationShutdown
{
  private readonly logger = new Logger(RealtimeGateway.name);
  private readonly sockets = new Set<TradingSocket>();
  private readonly abandonListeners = new Set<(accountId: string) => void>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private unsubscribeTicks: (() => void) | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private unsubscribeCandles: (() => void) | null = null;
  /** The newest quote per symbol since the last flush. See `onTick`. */
  private readonly pendingQuotes = new Map<string, QuoteDto>();
  private quoteFlushTimer: NodeJS.Timeout | null = null;

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
    private readonly candles: CandleBus,
    private readonly events: EventsService,
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
    private readonly tenants: TenantResolver,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async afterInit(): Promise<void> {
    /**
     * Re-check every authenticated socket on an interval.
     *
     * Two things a long-lived connection gets wrong without it, both about
     * authority the socket acquired once and then kept:
     *
     * 1. **An expired token.** A WebSocket outlives the fifteen-minute access
     *    token that opened it. Before this, a socket authenticated at nine
     *    o'clock was still streaming private frames at five — past a session
     *    the user may have ended from another device.
     *
     * 2. **A stale account set.** It was resolved at connect and never again,
     *    so a master-account link revoked this morning went on delivering
     *    somebody else's positions until the operator happened to reconnect,
     *    and an account opened after connect delivered nothing at all.
     *
     * The interval is the granularity of both. A minute of over-delivery on a
     * revoked link is not nothing, and it is a great deal less than a day.
     */
    this.scheduleRefresh();

    this.unsubscribeTicks = this.ticks.subscribe((tick) => this.onTick(tick));
    this.unsubscribeCandles = this.candles.subscribe((update) => this.onCandle(update));
    this.unsubscribeEvents = this.events.onEvent((envelope) => this.onDomainEvent(envelope));

    /**
     * Frames produced by other API instances arrive here.
     *
     * Routed through `EventsService.deliverRemote` rather than straight into
     * `onDomainEvent`, because that is where this instance's own echo is
     * refused. Redis delivers a published message to every subscriber including
     * the publisher — the two are separate connections, so Redis cannot know
     * they are one process — and calling `onDomainEvent` directly meant every
     * event was handled twice on the instance that raised it.
     */
    await this.redis.subscriber.subscribe(DOMAIN_EVENT_CHANNEL);
    this.redis.subscriber.on('message', (channel, payload) => {
      if (channel !== DOMAIN_EVENT_CHANNEL) return;
      try {
        void this.events.deliverRemote(JSON.parse(payload) as DomainEventEnvelope);
      } catch (error) {
        this.logger.error({ err: error }, 'Unreadable domain event from Redis');
      }
    });

    /**
     * The handshake names the build it came from.
     *
     * The HTTP instances say which build they run in `/health`, and
     * `verify:production` checks it against the commit that was deployed. The
     * real-time service is a *separate container* on the same image — nginx
     * sends `/ws` to `api-ws` and everything else to `api` — and nothing asked
     * it the same question. So on 21 September the API answered with the
     * deployed commit while the socket service, sixteen commits and seven API
     * changes behind, had been "Up 2 days": the upgrade script's build list
     * and its pre-migration stop list both omitted it. Every check was green.
     *
     * A route cannot carry the answer: Engine.IO owns every request under its
     * path and answers `/ws/anything` itself. The handshake response's headers
     * are the one thing under `/ws` this code gets to write, so the marker
     * goes there, and `verify:production` reads it from the same polling
     * handshake it already performs. The header is the digest `/health`
     * publishes, not the commit hash — see `buildMarker`.
     */
    this.server.engine.on('initial_headers', (headers: Record<string, string>) => {
      headers[BUILD_HEADER] = buildMarker();
    });

    this.logger.log('WebSocket gateway ready on /ws');
  }

  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    if (this.quoteFlushTimer !== null) clearTimeout(this.quoteFlushTimer);
    this.quoteFlushTimer = null;
    this.pendingQuotes.clear();
    this.unsubscribeTicks?.();
    this.unsubscribeCandles?.();
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

    /**
     * Published before the first `await`, and awaited by `subscribe`.
     *
     * Socket.IO fires the client's `connect` event as soon as the transport is
     * up — which is *before* this method has finished its two database reads. A
     * terminal that subscribes on `connect`, as every one does, was racing them:
     * win and the private channels attach, lose and all three are refused with
     * "requires authentication" while `whoami` cheerfully reports the socket as
     * authenticated. The client is then silently deaf to its own positions,
     * orders and account until it reconnects.
     *
     * It is a race, so it passed most of the time and failed under exactly the
     * conditions that matter: a slow database, or a hundred traders connecting
     * at once.
     */
    let ready: () => void = () => undefined;
    client.state.authenticated = new Promise<void>((resolve) => {
      ready = resolve;
    });

    const token = extractToken(client);
    if (token === null) {
      ready();
      return;
    }

    try {
      const claims = await this.tokens.verifyAccessToken(token);

      /**
       * The same check the HTTP guard makes: the token's tenant must be the one
       * this hostname serves.
       *
       * A socket carries no request and runs no middleware, so the tenant is
       * resolved here from the handshake's Host header and then verified
       * against the signed claim. Skipping it and trusting `tid` alone would
       * make the socket the one door where a token from another tenant works.
       */
      const tenant = await this.tenants.forHost(client.handshake.headers.host);
      if (claims.tid !== tenant.tenantId) {
        throw new DomainError(TradingErrorCode.UNAUTHENTICATED, 'Invalid access token');
      }
      /**
       * Two ways to reach an account, resolved the same way the REST resolver
       * resolves them: the ones this user owns, and the ones an active link
       * from an active master account they operate points at.
       *
       * Both are read from the database at connect and never taken from
       * anything the client sends. A revoked link stops appearing on the next
       * connection rather than the next frame — the set is a snapshot, as it
       * always was for ownership, and the reconnect contract in
       * docs/websocket.md is what refreshes it.
       */
      const [owned, linked] = await withTenant(tenant, () =>
        Promise.all([
          this.prisma.account.findMany({ where: { userId: claims.sub }, select: { id: true } }),
          this.prisma.masterAccountLink.findMany({
            where: {
              status: 'ACTIVE',
              master: { userId: claims.sub, status: 'ACTIVE' },
            },
            select: { accountId: true },
          }),
        ]),
      );
      client.state.userId = claims.sub;
      client.state.tenantId = tenant.tenantId;
      client.state.tenantSlug = tenant.slug;
      // `exp` is in seconds, as the JWT standard writes it.
      client.state.tokenExpiresAt = claims.exp === undefined ? null : claims.exp * 1000;
      for (const account of owned) client.state.accountIds.add(account.id);
      for (const link of linked) client.state.accountIds.add(link.accountId);
    } catch (error) {
      this.metrics.websocketConnections.inc({ event: 'auth_failed' });
      client.emit('error', {
        code: isDomainError(error) ? error.code : 'UNAUTHENTICATED',
        message: 'Authentication failed; only public channels are available',
      });
    } finally {
      // Released on every path, including the failure one. A socket that could
      // not authenticate must still be allowed to subscribe to public quotes
      // rather than hanging on a promise nobody will ever resolve.
      ready();
    }
  }

  handleDisconnect(client: TradingSocket): void {
    this.sockets.delete(client);
    this.metrics.websocketConnections.inc({ event: 'disconnect' });

    /**
     * Tell whoever is holding per-account state that nobody is watching any
     * more — but only for accounts no *other* socket still covers. A trader with
     * the terminal open in two tabs closing one must not stop the other's
     * valuations.
     *
     * `forget` existed with no caller before this, so every map keyed by account
     * grew for the life of the process. Small, unbounded, and invisible to a
     * fifteen-minute soak.
     */
    for (const accountId of client.state.accountIds) {
      if (this.isWatched(accountId)) continue;
      for (const listener of this.abandonListeners) listener(accountId);
    }
  }

  /**
   * How many sockets are held open here, and how many of them are somebody.
   *
   * The split matters: a rising *anonymous* count is people looking at public
   * quotes, and a rising *authenticated* count is traders. They are different
   * events with different responses, and one number would hide both.
   */
  socketCounts(): { authenticated: number; anonymous: number } {
    let authenticated = 0;
    for (const socket of this.sockets) if (socket.state.userId !== null) authenticated += 1;
    return { authenticated, anonymous: this.sockets.size - authenticated };
  }

  /** Whether any remaining socket still covers this account. */
  private isWatched(accountId: string): boolean {
    for (const socket of this.sockets) if (socket.state.accountIds.has(accountId)) return true;
    return false;
  }

  /**
   * Registers interest in "the last socket for this account went away".
   *
   * A callback rather than a direct call into `RealtimeService`, because the
   * gateway is constructed first and a hard reference the other way would be a
   * circular dependency for the sake of one notification.
   */
  onAccountAbandoned(listener: (accountId: string) => void): () => void {
    this.abandonListeners.add(listener);
    return () => {
      this.abandonListeners.delete(listener);
    };
  }

  /**
   * A self-rescheduling timeout rather than an interval.
   *
   * `setInterval` queues its callback behind a slow pass and then fires them
   * back to back, so a database stall would be followed by a burst of refreshes
   * all reading the same rows. Rescheduling *after* the work finishes cannot do
   * that. The market feed's pump loop is written the same way, for the same
   * reason.
   */
  private scheduleRefresh(): void {
    this.refreshTimer = setTimeout(() => {
      void this.refreshSockets()
        .catch((error: unknown) => {
          this.logger.error({ err: error }, 'Socket authority refresh failed');
        })
        .finally(() => {
          this.refreshTimer = null;
          if (!this.shuttingDown) this.scheduleRefresh();
        });
    }, SOCKET_REFRESH_MS);
    // Nothing here should hold the process open at shutdown.
    this.refreshTimer.unref?.();
  }

  /**
   * Re-derives what every authenticated socket is still allowed to see.
   *
   * Exposed for tests, which drive it directly rather than waiting a minute.
   */
  async refreshSockets(nowMs: number = Date.now()): Promise<void> {
    const authenticated = [...this.sockets].filter((socket) => socket.state.userId !== null);
    if (authenticated.length === 0) return;

    for (const socket of authenticated) {
      const expiresAt = socket.state.tokenExpiresAt;
      if (expiresAt !== null && expiresAt <= nowMs) {
        this.downgrade(
          socket,
          'TOKEN_EXPIRED',
          'The access token this socket opened with has expired; reconnect with a fresh one',
        );
        continue;
      }

      const { userId, tenantId, tenantSlug } = socket.state;
      if (userId === null) continue;
      if (tenantId === null || tenantSlug === null) {
        // Authenticated without a tenant should be impossible — it is set beside
        // the user id at connection. If it ever is not, the socket cannot be
        // re-authorised, and a socket whose authority cannot be checked does not
        // keep it.
        this.downgrade(
          socket,
          'UNAUTHENTICATED',
          'This socket could not be re-authorised; reconnect',
        );
        continue;
      }

      /**
       * In the socket's own tenant, not outside every tenant.
       *
       * This pass runs on a timer, so nothing puts a tenant in scope for it —
       * and the query it makes is `which accounts may this user see`, which is
       * the most tenant-shaped question on the platform. Running it unscoped
       * would answer with accounts from every firm and then *grant* them to the
       * socket, since what it finds is what the socket is allowed to receive.
       */
      const allowed = await withTenant({ tenantId, slug: tenantSlug }, () =>
        this.accountsFor(userId),
      );
      // Removed first: authority that has been taken away must stop being
      // honoured before anything else about this pass can go wrong.
      for (const accountId of [...socket.state.accountIds]) {
        if (!allowed.has(accountId)) socket.state.accountIds.delete(accountId);
      }
      for (const accountId of allowed) socket.state.accountIds.add(accountId);
    }
  }

  /**
   * Strips a socket of its identity without closing it.
   *
   * Closing would be simpler and worse: the client reconnects immediately with
   * the same dead token, and the pair of them spin. Downgraded, the socket keeps
   * delivering public quotes — which it is still entitled to — while its private
   * channels go quiet and it has been told why.
   */
  private downgrade(socket: TradingSocket, code: string, message: string): void {
    socket.state.userId = null;
    socket.state.tokenExpiresAt = null;
    const abandoned = [...socket.state.accountIds];
    socket.state.accountIds.clear();
    socket.emit('error', { code, message });
    this.metrics.websocketConnections.inc({ event: 'downgraded' });

    for (const accountId of abandoned) {
      if (this.isWatched(accountId)) continue;
      for (const listener of this.abandonListeners) listener(accountId);
    }
  }

  /** Every account this user may see: the ones they own and the ones linked to them. */
  private async accountsFor(userId: string): Promise<Set<string>> {
    const [owned, linked] = await Promise.all([
      this.prisma.account.findMany({ where: { userId }, select: { id: true } }),
      this.prisma.masterAccountLink.findMany({
        where: { status: 'ACTIVE', master: { userId, status: 'ACTIVE' } },
        select: { accountId: true },
      }),
    ]);
    return new Set([...owned.map((row) => row.id), ...linked.map((row) => row.accountId)]);
  }

  /**
   * Has this socket sent more messages than it is allowed to?
   *
   * A fixed window per socket, which is coarse and right for the shape of the
   * traffic: a terminal sends five subscribes on connect and one more when the
   * chart changes instrument. Anything sending a hundred a minute is not a
   * terminal.
   *
   * The HTTP side has been rate-limited since it was written; the socket was
   * not, so `subscribe` in a loop was an unmetered way to make this process
   * parse and validate as fast as it could read.
   */
  private overBudget(socket: TradingSocket, nowMs: number = Date.now()): boolean {
    const state = socket.state;
    if (nowMs - state.windowStartedAt >= SOCKET_WINDOW_MS) {
      state.windowStartedAt = nowMs;
      state.messagesInWindow = 0;
    }
    state.messagesInWindow += 1;

    if (state.messagesInWindow <= rateLimits.socketMessages) return false;

    // Told once per window rather than on every refusal: a client in a loop
    // would otherwise be answered as fast as it asks, which is the traffic the
    // limit exists to stop.
    if (state.messagesInWindow === rateLimits.socketMessages + 1) {
      this.metrics.websocketConnections.inc({ event: 'rate_limited' });
      socket.emit('error', {
        code: 'RATE_LIMITED',
        message: 'Too many messages on this socket; slow down',
      });
    }
    return true;
  }

  @SubscribeMessage('subscribe')
  async handleSubscribe(
    @ConnectedSocket() client: TradingSocket,
    @MessageBody() body: unknown,
  ): Promise<{ ok: boolean; channel?: string; error?: string }> {
    if (this.overBudget(client)) return { ok: false, error: 'Rate limited' };

    const parsed = subscribeSchema.safeParse(body);
    if (!parsed.success) {
      return { ok: false, error: 'Invalid subscribe message' };
    }

    // Wait for this socket's identity to be resolved before deciding what it may
    // have. Without this the answer depends on whether two database reads
    // finished before the client's first message arrived.
    await client.state.authenticated;

    const { channel, symbols, resolutions } = parsed.data;

    const isPublic = PUBLIC_CHANNELS.includes(channel);
    if (!isPublic && client.state.userId === null) {
      return { ok: false, channel, error: 'This channel requires authentication' };
    }

    client.state.channels.add(channel);

    if (channel === WsChannel.CANDLES) {
      // Replaced, not accumulated: switching the chart from EURUSD 1m to
      // XAUUSD 15m must stop the old stream, or a trader who has changed
      // instrument four times is paying for four charts they cannot see.
      client.state.candleSymbols = new Set((symbols ?? []).map((s) => s.toUpperCase()));
      client.state.resolutions = new Set(resolutions ?? [DEFAULT_RESOLUTION]);
      return { ok: true, channel };
    }

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
    if (this.overBudget(client)) return { ok: false };

    const parsed = subscribeSchema.safeParse(body);
    if (!parsed.success) return { ok: false };
    client.state.channels.delete(parsed.data.channel);
    if (parsed.data.channel === WsChannel.CANDLES) {
      client.state.candleSymbols.clear();
      client.state.resolutions.clear();
    }
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
    this.overBudget(client);
    return {
      authenticated: client.state.userId !== null,
      accounts: client.state.accountIds.size,
      channels: [...client.state.channels],
      seq: client.state.seq,
    };
  }

  /**
   * Quotes are conflated, not relayed.
   *
   * One frame per tick per socket was the whole of the serving instance at a
   * thousand sockets: the load harness measured 104 frames a second on every
   * one of two hundred sockets — twenty thousand serialisations a second for
   * eight instruments — and at a thousand sockets the event loop stalled long
   * enough that a single order on its own took six seconds and lost the
   * leadership lease. The screen cannot use that many frames; a trader reads
   * a price, not a tick stream.
   *
   * So the newest quote per symbol is kept, and every `QUOTE_FANOUT_INTERVAL_MS`
   * each socket is sent one `quotes.updated` frame carrying what moved. Ten
   * frames a second, however fast the feed runs, and every price on screen is
   * at most an interval old. Nothing about *trading* changes: the engine
   * prices an order from its own quote, freshness-checked, not from anything a
   * client was shown.
   *
   * A self-rescheduling timeout rather than an interval, and only when there is
   * something to send: a still market sends nothing.
   */
  private onTick(tick: Tick): void {
    this.pendingQuotes.set(tick.symbol, this.quotes.toDto(tick));
    if (this.quoteFlushTimer !== null) return;
    const interval = this.config.get('QUOTE_FANOUT_INTERVAL_MS', { infer: true });
    if (interval === 0) {
      this.flushQuotes();
      return;
    }
    this.quoteFlushTimer = setTimeout(() => {
      this.quoteFlushTimer = null;
      this.flushQuotes();
    }, interval);
  }

  private flushQuotes(): void {
    if (this.pendingQuotes.size === 0 || this.shuttingDown) return;
    const moved = [...this.pendingQuotes.values()];
    this.pendingQuotes.clear();
    // One occurrence — this flush — however many sockets see it.
    const eventId = randomUUID();
    for (const socket of this.sockets) {
      if (!socket.state.channels.has(WsChannel.QUOTES)) continue;
      // An empty symbol set means "everything"; a non-empty one filters.
      const selected =
        socket.state.symbols.size > 0
          ? moved.filter((quote) => socket.state.symbols.has(quote.symbol))
          : moved;
      if (selected.length === 0) continue;
      this.send(socket, WsEvent.QUOTES_UPDATED, WsChannel.QUOTES, null, selected, eventId);
    }
  }

  /**
   * Relays candle updates to the charts that asked for them.
   *
   * Filtered on both symbol and resolution: a client watching one 1-minute
   * chart has no use for the other five resolutions the feed maintains, and
   * sending them would spend a trader's bandwidth on frames they discard.
   */
  private onCandle(update: CandleUpdate): void {
    const { candle } = update;
    for (const socket of this.sockets) {
      if (!socket.state.channels.has(WsChannel.CANDLES)) continue;
      if (socket.state.candleSymbols.size > 0 && !socket.state.candleSymbols.has(candle.symbol))
        continue;
      if (!socket.state.resolutions.has(candle.resolution)) continue;
      this.send(socket, WsEvent.CANDLE_UPDATE, WsChannel.CANDLES, null, {
        ...candle,
        closed: update.closed,
      });
    }
  }

  private onDomainEvent(envelope: DomainEventEnvelope): void {
    const route = EVENT_ROUTING[envelope.event];
    if (route === undefined) return;

    for (const socket of this.sockets) {
      if (!socket.state.channels.has(route.channel)) continue;
      // The account filter is the whole of the private-channel guarantee.
      if (!socket.state.accountIds.has(envelope.accountId)) continue;
      // The occurrence id travels from the publisher, so every socket that sees
      // this event sees the same id — including sockets on other instances.
      this.send(
        socket,
        route.wire,
        route.channel,
        envelope.accountId,
        envelope.data,
        envelope.eventId,
      );
    }
  }

  /** Pushes a frame to one account's sockets. Used by the tick-driven valuations. */
  sendToAccount(accountId: string, channel: WsChannel, event: WsEvent, data: unknown): number {
    let delivered = 0;
    for (const socket of this.sockets) {
      if (!socket.state.channels.has(channel)) continue;
      if (!socket.state.accountIds.has(accountId)) continue;
      this.send(socket, event, channel, accountId, data);
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

  /**
   * Which tenant each listening account belongs to.
   *
   * The valuation loop runs on a timer rather than inside a request, so it has
   * no tenant in scope and every query it makes would be refused — which is the
   * scope guard doing its job, not a nuisance to work around with a bypass. The
   * loop serves whoever is connected to this instance, which genuinely spans
   * tenants, so it needs to know *which* tenant each account belongs to and to
   * open that scope for each group.
   *
   * The answer comes from the socket, and the socket's `tenantId` was written at
   * connection time from the resolved host after the token's `tid` was checked
   * against it. So this is a fact already established under authentication, not
   * a lookup that could be steered from outside.
   */
  tenantsOfListeners(
    channels: readonly WsChannel[],
  ): Array<{ tenant: TenantContext; accounts: Set<string> }> {
    const byTenant = new Map<string, { tenant: TenantContext; accounts: Set<string> }>();
    for (const socket of this.sockets) {
      if (!channels.some((channel) => socket.state.channels.has(channel))) continue;
      const { tenantId, tenantSlug } = socket.state;
      if (tenantId === null || tenantSlug === null) continue;
      const group = byTenant.get(tenantId) ?? {
        tenant: { tenantId, slug: tenantSlug },
        accounts: new Set<string>(),
      };
      for (const accountId of socket.state.accountIds) group.accounts.add(accountId);
      byTenant.set(tenantId, group);
    }
    return [...byTenant.values()];
  }

  get connectionCount(): number {
    return this.sockets.size;
  }

  /**
   * Emits one frame.
   *
   * `eventId` identifies the *occurrence*. For a domain event it is minted once
   * at publish time and travels to every socket that receives it, so two frames
   * describing one fill carry one id and a client can discard the second. For
   * market data there is no upstream occurrence, so each frame mints its own.
   *
   * `accountId` sits at the top level rather than inside `data`, because a
   * client with several accounts open has to route the frame before it knows
   * what shape the payload is.
   */
  private send(
    socket: TradingSocket,
    event: WsEvent,
    channel: WsChannel,
    accountId: string | null,
    data: unknown,
    eventId: string = randomUUID(),
  ): void {
    socket.state.seq += 1;
    socket.emit('frame', {
      event,
      eventId,
      channel,
      accountId,
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
