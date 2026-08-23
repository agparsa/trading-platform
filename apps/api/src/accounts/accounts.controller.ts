import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { AccountsService } from './accounts.service';

const ledgerQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().uuid().optional(),
  })
  .strict();

class LedgerQueryDto extends createZodDto(ledgerQuerySchema) {}

@ApiTags('accounts')
@Controller('accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  @ApiOperation({ summary: 'Accounts belonging to the authenticated user' })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.accounts.listForUser(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One account' })
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.accounts.getForUser(user.id, id);
  }

  @Get(':id/settings')
  @ApiOperation({ summary: 'Risk limits and margin thresholds for an account' })
  settings(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.accounts.getSettings(user.id, id);
  }

  @Get(':id/ledger')
  @ApiOperation({ summary: 'Immutable balance history, newest first' })
  ledger(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: LedgerQueryDto,
  ) {
    return this.accounts.listLedger(user.id, id, query.limit, query.cursor);
  }
}
