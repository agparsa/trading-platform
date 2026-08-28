import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Permission } from '@tp/shared-types';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { KillSwitchService, TradingState } from './kill-switch.service';
import { OperationsService } from './operations.service';

/**
 * A reason is required to halt and optional to resume.
 *
 * "Who stopped trading, when, and why" is the first question asked after any
 * halt, and an answer that lives only in somebody's memory is not an answer.
 * Resuming needs no justification beyond the actor: going back to normal is the
 * default state, and demanding a sentence for it would only produce empty ones.
 */
const haltSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
const resumeSchema = z.object({ reason: z.string().trim().max(500).optional() }).strict();

class HaltDto extends createZodDto(haltSchema) {}
class ResumeDto extends createZodDto(resumeSchema) {}

@ApiTags('operations')
@Controller('operations')
export class OperationsController {
  constructor(
    private readonly operations: OperationsService,
    private readonly killSwitch: KillSwitchService,
  ) {}

  @RequirePermissions(Permission.SYSTEM_OPERATIONS)
  @Get('summary')
  @ApiOperation({ summary: 'Is the platform all right' })
  summary() {
    return this.operations.summary();
  }

  /**
   * Readable by anyone who can operate the platform, and — unlike the summary —
   * cheap enough for a terminal to poll on reconnect. A trader refused an order
   * during a halt deserves to be told the platform is halted rather than left to
   * guess from an error code.
   */
  @RequirePermissions(Permission.SYSTEM_OPERATIONS)
  @Get('trading-state')
  @ApiOperation({ summary: 'Whether trading is halted, and why' })
  async tradingState() {
    return this.killSwitch.refresh();
  }

  @RequirePermissions(Permission.SYSTEM_KILL_SWITCH)
  @Post('halt')
  @ApiOperation({ summary: 'Halt new risk platform-wide. Closing stays available.' })
  halt(@CurrentUser() user: AuthenticatedUser, @Body() body: HaltDto) {
    return this.killSwitch.set(user.id, TradingState.DISABLED, body.reason);
  }

  @RequirePermissions(Permission.SYSTEM_KILL_SWITCH)
  @Post('resume')
  @ApiOperation({ summary: 'Resume trading' })
  resume(@CurrentUser() user: AuthenticatedUser, @Body() body: ResumeDto) {
    return this.killSwitch.set(user.id, TradingState.ENABLED, body.reason ?? null);
  }
}
