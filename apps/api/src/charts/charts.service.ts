import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { requireTenantId } from '@tp/tenancy';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The largest arrangement this platform will hold for one chart.
 *
 * A layout with a hundred studies and ten thousand drawings on it is a
 * runaway, not a chart, and storing it would make every read of that person's
 * list slow. 256 KB is roughly two orders of magnitude more than a busy real
 * layout; the refusal names the size so whoever hit it can see why.
 */
const MAX_CONTENT_BYTES = 256 * 1024;

export interface LayoutSummary {
  readonly id: string;
  readonly name: string;
  readonly symbol: string;
  readonly resolution: string;
  readonly accountId: string | null;
  readonly isDefault: boolean;
  readonly updatedAt: string;
}

export interface LayoutView extends LayoutSummary {
  /** The renderer's own description. Returned verbatim; never parsed here. */
  readonly content: unknown;
}

export interface TemplateSummary {
  readonly id: string;
  readonly name: string;
  readonly updatedAt: string;
}

export interface TemplateView extends TemplateSummary {
  readonly content: unknown;
}

export interface DrawingView {
  readonly symbol: string;
  readonly content: unknown;
  readonly updatedAt: string;
}

/**
 * Where a trader's chart arrangements live.
 *
 * ## The blob is not read
 *
 * `content` is the renderer's own description of itself — which studies at
 * which settings, on which panes, with what drawings and where the viewport
 * was. Every renderer describes that differently, and this platform is going
 * to change renderer when the licensed charting library arrives. Parsing it
 * would mean holding an opinion about a format we do not own and being wrong
 * about it the first time it moves.
 *
 * So it is stored, returned and replaced verbatim, and what the platform keeps
 * in columns is only what it can answer without parsing: whose layout, which
 * instrument, which resolution, which one to open. That is also the part that
 * survives the change of renderer — a layout the new library cannot read still
 * says what it was of.
 *
 * ## Everything here is one person's
 *
 * Every query is filtered by `userId` as well as by the tenant scope. A chart
 * layout is not sensitive in the way a balance is, but it is *someone's*, and
 * a list endpoint that leaked one trader's instruments and timeframes to
 * another would be telling them what that person watches.
 */
@Injectable()
export class ChartsService {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Layouts ------------------------------------------------------------

  async layouts(userId: string, accountId?: string): Promise<readonly LayoutSummary[]> {
    const rows = await this.prisma.chartLayout.findMany({
      where: { userId, ...(accountId === undefined ? {} : { accountId }) },
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
      select: {
        id: true,
        name: true,
        symbol: true,
        resolution: true,
        accountId: true,
        isDefault: true,
        updatedAt: true,
      },
    });
    return rows.map(toLayoutSummary);
  }

  async layout(userId: string, id: string): Promise<LayoutView> {
    const row = await this.prisma.chartLayout.findFirst({ where: { id, userId } });
    if (row === null) throw notFound('chart layout', id);
    return { ...toLayoutSummary(row), content: row.content };
  }

  /**
   * The layout to open, or `null` when this person has never saved one.
   *
   * `null` rather than an invented default: a chart the platform made up and
   * called the trader's own would be a small lie that gets noticed the first
   * time it opens the wrong instrument.
   */
  async defaultLayout(userId: string, accountId: string | null): Promise<LayoutView | null> {
    const row = await this.prisma.chartLayout.findFirst({
      where: { userId, isDefault: true, accountId },
      orderBy: { updatedAt: 'desc' },
    });
    return row === null ? null : { ...toLayoutSummary(row), content: row.content };
  }

  /**
   * Save under a name, replacing what was there.
   *
   * Replacing is what "save" means to the person pressing it: a second row
   * under the same name would leave them two charts they cannot tell apart.
   */
  async saveLayout(
    userId: string,
    input: {
      readonly name: string;
      readonly symbol: string;
      readonly resolution: string;
      readonly accountId: string | null;
      readonly content: unknown;
      readonly isDefault?: boolean;
    },
  ): Promise<LayoutSummary> {
    assertSize(input.content, 'layout');
    const name = input.name.trim();
    const tenantId = requireTenantId();

    return this.prisma.$transaction(async (tx) => {
      /**
       * Clearing the old default first, in the same transaction.
       *
       * The database allows one default per person per account, so setting a
       * second without clearing the first would be refused by the index —
       * correctly, and confusingly. Doing both together makes "make this the
       * default" mean what it says.
       */
      if (input.isDefault === true) {
        await tx.chartLayout.updateMany({
          where: { userId, accountId: input.accountId, isDefault: true },
          data: { isDefault: false },
        });
      }

      const existing = await tx.chartLayout.findFirst({
        where: { userId, accountId: input.accountId, name },
        select: { id: true },
      });
      const data = {
        symbol: input.symbol.toUpperCase(),
        resolution: input.resolution,
        content: input.content as Prisma.InputJsonValue,
        ...(input.isDefault === undefined ? {} : { isDefault: input.isDefault }),
      };
      const saved =
        existing === null
          ? await tx.chartLayout.create({
              data: { tenantId, userId, accountId: input.accountId, name, ...data },
            })
          : await tx.chartLayout.update({ where: { id: existing.id }, data });
      return toLayoutSummary(saved);
    });
  }

  async deleteLayout(userId: string, id: string): Promise<void> {
    const deleted = await this.prisma.chartLayout.deleteMany({ where: { id, userId } });
    if (deleted.count === 0) throw notFound('chart layout', id);
  }

  // ---- Study templates ----------------------------------------------------

  async templates(userId: string): Promise<readonly TemplateSummary[]> {
    const rows = await this.prisma.chartTemplate.findMany({
      where: { userId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, updatedAt: true },
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async template(userId: string, name: string): Promise<TemplateView> {
    const row = await this.prisma.chartTemplate.findFirst({ where: { userId, name } });
    if (row === null) throw notFound('study template', name);
    return {
      id: row.id,
      name: row.name,
      updatedAt: row.updatedAt.toISOString(),
      content: row.content,
    };
  }

  async saveTemplate(userId: string, name: string, content: unknown): Promise<TemplateSummary> {
    assertSize(content, 'study template');
    const trimmed = name.trim();
    const saved = await this.prisma.chartTemplate.upsert({
      where: { userId_name: { userId, name: trimmed } },
      create: {
        tenantId: requireTenantId(),
        userId,
        name: trimmed,
        content: content as Prisma.InputJsonValue,
      },
      update: { content: content as Prisma.InputJsonValue },
    });
    return { id: saved.id, name: saved.name, updatedAt: saved.updatedAt.toISOString() };
  }

  async deleteTemplate(userId: string, name: string): Promise<void> {
    const deleted = await this.prisma.chartTemplate.deleteMany({ where: { userId, name } });
    if (deleted.count === 0) throw notFound('study template', name);
  }

  // ---- Drawings -----------------------------------------------------------

  /**
   * What this person has drawn on one instrument.
   *
   * Per instrument rather than per layout, because a trendline drawn on gold
   * is about gold. A trader who opens a different layout expects their lines
   * to still be there — that is how every terminal they have used behaves, and
   * storing drawings inside a layout would lose them on a switch.
   *
   * An instrument with nothing drawn on it answers with empty content rather
   * than a refusal: "nothing drawn yet" is the ordinary state, not an error.
   */
  async drawings(userId: string, symbol: string): Promise<DrawingView> {
    const code = symbol.toUpperCase();
    const row = await this.prisma.userDrawing.findFirst({ where: { userId, symbol: code } });
    return {
      symbol: code,
      content: row?.content ?? {},
      updatedAt: (row?.updatedAt ?? new Date(0)).toISOString(),
    };
  }

  async saveDrawings(userId: string, symbol: string, content: unknown): Promise<DrawingView> {
    assertSize(content, 'drawings');
    const code = symbol.toUpperCase();
    const saved = await this.prisma.userDrawing.upsert({
      where: { userId_symbol: { userId, symbol: code } },
      create: {
        tenantId: requireTenantId(),
        userId,
        symbol: code,
        content: content as Prisma.InputJsonValue,
      },
      update: { content: content as Prisma.InputJsonValue },
    });
    return {
      symbol: saved.symbol,
      content: saved.content,
      updatedAt: saved.updatedAt.toISOString(),
    };
  }
}

interface LayoutRow {
  id: string;
  name: string;
  symbol: string;
  resolution: string;
  accountId: string | null;
  isDefault: boolean;
  updatedAt: Date;
}

function toLayoutSummary(row: LayoutRow): LayoutSummary {
  return {
    id: row.id,
    name: row.name,
    symbol: row.symbol,
    resolution: row.resolution,
    accountId: row.accountId,
    isDefault: row.isDefault,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function notFound(what: string, which: string): DomainError {
  return new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, `No such ${what}`, { which });
}

/**
 * Refuses an arrangement too large to be one.
 *
 * Measured after serialisation, because that is what will be stored — a shape
 * that looks small and expands is still large in the row. The message names
 * both sizes so it is actionable rather than merely a wall.
 */
export function assertSize(content: unknown, what: string): void {
  const bytes = Buffer.byteLength(JSON.stringify(content ?? {}), 'utf8');
  if (bytes > MAX_CONTENT_BYTES) {
    throw new DomainError(
      TradingErrorCode.VALIDATION_FAILED,
      `That ${what} is ${Math.round(bytes / 1024)} KB, and the limit is ${MAX_CONTENT_BYTES / 1024} KB.`,
      { bytes: String(bytes) },
    );
  }
}
