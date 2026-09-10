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
 */
export class DrainState {
  private draining = false;
  private inFlight = 0;
  private idle: (() => void) | null = null;

  get isDraining(): boolean {
    return this.draining;
  }

  get inFlightRequests(): number {
    return this.inFlight;
  }

  /** Express middleware: counts requests in, counts them out, refuses newcomers while draining. */
  middleware() {
    return (_req: Request, res: Response, next: NextFunction): void => {
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
