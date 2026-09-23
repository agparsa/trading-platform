import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { SelfService } from '../common/decorators/self-service.decorator';
import {
  ChartsService,
  type DrawingView,
  type LayoutSummary,
  type LayoutView,
  type TemplateSummary,
  type TemplateView,
} from './charts.service';

/**
 * `content` is `unknown` on purpose.
 *
 * It is the renderer's own description of a chart, and this platform does not
 * own that format. Validating its shape would be inventing a schema for
 * somebody else's data and rejecting the first version that adds a field. What
 * *is* enforced is its size, in the service, where the limit belongs.
 */
const layoutSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    symbol: z.string().trim().min(1).max(32),
    resolution: z.string().trim().min(1).max(16),
    accountId: z.string().uuid().nullable().default(null),
    content: z.unknown(),
    isDefault: z.boolean().optional(),
  })
  .strict();

const templateSchema = z
  .object({ name: z.string().trim().min(1).max(120), content: z.unknown() })
  .strict();

const drawingsSchema = z.object({ content: z.unknown() }).strict();

const layoutQuerySchema = z.object({ accountId: z.string().uuid().optional() }).strict();

class SaveLayoutDto extends createZodDto(layoutSchema) {}
class SaveTemplateDto extends createZodDto(templateSchema) {}
class SaveDrawingsDto extends createZodDto(drawingsSchema) {}
class LayoutQueryDto extends createZodDto(layoutQuerySchema) {}

/**
 * A trader's own chart arrangements.
 *
 * `@SelfService()` on the class *and* on each mutating route. The class
 * decorator is what the guard reads at runtime; the per-route ones are what
 * the coverage check reads, and it reads per route deliberately — a route
 * whose only protection is inherited is a route that loses it silently the day
 * somebody splits the controller.
 *
 * Self-service also keeps an API key out. A long-lived secret in a config file
 * has no business rearranging a person's screen, and nothing an integration
 * needs is here.
 */
@ApiTags('charts')
@Controller('charts')
@SelfService()
export class ChartsController {
  constructor(private readonly charts: ChartsService) {}

  @Get('layouts')
  @ApiOperation({ summary: 'Your saved chart layouts' })
  async layouts(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: LayoutQueryDto,
  ): Promise<{ layouts: readonly LayoutSummary[] }> {
    return { layouts: await this.charts.layouts(user.id, query.accountId) };
  }

  /**
   * The one to open. `null` when nothing has been saved — never an invented
   * default, which would be a small lie noticed the first time it opened the
   * wrong instrument.
   */
  @Get('layouts/default')
  @ApiOperation({ summary: 'The layout to open, or null' })
  defaultLayout(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: LayoutQueryDto,
  ): Promise<LayoutView | null> {
    return this.charts.defaultLayout(user.id, query.accountId ?? null);
  }

  @Get('layouts/:id')
  @ApiOperation({ summary: 'One layout, with its arrangement' })
  layout(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<LayoutView> {
    return this.charts.layout(user.id, id);
  }

  @SelfService()
  @Post('layouts')
  @ApiOperation({ summary: 'Save a layout under a name, replacing what was there' })
  saveLayout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SaveLayoutDto,
  ): Promise<LayoutSummary> {
    return this.charts.saveLayout(user.id, body);
  }

  @SelfService()
  @Delete('layouts/:id')
  @ApiOperation({ summary: 'Delete one of your layouts' })
  async deleteLayout(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ deleted: true }> {
    await this.charts.deleteLayout(user.id, id);
    return { deleted: true };
  }

  @Get('templates')
  @ApiOperation({ summary: 'Your study templates' })
  async templates(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ templates: readonly TemplateSummary[] }> {
    return { templates: await this.charts.templates(user.id) };
  }

  @Get('templates/:name')
  @ApiOperation({ summary: 'One study template, with its studies' })
  template(
    @CurrentUser() user: AuthenticatedUser,
    @Param('name') name: string,
  ): Promise<TemplateView> {
    return this.charts.template(user.id, name);
  }

  @SelfService()
  @Post('templates')
  @ApiOperation({ summary: 'Save a study template' })
  saveTemplate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SaveTemplateDto,
  ): Promise<TemplateSummary> {
    return this.charts.saveTemplate(user.id, body.name, body.content);
  }

  @SelfService()
  @Delete('templates/:name')
  @ApiOperation({ summary: 'Delete a study template' })
  async deleteTemplate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('name') name: string,
  ): Promise<{ deleted: true }> {
    await this.charts.deleteTemplate(user.id, name);
    return { deleted: true };
  }

  /**
   * Drawings are per instrument, not per layout: a trendline drawn on gold is
   * about gold, and switching layout must not lose it.
   */
  @Get('drawings/:symbol')
  @ApiOperation({ summary: 'What you have drawn on one instrument' })
  drawings(
    @CurrentUser() user: AuthenticatedUser,
    @Param('symbol') symbol: string,
  ): Promise<DrawingView> {
    return this.charts.drawings(user.id, symbol);
  }

  @SelfService()
  @Post('drawings/:symbol')
  @ApiOperation({ summary: 'Replace what you have drawn on one instrument' })
  saveDrawings(
    @CurrentUser() user: AuthenticatedUser,
    @Param('symbol') symbol: string,
    @Body() body: SaveDrawingsDto,
  ): Promise<DrawingView> {
    return this.charts.saveDrawings(user.id, symbol, body.content);
  }
}
