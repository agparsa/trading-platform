/**
 * What switching instruments from the simulator to a real price would do to
 * the positions open in them — read-only, before anyone decides.
 *
 * Switching an instrument's source moves every open position in it to the
 * new price at once. The simulator's gold stood near 4583 when the market's
 * was near 3884, so the switch is a 700-dollar move per ounce. This prints, for
 * each open position: its side, size, entry and stored price; what it would be
 * worth at the price given; whether its stop loss or take profit would be
 * crossed; and per account, the balance against the total of those figures.
 * It writes nothing, places nothing and closes nothing.
 *
 *   node apps/api/dist/cli/price-switch-impact.js --price XAUUSD=3884.01 --price EURUSD=1.10232
 *
 * The price given is the **exit** price this estimate uses for both sides — a
 * mid, not a dealing quote — so a figure is an estimate within a spread, and
 * says so. A position whose instrument is not quoted in the account currency
 * needs a conversion: a USDxxx pair converts at 1/price; any other cross is
 * reported without a figure rather than with a guessed one.
 *
 * `scripts/price-switch-impact.sh` runs it inside the migrate image on a host.
 */
import { PrismaClient } from '@prisma/client';
import { grossPnl, toDecimal, type SymbolSpec } from '@tp/financial-core';

export interface OpenPosition {
  readonly id: string;
  readonly accountNumber: string;
  readonly accountCurrency: string;
  readonly balance: string;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly volume: string;
  readonly entryPrice: string;
  readonly currentPrice: string | null;
  readonly stopLoss: string | null;
  readonly takeProfit: string | null;
  readonly spec: SymbolSpec;
}

export interface PositionImpact {
  readonly id: string;
  readonly accountNumber: string;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly volume: string;
  readonly entryPrice: string;
  readonly currentPrice: string | null;
  readonly newPrice: string;
  /** Profit or loss at the new price, in the account currency; null without a conversion. */
  readonly pnlAtNew: string | null;
  readonly pnlAtCurrent: string | null;
  readonly crosses: 'STOP_LOSS' | 'TAKE_PROFIT' | null;
}

export interface AccountImpact {
  readonly accountNumber: string;
  readonly currency: string;
  readonly balance: string;
  readonly positions: number;
  /** Sum of `pnlAtNew` of its affected positions; null if any lacked a conversion. */
  readonly pnlAtNew: string | null;
  /** balance + pnlAtNew — what these positions alone would leave. */
  readonly balanceWithNew: string | null;
}

/** `XAUUSD=3884.01` → `['XAUUSD', '3884.01']`, or an error naming the argument. */
export function parsePrice(argument: string): [string, string] {
  const match = /^([A-Z0-9]{3,12})=(\d+(\.\d+)?)$/.exec(argument.trim());
  if (match === null)
    throw new Error(`--price ${argument}: expected SYMBOL=price, e.g. XAUUSD=3884.01`);
  return [match[1]!, match[2]!];
}

function rateFor(position: OpenPosition, price: string): string | null {
  if (position.spec.quoteCurrency === position.accountCurrency) return '1';
  // USDxxx in a USD account: one unit of the quote currency is 1/price dollars.
  if (position.symbol.startsWith(position.accountCurrency)) {
    return toDecimal(1).div(toDecimal(price)).toString();
  }
  return null;
}

function pnl(position: OpenPosition, exit: string | null, rate: string | null): string | null {
  if (exit === null || rate === null) return null;
  return grossPnl({
    spec: position.spec,
    side: position.side,
    volume: position.volume,
    entryPrice: position.entryPrice,
    exitPrice: exit,
    accountCurrency: position.accountCurrency,
    quoteToAccountRate: rate,
  })
    .round()
    .toString();
}

/** The impact of moving each listed instrument to its new price. Pure. */
export function impactOf(
  positions: readonly OpenPosition[],
  prices: Readonly<Record<string, string>>,
): { positions: PositionImpact[]; accounts: AccountImpact[] } {
  const rows: PositionImpact[] = [];
  for (const position of positions) {
    const newPrice = prices[position.symbol];
    if (newPrice === undefined) continue;
    const rate = rateFor(position, newPrice);
    const next = toDecimal(newPrice);
    const long = position.side === 'BUY';
    const crosses =
      position.stopLoss !== null &&
      (long ? next.lte(toDecimal(position.stopLoss)) : next.gte(toDecimal(position.stopLoss)))
        ? ('STOP_LOSS' as const)
        : position.takeProfit !== null &&
            (long
              ? next.gte(toDecimal(position.takeProfit))
              : next.lte(toDecimal(position.takeProfit)))
          ? ('TAKE_PROFIT' as const)
          : null;
    rows.push({
      id: position.id,
      accountNumber: position.accountNumber,
      symbol: position.symbol,
      side: position.side,
      volume: position.volume,
      entryPrice: position.entryPrice,
      currentPrice: position.currentPrice,
      newPrice,
      pnlAtNew: pnl(position, newPrice, rate),
      pnlAtCurrent: pnl(position, position.currentPrice, rate),
      crosses,
    });
  }
  const accounts = new Map<string, AccountImpact>();
  for (const row of rows) {
    const position = positions.find((one) => one.id === row.id)!;
    const before = accounts.get(row.accountNumber);
    const sum =
      before === undefined
        ? row.pnlAtNew
        : before.pnlAtNew === null || row.pnlAtNew === null
          ? null
          : toDecimal(before.pnlAtNew).plus(toDecimal(row.pnlAtNew)).toString();
    accounts.set(row.accountNumber, {
      accountNumber: row.accountNumber,
      currency: position.accountCurrency,
      balance: position.balance,
      positions: (before?.positions ?? 0) + 1,
      pnlAtNew: sum,
      balanceWithNew:
        sum === null ? null : toDecimal(position.balance).plus(toDecimal(sum)).toString(),
    });
  }
  return { positions: rows, accounts: [...accounts.values()] };
}

async function main(): Promise<void> {
  const prices: Record<string, string> = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--price' && args[i + 1] !== undefined) {
      const [symbol, price] = parsePrice(args[i + 1]!);
      prices[symbol] = price;
      i += 1;
    } else {
      throw new Error(`Unknown argument ${args[i]}. Use --price SYMBOL=price, as often as needed.`);
    }
  }
  if (Object.keys(prices).length === 0) throw new Error('Name at least one --price SYMBOL=price.');

  const prisma = new PrismaClient();
  try {
    const rows = await prisma.position.findMany({
      where: { status: 'OPEN', symbol: { code: { in: Object.keys(prices) } } },
      include: {
        account: { select: { number: true, currency: true, balance: true } },
        symbol: { include: { spec: true } },
      },
      orderBy: [{ symbol: { code: 'asc' } }, { openedAt: 'asc' }],
    });
    const positions: OpenPosition[] = rows
      .filter((row) => row.symbol.spec !== null)
      .map((row) => ({
        id: row.id,
        accountNumber: row.account.number,
        accountCurrency: row.account.currency,
        balance: row.account.balance.toString(),
        symbol: row.symbol.code,
        side: row.side as 'BUY' | 'SELL',
        volume: row.volume.toString(),
        entryPrice: row.entryPrice.toString(),
        currentPrice: row.currentPrice?.toString() ?? null,
        stopLoss: row.stopLoss?.toString() ?? null,
        takeProfit: row.takeProfit?.toString() ?? null,
        spec: {
          code: row.symbol.code,
          description: row.symbol.description,
          quoteCurrency: row.symbol.quoteCurrency,
          contractSize: row.symbol.spec!.contractSize.toString(),
          tickSize: row.symbol.spec!.tickSize.toString(),
          pricePrecision: row.symbol.spec!.pricePrecision,
          volumeStep: row.symbol.spec!.volumeStep.toString(),
          volumePrecision: row.symbol.spec!.volumePrecision,
          minVolume: row.symbol.spec!.minVolume.toString(),
          maxVolume: row.symbol.spec!.maxVolume.toString(),
          marginRate: row.symbol.spec!.marginRate.toString(),
          commissionPerLot: row.symbol.spec!.commissionPerLot.toString(),
          swapLongPerLot: row.symbol.spec!.swapLongPerLot.toString(),
          swapShortPerLot: row.symbol.spec!.swapShortPerLot.toString(),
        } as SymbolSpec,
      }));
    const impact = impactOf(positions, prices);
    console.log(
      `Read-only. Prices given are used as the exit price for both sides — estimates within a spread.\n`,
    );
    console.log(
      `${impact.positions.length} open position(s) in ${Object.keys(prices).join(', ')}:\n`,
    );
    for (const row of impact.positions) {
      console.log(
        `  #${row.accountNumber}  ${row.symbol} ${row.side} ${row.volume} @ ${row.entryPrice}  now ${row.currentPrice ?? '—'} (${row.pnlAtCurrent ?? '—'})  →  ${row.newPrice} (${row.pnlAtNew ?? 'needs a conversion'})${row.crosses === null ? '' : `  crosses its ${row.crosses === 'STOP_LOSS' ? 'stop loss' : 'take profit'}`}`,
      );
    }
    console.log(`\nBy account (balance → balance + these positions at the new prices):\n`);
    for (const account of impact.accounts) {
      console.log(
        `  #${account.accountNumber}  ${account.positions} position(s)  ${account.balance} → ${account.balanceWithNew ?? 'needs a conversion'} ${account.currency}${account.balanceWithNew !== null && toDecimal(account.balanceWithNew).lte(0) ? '  — NOTHING LEFT' : ''}`,
      );
    }
    const crossing = impact.positions.filter((row) => row.crosses !== null).length;
    console.log(`\n${crossing} position(s) would cross a stop loss or take profit on the switch.`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
