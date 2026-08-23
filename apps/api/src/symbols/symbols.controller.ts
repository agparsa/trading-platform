import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SymbolsService } from './symbols.service';
import { isSessionOpen } from '../market/session';

@ApiTags('symbols')
@Controller('symbols')
export class SymbolsController {
  constructor(private readonly symbols: SymbolsService) {}

  @Get()
  @ApiOperation({ summary: 'Tradeable instruments and their contract specifications' })
  list() {
    const now = Date.now();
    return this.symbols.list().map((instrument) => ({
      ...instrument.spec,
      sessionOpen: isSessionOpen(instrument.session, now),
    }));
  }

  @Get(':code')
  @ApiOperation({ summary: 'One instrument, with its trading session' })
  get(@Param('code') code: string) {
    const instrument = this.symbols.require(code);
    return {
      ...instrument.spec,
      session: instrument.session,
      sessionOpen: isSessionOpen(instrument.session, Date.now()),
    };
  }
}
