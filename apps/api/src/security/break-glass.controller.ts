import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Permission } from '@tp/shared-types';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { SessionOnly } from '../common/decorators/session-only.decorator';
import { BreakGlassService } from './break-glass.service';

const openSchema = z
  .object({
    subjectUserId: z.string().uuid(),
    /**
     * Eight characters is not a serious bar, and it is not meant to be one. It
     * stops "." and "x" — the reasons somebody types when they have decided the
     * field is in the way — and everything past that is a matter for whoever
     * reads the review list, which is the actual control.
     */
    reason: z.string().trim().min(8).max(500),
    minutes: z.coerce.number().int().min(1).max(480).optional(),
  })
  .strict();

class OpenDto extends createZodDto(openSchema) {}

/**
 * Break-glass: looking through one trader's eyes, with a reason (§9).
 *
 * `@SessionOnly()` on the class and every route. A long-lived secret in a
 * config file must not be able to open one of these, and an API key that could
 * read any trader's private view is the worst thing to leave in a `.env`.
 *
 * There is deliberately no route that *extends* a grant. A session that needs
 * longer is a new grant with a new reason, which is one more line in the review
 * list rather than one grant that quietly never ends.
 */
@ApiTags('security')
@Controller('security/break-glass')
@SessionOnly()
export class BreakGlassController {
  constructor(private readonly breakGlass: BreakGlassService) {}

  @Post()
  @SessionOnly()
  @RequirePermissions(Permission.SECURITY_BREAK_GLASS)
  @ApiOperation({ summary: 'Open a time-limited, read-only view of one person’s account' })
  async open(@CurrentUser() actor: AuthenticatedUser, @Body() body: OpenDto) {
    return this.breakGlass.open({
      actorId: actor.id,
      actorRole: actor.role as never,
      subjectUserId: body.subjectUserId,
      reason: body.reason,
      ...(body.minutes === undefined ? {} : { minutes: body.minutes }),
    });
  }

  /**
   * End one early.
   *
   * `DELETE`, and it is the one non-GET route a break-glass holder can reach —
   * because it is about the grant, not about the subject's data. A person who
   * has finished should be able to close the door without waiting an hour.
   */
  @Delete(':id')
  @SessionOnly()
  @RequirePermissions(Permission.SECURITY_BREAK_GLASS)
  @ApiOperation({ summary: 'End a break-glass session now' })
  async close(@CurrentUser() actor: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.breakGlass.close(actor.id, id);
    return { ok: true };
  }

  @Get('mine')
  @SessionOnly()
  @RequirePermissions(Permission.SECURITY_BREAK_GLASS)
  @ApiOperation({ summary: 'Your own break-glass sessions' })
  mine(@CurrentUser() actor: AuthenticatedUser) {
    return this.breakGlass.mine(actor.id);
  }

  /**
   * Every grant in the firm.
   *
   * `SYSTEM_OPERATIONS` rather than `SECURITY_BREAK_GLASS`: the person who
   * reviews break-glass use should not have to be somebody who can perform it.
   * A feature nobody reviews is a back door with paperwork.
   */
  @Get()
  @SessionOnly()
  @RequirePermissions(Permission.SYSTEM_OPERATIONS)
  @ApiOperation({ summary: 'Every break-glass session, for review' })
  all() {
    return this.breakGlass.all();
  }
}
