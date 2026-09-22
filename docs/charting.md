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
- `NEXT_PUBLIC_CHARTING_LIBRARY_PATH` is the name that will point at it
  (`/charting_library/`). **Nothing reads it yet** — the loader that would is
  part of the integration this section is waiting on. It is in `.env.example` so
  the setting is not invented twice, marked there as reserved.
- Nothing about the library is faked. The chart on screen is a different,
  Apache-2.0 renderer, and the panel says so.

## The datafeed boundary

`@tp/chart-core` is the seam. It used to live in `apps/web/src/lib/datafeed.ts`;
it moved to a package when the mobile app needed the same bars, which is the
boundary doing exactly what it was built for. Everything a chart needs from this
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

## On the phone

The same renderer, in a WebView, fed through the same `@tp/chart-core`. A second
candlestick implementation for mobile would be two things to keep looking alike,
and a trader who saw a different chart on each device would be right to distrust
both. The cost is a WebView bridge and a JavaScript context per chart; it is
paid deliberately.

The library is loaded from a CDN at a **pinned** version. An unpinned chart
library is a rendering change nobody reviewed, shipped to a phone at whatever
moment upstream publishes. When it cannot load — an offline phone, a blocked
network — the page says so rather than leaving a blank rectangle, because a
blank rectangle reads as "no data", which is a different and much more alarming
thing than "you are offline".

Bars are injected from the native side rather than fetched inside the WebView.
The access token lives in the keychain, and handing it to a browser context so
it can make its own authenticated requests would put a credential somewhere it
does not need to be.

`scriptSafeJson` escapes `<`, `>` and the two JavaScript line terminators before
anything is interpolated into the page. `JSON.stringify` does not do this — a
test written on the assumption that it did is what found the gap.

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

| Datafeed method | Backed by                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| `onReady`       | Supported resolutions from `GET /market/resolutions` — what this deployment serves, not the vocabulary |
| `searchSymbols` | `GET /symbols`                                                                                         |
| `resolveSymbol` | `GET /symbols/:code` → `SymbolSpec` (pricescale from `pricePrecision`, `minmov` from `tickSize`)       |
| `getBars`       | `GET /market/candles?from&to&resolution`                                                               |
| `subscribeBars` | WebSocket `candle.update`                                                                              |
| `getServerTime` | `meta.serverTime` on any response                                                                      |

### Resolutions: one vocabulary, and the server says which it serves

`@tp/market-core` is the vocabulary — seven resolutions, `1` to `1D`, with the
label a timeframe button shows and the milliseconds a bar spans.
`@tp/chart-core` re-exports it; it used to carry its own six-entry copy
captioned "must match `CANDLE_RESOLUTIONS` on the server", which it did not: `30`
was aggregatable, accepted by `GET /market/candles`, offered by no screen, and
persisted nowhere by default, so a request for it answered with an empty chart
— which reads as a frozen feed rather than as a setting.

A deployment aggregates a subset of the vocabulary (`CANDLE_RESOLUTIONS`;
`30` is in the default now). `GET /market/resolutions` says which, in order,
and the web terminal, the TradingView adapter's `onReady`/`resolveSymbol` and
the phone's chart build their row of timeframes from that answer, falling back
to the whole vocabulary only until it arrives. `GET /market/candles` refuses a
resolution outside the vocabulary and, separately, one the platform knows but
this deployment does not aggregate — each refusal names what would have been
accepted.

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
`unsubscribeBars` — because _written_ and _works_ are different claims and only
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

---

## Persistence (Phase 7)

Chart state was client-local: a reload lost the resolution, and nothing a
trader arranged survived closing the tab. Three tables hold it now, and the
shape of them is the interesting part.

### The arrangement is a blob this platform never parses

`content` is JSON that is stored, returned and replaced verbatim. A chart's
arrangement is the renderer's own description of itself — which studies at
which settings, on which panes, with what drawings and where the viewport was
— and every renderer describes that differently.

That matters here more than usual, because **this platform is going to change
renderer**. Parsing the blob would mean holding an opinion about a format we do
not own and being wrong about it the first time the licensed library ships its
own shape. What lives in columns is only what can be answered without parsing —
whose layout, which instrument, which resolution, which one to open — and that
is exactly the part that survives the swap. A layout the new library cannot
read still says what it was of.

The one thing enforced about the blob is its **size**: 256 KB, roughly two
orders of magnitude more than a busy real layout. The refusal names both the
size given and the limit, so it is actionable rather than a wall.

### Three tables, because the three things have different lifetimes

| Table           | Keyed by              | Why separate                                                                                                                                                                                                                                                                        |
| --------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ChartLayout`   | user + account + name | One arrangement of one instrument. Bound to an account, because the levels on it are that account's positions.                                                                                                                                                                      |
| `ChartTemplate` | user + name           | A set of studies with no instrument at all — built once, applied to whatever is opened next. Folding it into a layout would mean copying it into every chart.                                                                                                                       |
| `UserDrawing`   | user + symbol         | **Drawings belong to the instrument.** A trendline drawn on gold is about gold, and a trader who switches layout expects their lines to still be there — which is how every terminal they have used behaves. Storing drawings inside a layout would silently lose them on a switch. |

### One default, enforced by the database

"Which chart do I get when I open the terminal" must not depend on row order,
so a partial unique index allows one default per person per account. Two
indexes, because `account_id` is nullable and Postgres treats NULLs as
distinct — without the second, a person could hold any number of
account-agnostic defaults.

Setting a new default clears the old one **in the same transaction**. Without
that the index would refuse the second — correctly, and confusingly.

A person who has saved nothing gets `null`, never an invented default: a chart
the platform made up and called theirs is a small lie noticed the first time it
opens the wrong instrument.

### What the web app persists today

The instrument and the resolution, under the name `Last used`, debounced by two
seconds — clicking along a row of timeframes would otherwise be a write per
click, and none of the intermediate ones is what the trader meant. It is
restored once on load, and the save is armed only after that restore has run:
saving first would overwrite the layout with the default state on every page
load, which is the failure that turns "remembered" into "reset".

`content` is `{}` from this renderer, because `lightweight-charts` has no
arrangement to give — no studies, no drawings. The storage is ready for one.

### Still blocked

Indicators and the drawing set are what the licensed library is _for_. Building
them on `lightweight-charts` primitives would be writing a second charting
library and throwing it away when the licence arrives. They wait; the storage
that will hold them does not.
