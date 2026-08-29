/**
 * Reference instrument data.
 *
 * Seeds instruments only. It deliberately creates no users, accounts or
 * balances: a seeded balance is a fabricated financial record, and this
 * database is the ledger of record even in development.
 *
 * The XAUUSD and BTCUSD contract specifications match the reference terminal
 * capture documented in docs/pnl.md, so a developer's local P&L reproduces the
 * numbers in the test suite.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface SeedInstrument {
  code: string;
  description: string;
  category: string;
  quoteCurrency: string;
  contractSize: string;
  tickSize: string;
  pricePrecision: number;
  volumeStep: string;
  volumePrecision: number;
  minVolume: string;
  maxVolume: string;
  marginRate: string;
  commissionPerLot: string;
  swapLongPerLot: string;
  swapShortPerLot: string;
  session: 'metals' | 'crypto' | 'fx';
}

const INSTRUMENTS: SeedInstrument[] = [
  {
    code: 'XAUUSD',
    description: 'Gold vs US Dollar',
    category: 'Metals',
    quoteCurrency: 'USD',
    contractSize: '100',
    tickSize: '0.01',
    pricePrecision: 2,
    volumeStep: '0.01',
    volumePrecision: 2,
    minVolume: '0.01',
    maxVolume: '100',
    marginRate: '0.01',
    commissionPerLot: '0',
    swapLongPerLot: '-12.5',
    swapShortPerLot: '4.75',
    session: 'metals',
  },
  {
    code: 'XAGUSD',
    description: 'Silver vs US Dollar',
    category: 'Metals',
    quoteCurrency: 'USD',
    contractSize: '5000',
    tickSize: '0.001',
    pricePrecision: 3,
    volumeStep: '0.01',
    volumePrecision: 2,
    minVolume: '0.01',
    maxVolume: '50',
    marginRate: '0.01',
    commissionPerLot: '0',
    swapLongPerLot: '-1.8',
    swapShortPerLot: '0.6',
    session: 'metals',
  },
  {
    code: 'BTCUSD',
    description: 'Bitcoin vs US Dollar',
    category: 'Crypto',
    quoteCurrency: 'USD',
    contractSize: '1',
    tickSize: '0.01',
    pricePrecision: 2,
    volumeStep: '0.01',
    volumePrecision: 2,
    minVolume: '0.01',
    maxVolume: '50',
    marginRate: '0.01',
    commissionPerLot: '0',
    swapLongPerLot: '0',
    swapShortPerLot: '0',
    session: 'crypto',
  },
  {
    /**
     * A second always-open instrument.
     *
     * Not decoration: with only one crypto pair, every weekend leaves the
     * platform with a single quoting instrument — one row in the watchlist, one
     * choice on the chart, and no way to exercise anything that compares two
     * markets. That is half of every week.
     */
    code: 'ETHUSD',
    description: 'Ethereum vs US Dollar',
    category: 'Crypto',
    quoteCurrency: 'USD',
    contractSize: '1',
    tickSize: '0.01',
    pricePrecision: 2,
    volumeStep: '0.01',
    volumePrecision: 2,
    minVolume: '0.01',
    maxVolume: '500',
    marginRate: '0.02',
    commissionPerLot: '0',
    swapLongPerLot: '0',
    swapShortPerLot: '0',
    session: 'crypto',
  },
  {
    code: 'EURUSD',
    description: 'Euro vs US Dollar',
    category: 'FX',
    quoteCurrency: 'USD',
    contractSize: '100000',
    tickSize: '0.00001',
    pricePrecision: 5,
    volumeStep: '0.01',
    volumePrecision: 2,
    minVolume: '0.01',
    maxVolume: '200',
    marginRate: '0.002',
    commissionPerLot: '3.5',
    swapLongPerLot: '-2.1',
    swapShortPerLot: '0.4',
    session: 'fx',
  },
  {
    code: 'AUDUSD',
    description: 'Australian Dollar vs US Dollar',
    category: 'FX',
    quoteCurrency: 'USD',
    contractSize: '100000',
    tickSize: '0.00001',
    pricePrecision: 5,
    volumeStep: '0.01',
    volumePrecision: 2,
    minVolume: '0.01',
    maxVolume: '200',
    marginRate: '0.002',
    commissionPerLot: '3.5',
    swapLongPerLot: '-0.9',
    swapShortPerLot: '0.2',
    session: 'fx',
  },
];

/** Windows in UTC minutes from midnight, by weekday (0 = Sunday). */
const SESSIONS: Record<SeedInstrument['session'], Array<[number, number, number]>> = {
  // Sunday 22:00 through Friday 21:00 UTC.
  metals: [
    [0, 22 * 60, 24 * 60],
    [1, 0, 24 * 60],
    [2, 0, 24 * 60],
    [3, 0, 24 * 60],
    [4, 0, 24 * 60],
    [5, 0, 21 * 60],
  ],
  fx: [
    [0, 22 * 60, 24 * 60],
    [1, 0, 24 * 60],
    [2, 0, 24 * 60],
    [3, 0, 24 * 60],
    [4, 0, 24 * 60],
    [5, 0, 21 * 60],
  ],
  // Crypto never closes.
  crypto: [
    [0, 0, 24 * 60],
    [1, 0, 24 * 60],
    [2, 0, 24 * 60],
    [3, 0, 24 * 60],
    [4, 0, 24 * 60],
    [5, 0, 24 * 60],
    [6, 0, 24 * 60],
  ],
};

async function main(): Promise<void> {
  for (const instrument of INSTRUMENTS) {
    const symbol = await prisma.symbol.upsert({
      where: { code: instrument.code },
      create: {
        code: instrument.code,
        description: instrument.description,
        category: instrument.category,
        quoteCurrency: instrument.quoteCurrency,
        enabled: true,
      },
      update: {
        description: instrument.description,
        category: instrument.category,
        quoteCurrency: instrument.quoteCurrency,
      },
    });

    const spec = {
      contractSize: instrument.contractSize,
      tickSize: instrument.tickSize,
      pricePrecision: instrument.pricePrecision,
      volumeStep: instrument.volumeStep,
      volumePrecision: instrument.volumePrecision,
      minVolume: instrument.minVolume,
      maxVolume: instrument.maxVolume,
      marginRate: instrument.marginRate,
      commissionPerLot: instrument.commissionPerLot,
      swapLongPerLot: instrument.swapLongPerLot,
      swapShortPerLot: instrument.swapShortPerLot,
    };

    await prisma.symbolSpec.upsert({
      where: { symbolId: symbol.id },
      create: { symbolId: symbol.id, ...spec },
      update: spec,
    });

    for (const [dayOfWeek, openMinute, closeMinute] of SESSIONS[instrument.session]) {
      await prisma.marketSession.upsert({
        where: { symbolId_dayOfWeek_openMinute: { symbolId: symbol.id, dayOfWeek, openMinute } },
        create: { symbolId: symbol.id, timezone: 'UTC', dayOfWeek, openMinute, closeMinute },
        update: { closeMinute, timezone: 'UTC' },
      });
    }

    console.log(`seeded ${instrument.code}`);
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    // A failed seed must fail the command, not leave a half-populated database
    // that looks fine until the first order.
    process.exitCode = 1;
  });
