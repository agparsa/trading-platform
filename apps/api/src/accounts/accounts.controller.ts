import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Permission } from '@tp/shared-types';
import {
  CurrentUser,
  subjectOf,
  type AuthenticatedUser,
} from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { AccountsService } from './accounts.service';

const ledgerQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().uuid().optional(),
  })
  .strict();

class LedgerQueryDto extends createZodDto(ledgerQuerySchema) {}

@ApiTags('accounts')
/**
 * A trader's own accounts.
 *
 * Every read here resolves its subject with `subjectOf` rather than `user.id`,
 * so a member of staff holding a live break-glass grant (§9) sees the account
 * owner's view instead of their own. Without a grant the two are the same
 * value, which is why a route that forgets `subjectOf` is wrong but harmless —
 * it serves the staff member's own accounts.
 */
@Controller('accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @RequirePermissions(Permission.ACCOUNTS_READ)
  @Get()
  @ApiOperation({ summary: 'Accounts belonging to the authenticated user' })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.accounts.listForUser(subjectOf(user));
  }

  @RequirePermissions(Permission.ACCOUNTS_READ)
  @Get(':id')
  @ApiOperation({ summary: 'One account' })
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.accounts.getForUser(subjectOf(user), id);
  }

  @RequirePermissions(Permission.ACCOUNTS_READ)
  @Get(':id/settings')
  @ApiOperation({ summary: 'Risk limits and margin thresholds for an account' })
  settings(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.accounts.getSettings(subjectOf(user), id);
  }

  @RequirePermissions(Permission.ACCOUNTS_READ)
  @Get(':id/ledger')
  @ApiOperation({ summary: 'Immutable balance history, newest first' })
  ledger(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: LedgerQueryDto,
  ) {
    return this.accounts.listLedger(subjectOf(user), id, query.limit, query.cursor);
  }
}
