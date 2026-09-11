import { Controller, Get, Inject, Param } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { MarketStatusDto } from '@tp/shared-types';
import { SymbolsService } from './symbols.service';
import { marketStatus } from '../market/session';
import { KillSwitchService, TradingState } from '../operations/kill-switch.service';
import type { Env } from '../config/env.schema';
import type { InstrumentDefinition } from '@tp/market-core';

@ApiTags('symbols')
@Controller('symbols')
export class SymbolsController {
  constructor(
    private readonly symbols: SymbolsService,
    private readonly killSwitch: KillSwitchService,
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * What the market is doing, per instrument (§36).
   *
   * `sessionOpen` stays on the payload because it is what the engine asks and
   * what three clients already read; `market` is the same answer with the
   * reason attached, so a shut screen can say when it will not be.
   *
   * The halt is read once for the whole list rather than per instrument: it is
   * a platform- or tenant-wide switch, and asking it eight times would suggest
   * an instrument could be halted on its own.
   */
  private statusOf(
    instrument: InstrumentDefinition,
    now: number,
    halted: boolean,
  ): MarketStatusDto {
    return marketStatus(instrument.session, now, {
      halted,
      preOpenMinutes: this.config.get('MARKET_PRE_OPEN_MINUTES', { infer: true }),
      postCloseMinutes: this.config.get('MARKET_POST_CLOSE_MINUTES', { infer: true }),
    });
  }

  private get halted(): boolean {
    return this.killSwitch.current().state === TradingState.DISABLED;
  }

  @Get()
  @ApiOperation({ summary: 'Tradeable instruments and their contract specifications' })
  list() {
    const now = Date.now();
    const halted = this.halted;
    return this.symbols.list().map((instrument) => {
      const market = this.statusOf(instrument, now, halted);
      return { ...instrument.spec, sessionOpen: market.tradeable, market };
    });
  }

  @Get(':code')
  @ApiOperation({ summary: 'One instrument, with its trading session' })
  get(@Param('code') code: string) {
    const instrument = this.symbols.require(code);
    const market = this.statusOf(instrument, Date.now(), this.halted);
    return {
      ...instrument.spec,
      session: instrument.session,
      sessionOpen: market.tradeable,
      market,
    };
  }
}
