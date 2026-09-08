import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@tp/shared-types';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { SessionOnly } from '../common/decorators/session-only.decorator';
import { LeadershipService } from './leadership.service';

interface LeaseView {
  readonly name: string;
  /** Whether the instance answering this request is the holder. */
  readonly self: boolean;
  readonly term: string;
  readonly acquiredAt: Date;
  readonly renewedAt: Date;
  readonly expiresAt: Date;
  /** True when the lease has lapsed and nothing is running the loop. */
  readonly expired: boolean;
}

/**
 * Who is running the singleton loops.
 *
 * Read-only on purpose. There is no route to hand leadership to a particular
 * instance, because the honest way to move it is to stop the instance holding
 * it — anything else is a person and a lease disagreeing about who is in
 * charge, which is the exact state the lease exists to prevent.
 *
 * The holder is reported as "this instance or not" rather than by its id. The
 * id is a random UUID that means nothing outside the process, and printing it
 * invites somebody to try to route to it.
 */
@ApiTags('operations')
@Controller('admin/leadership')
@SessionOnly()
export class LeadershipController {
  constructor(private readonly leadership: LeadershipService) {}

  @Get()
  @RequirePermissions(Permission.SYSTEM_OPERATIONS)
  @ApiOperation({ summary: 'Leases for the loops that run in exactly one place' })
  async leases(): Promise<{ instance: string; leases: readonly LeaseView[] }> {
    const now = Date.now();
    const rows = await this.leadership.leases();
    return {
      /**
       * Short and non-routable: enough to tell two lines of an operator's
       * output apart when they are talking to different replicas through a load
       * balancer, not enough to address one.
       */
      instance: this.leadership.instanceId.slice(0, 8),
      leases: rows.map((row) => ({
        name: row.name,
        self: row.holder === this.leadership.instanceId,
        term: row.term.toString(),
        acquiredAt: row.acquiredAt,
        renewedAt: row.renewedAt,
        expiresAt: row.expiresAt,
        expired: row.expiresAt.getTime() <= now,
      })),
    };
  }
}
