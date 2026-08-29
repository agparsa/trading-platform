# Charting

**Decision: TradingView Advanced Charts**, integrated through our own datafeed.
**Rendering today: `lightweight-charts`**, behind that same datafeed.

## Licensing

The Advanced Charts library is licensed by TradingView and distributed privately
to approved applicants. It is **not** on npm and is not vendored in this
repository.

Consequences for this codebase:

- `apps/web/public/charting_library/` and `apps/web/public/datafeeds/` are
  git-ignored. Unpack the licensed library there.
- `NEXT_PUBLIC_CHARTING_LIBRARY_PATH` points at it (`/charting_library/`).
- Nothing about the library is faked. The chart on screen is a different,
  Apache-2.0 renderer, and the panel says so.

## The datafeed boundary

`apps/web/src/lib/datafeed.ts` is the seam. Everything a chart needs from this
platform passes through it — bar history over `GET /market/candles`, live bars
over the `candles` WebSocket channel — and charting libraries plug in on the far
side. That is what makes the renderer swappable without an engine, API or
WebSocket change.

It also owns the bar-window arithmetic, which is where an accidental polling loop
hides: the window is snapped to the bar boundary, so the query key changes once
per bar instead of once per render.

## What renders today

`lightweight-charts` (Apache-2.0, on npm). Real candlesticks, price and time
axes at the instrument's own precision, crosshair, pan and zoom, and the
in-progress bar updating from the stream.

Two behaviours are deliberate:

- **The chart is created once and then fed.** Recreating it on data change would
  throw away the trader's pan and zoom on every tick.
- **Below a screenful of bars it does not stretch to fit.** `fitContent` on three
  bars draws three enormous blocks and reads as a market that moves in steps; a
  fresh instance holds a normal bar width and sits at the right edge instead.

What it does not have: indicators, drawing tools, and order-from-chart. Those are
the reason for the licensed library.

## Datafeed adapter for Advanced Charts

`apps/web/src/lib/tradingview-datafeed.ts`. **The mappings are implemented and
tested; the widget construction is not, because the library is absent.**

The contract was taken from TradingView's published documentation and from their
own `charting-library-tutorial` repository — not from memory. Two units differ,
and mixing them renders every bar in 1970:

| Value                       | Unit             |
| --------------------------- | ---------------- |
| `PeriodParams.from` / `.to` | **seconds**      |
| `Bar.time`                  | **milliseconds** |

Verified against the tutorial's own `getBars`, which multiplies
`periodParams.to` by 1000 before comparing it with bar times.

| Datafeed method | Backed by                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------ |
| `onReady`       | Supported resolutions from `Resolution`                                                          |
| `searchSymbols` | `GET /symbols`                                                                                   |
| `resolveSymbol` | `GET /symbols/:code` → `SymbolSpec` (pricescale from `pricePrecision`, `minmov` from `tickSize`) |
| `getBars`       | `GET /market/candles?from&to&resolution`                                                         |
| `subscribeBars` | WebSocket `candle.update`                                                                        |
| `getServerTime` | `meta.serverTime` on any response                                                                |

Three more details that are easy to get wrong and are pinned by tests:

- **`countBack` outranks `from`.** The library states how many bars it needs;
  returning fewer makes it ask again for the shortfall.
- **`to` is exclusive.** The bar opening exactly on it belongs to the next page,
  and returning it draws the same bar twice.
- **Session strings renumber the week.** Ours are 0=Sunday; the library's are
  1=Sunday, so every day shifts by one, and windows sharing an open and close
  collapse into one segment (`0000-2400:23456`).

The library's types ship inside the licensed bundle, so the adapter declares the
subset it uses by hand. When the bundle is unpacked, delete those declarations
and import `IDatafeedChartApi` — the shapes are deliberately identical, so the
compiler confirms the mapping rather than the author's memory.

## The rule that must not be broken

**TradingView is never the source of truth for account state.**

The chart renders prices and draws position, order, SL and TP overlays. Dragging
an SL line issues a `PATCH /positions/:id` and the line moves only when the
server confirms. It does not move optimistically and then reconcile — a stop-loss
that appears to be at one price while the server holds another is the single
worst failure this UI can have.

## The two halves of the seam

Reading and writing are separate, and both exist.

**Reading.** `lib/tradingview-datafeed.ts` holds the mappings — seconds against
milliseconds, price scale, session strings — and the datafeed object itself.
`lib/chart-datafeed.ts` assembles it from this application's own state: bars over
REST through `createPlatformDatafeed`, live bars out of the realtime store, the
instrument list and sessions from React Query.

The library is not here, so nothing renders from that object yet. It is still
driven end to end by `chart-datafeed.test.ts` — `onReady`, `resolveSymbol`,
`getBars` against a stub API, `subscribeBars` against the real store,
`unsubscribeBars` — because *written* and *works* are different claims and only
one of them can be made without running it.

**Writing.** `lib/chart-commands.ts` is `TradingCommandAdapter`: move a stop or a
target, move a resting order, close a position, cancel an order. The
lightweight-charts panel issues every trading action through it today, so the
interface is the one in use rather than one designed in advance for a library
nobody has run. When the licensed bundle arrives it is handed the same object.

It deliberately does not validate. Snapping to the tick grid and refusing an
illegal level live in `lib/chart-levels.ts`, which is pure and tested; an adapter
that also validated would be a second home for those rules and a second place
for them to drift.

## Remaining work when the licence arrives

1. Unpack the bundle into `apps/web/public/charting_library/`.
2. Replace the hand-declared types with the library's own.
3. Construct the widget with `buildChartDatafeed(...)` as its datafeed.
4. Add the overlays — position, order, SL and TP lines — driving them through
   `useTradingCommands`, under the rule above.

Steps 1–3 are the day's work the adapter exists to make small. Step 4 is the
part that needs care, and `chart-levels.ts` already holds the rules it needs.
