import { Controller, Get, Param, ParseUUIDPipe, Post, Query, Res, Body } from '@nestjs/common';
import type { Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ALL_REPORT_KINDS, REPORT_DEFINITIONS } from '@tp/reports-core';
import { Permission } from '@tp/shared-types';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { ReportsService } from './reports.service';

/**
 * `from` and `to` are ISO strings, not coerced dates.
 *
 * `z.coerce.date()` in a DTO takes the whole API down at boot: the OpenAPI
 * document is generated from these schemas and a `Date` has no JSON Schema
 * representation. It has happened twice; `reconciliation.controller.ts` carries
 * the same note for the same reason.
 */
const requestSchema = z
  .object({
    kind: z.enum(ALL_REPORT_KINDS as unknown as [string, ...string[]]),
    /**
     * An instant with an offset, or a plain date.
     *
     * A date is what a person means, and it is resolved to that trading day's
     * edge in `TRADING_SERVER_TIMEZONE` — see `report-window.ts`. An instant is
     * passed through, so an integration keeps the exact window it asked for.
     */
    from: z.union([z.string().datetime({ offset: true }), z.string().date()]),
    to: z.union([z.string().datetime({ offset: true }), z.string().date()]),
    accountId: z.string().uuid().optional(),
  })
  .strict();

const listQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(200).optional() })
  .strict();

class RequestReportDto extends createZodDto(requestSchema) {}
class ListReportsDto extends createZodDto(listQuerySchema) {}

@ApiTags('reports')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /**
   * What can be asked for, so the panel does not hard-code a list that drifts
   * from the one the API validates against.
   */
  @RequirePermissions(Permission.REPORTS_RUN)
  @Get('kinds')
  @ApiOperation({ summary: 'The kinds of report this platform produces' })
  kinds() {
    return Object.values(REPORT_DEFINITIONS).map((definition) => ({
      kind: definition.kind,
      title: definition.title,
      describes: definition.describes,
      permission: definition.permission,
      columns: definition.columns,
    }));
  }

  @RequirePermissions(Permission.REPORTS_RUN)
  @Get()
  @ApiOperation({ summary: "The firm's reports, newest first" })
  list(@Query() query: ListReportsDto) {
    return this.reports.list(query.limit);
  }

  @RequirePermissions(Permission.REPORTS_RUN)
  @Post()
  @ApiOperation({ summary: 'Ask for a report. It is produced by the worker.' })
  request(@Body() body: RequestReportDto, @CurrentUser() user: AuthenticatedUser) {
    return this.reports.request(body, { id: user.id, role: user.role });
  }

  /**
   * The file.
   *
   * `REPORTS_RUN` gets you to this handler; the service decides whether you may
   * have *this* file — it is yours, and you may still read what is in it. See
   * `ReportsService` for why that second question is asked again here rather
   * than trusted from when the report was requested.
   */
  @RequirePermissions(Permission.REPORTS_RUN)
  @Get(':id/download')
  @ApiOperation({ summary: 'Download a report you asked for' })
  async download(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Buffer> {
    const file = await this.reports.download(id, { id: user.id, role: user.role });
    response.setHeader('content-type', 'text/csv; charset=utf-8');
    /**
     * The filename is quoted and the value is minted by `reportFilename` from
     * the kind and the window — never from anything a caller supplied — so
     * there is no header to inject into.
     */
    response.setHeader('content-disposition', `attachment; filename="${file.filename}"`);
    // A report is somebody's book. No cache, anywhere, under any circumstances.
    response.setHeader('cache-control', 'no-store');
    return file.bytes;
  }
}
