import type { NextFunction, Request, Response } from 'express';

/**
 * Stopping without dropping anything (§77).
 *
 * ## What went wrong before this existed
 *
 * Nest's `enableShutdownHooks` answers SIGTERM with `app.close()`, and
 * `app.close()` runs `onModuleDestroy` on every provider *before* it stops the
 * HTTP server. The Prisma service's destroy hook disconnects the pool — so for
 * the ten seconds it took the pool to give up, every order still in flight
 * failed, most with `CONCURRENT_MODIFICATION` because a conditional update
 * that cannot reach the database matches no rows. Under failure injection: 40
 * orders in flight at SIGTERM, 4 filled, 36 refused with the wrong code after
 * ten seconds each. Nothing was half-applied, but a deploy is not supposed to
 * feel like an outage to the people trading through it.
 *
 * ## What happens instead
 *
 * On SIGTERM the process first *drains*: readiness starts answering 503 so a
 * load balancer stops sending new work, every response carries
 * `Connection: close` so keep-alive sockets do not bring another request, new
 * requests that still arrive are refused with a coded 503, and the process
 * waits for the requests already inside it to finish — up to a deadline, so a
 * hung handler cannot hold a deploy hostage. Only then does `app.close()` run
 * and take the database away. The deadline is below the 30 s the runbook asks
 * orchestrators to allow, deliberately: SIGKILL must never be what ends a
 * drain.
 *
 * ## The same counter, used to stay standing (§74)
 *
 * The in-flight count is also the admission control. Two thousand orders
 * fired at once at a two-core instance did not queue politely: with everything
 * accepted, the event loop spent so long serving what it already held that it
 * stopped accepting connections for over ten seconds, the listen backlog
 * filled, and a hundred and twenty clients got `ECONNRESET` or a connect
 * timeout — a refusal with no code, after which the client does not know
 * whether its order exists. That is the one outcome the platform must never
 * produce.
 *
 * So above `maxInFlight` newcomers are refused *immediately* with a coded 503
 * and `Retry-After`. The client knows nothing was placed; the requests already
 * inside keep the whole of the process; the loop stays responsive enough to
 * keep saying no. Load shedding, in the plain sense: the choice is between
 * refusing some requests cleanly and failing all of them badly. Liveness is
 * exempt, because an orchestrator that kills an overloaded process for being
 * overloaded turns a busy minute into an outage.
 */
export interface DrainStateOptions {
  /** Requests in flight above which newcomers are refused. `Infinity` disables shedding. */
  readonly maxInFlight?: number;
  /**
   * Event-loop lag above which newcomers are refused, whatever the count.
   *
   * A count bounds how much is admitted; it says nothing about how long each
   * admitted request takes. At a thousand traders on two cores, 512 requests
   * in flight each waited minutes behind the loop and timed out at the client
   * with no answer — the same failure the count was added to prevent. Lag is
   * the measurement of "too busy" itself: when the loop cannot get round in a
   * second, another request in the queue helps nobody.
   */
  readonly maxEventLoopLagMs?: number;
  /** How the current event-loop lag is read, in milliseconds. */
  readonly eventLoopLag?: () => number;
  /** Where to say that shedding happened; called at most once per `logEveryMs`. */
  readonly onShed?: (shed: number, inFlight: number) => void;
  readonly logEveryMs?: number;
}

/** Paths admitted regardless of load: a liveness probe must answer or the process is killed. */
const ALWAYS_ADMITTED = new Set(['/health']);

export class DrainState {
  private draining = false;
  private inFlight = 0;
  private idle: (() => void) | null = null;
  private shed = 0;
  private shedSinceLog = 0;
  private lastShedLogAt = 0;
  private readonly maxInFlight: number;
  private readonly maxEventLoopLagMs: number;
  private readonly eventLoopLag: () => number;
  private readonly onShed: ((shed: number, inFlight: number) => void) | undefined;
  private readonly logEveryMs: number;

  constructor(options: DrainStateOptions = {}) {
    this.maxInFlight = options.maxInFlight ?? Number.POSITIVE_INFINITY;
    this.maxEventLoopLagMs = options.maxEventLoopLagMs ?? Number.POSITIVE_INFINITY;
    this.eventLoopLag = options.eventLoopLag ?? (() => 0);
    this.onShed = options.onShed;
    this.logEveryMs = options.logEveryMs ?? 10_000;
  }

  /** Whether a newcomer would be refused right now, and why. */
  private overloaded(): 'count' | 'lag' | null {
    if (this.inFlight >= this.maxInFlight) return 'count';
    if (this.eventLoopLag() > this.maxEventLoopLagMs) return 'lag';
    return null;
  }

  get isDraining(): boolean {
    return this.draining;
  }

  get inFlightRequests(): number {
    return this.inFlight;
  }

  /** Requests refused at the concurrency limit since the process started. */
  get shedRequests(): number {
    return this.shed;
  }

  /**
   * Express middleware: counts requests in, counts them out, refuses newcomers
   * while draining or above the concurrency limit.
   */
  middleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
      if (this.draining) {
        res.setHeader('Connection', 'close');
        res.setHeader('Retry-After', '2');
        res.status(503).json({
          ok: false,
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'This instance is stopping; retry and another will answer.',
          },
        });
        return;
      }
      const overloaded = ALWAYS_ADMITTED.has(req.path) ? null : this.overloaded();
      if (overloaded !== null) {
        this.shed += 1;
        this.shedSinceLog += 1;
        const now = Date.now();
        if (this.onShed !== undefined && now - this.lastShedLogAt >= this.logEveryMs) {
          this.lastShedLogAt = now;
          const count = this.shedSinceLog;
          this.shedSinceLog = 0;
          this.onShed(count, this.inFlight);
        }
        res.setHeader('Retry-After', '1');
        res.status(503).json({
          ok: false,
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message:
              overloaded === 'count'
                ? 'This instance is at its concurrency limit. Nothing was changed; retry shortly.'
                : 'This instance is too busy to take the request now. Nothing was changed; retry shortly.',
          },
        });
        return;
      }
      this.inFlight += 1;
      let counted = true;
      const done = () => {
        if (!counted) return;
        counted = false;
        this.inFlight -= 1;
        if (this.inFlight === 0 && this.idle !== null) this.idle();
      };
      res.once('finish', done);
      res.once('close', done);
      next();
    };
  }

  /**
   * Begins draining and resolves when nothing is in flight, or when the
   * deadline passes — in which case the count it resolves with says how many
   * requests were abandoned, so the log can say so.
   */
  async drain(deadlineMs: number, onDraining: () => void = () => undefined): Promise<number> {
    this.draining = true;
    onDraining();
    if (this.inFlight === 0) return 0;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, deadlineMs);
      this.idle = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.idle = null;
    return this.inFlight;
  }
}
