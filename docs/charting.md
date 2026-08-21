# Charting

**Decision: TradingView Advanced Charts**, integrated through our own datafeed.

## Licensing

The Advanced Charts library is licensed by TradingView and distributed privately
to approved applicants. It is **not** on npm and is not vendored in this
repository.

Consequences for this codebase:

- `apps/web/public/charting_library/` and `apps/web/public/datafeeds/` are
  git-ignored. Unpack the licensed library there.
- `NEXT_PUBLIC_CHARTING_LIBRARY_PATH` points at it (`/charting_library/`).
- Until the licence is granted, the chart panel is absent rather than faked.

Phase 9 integrates the library. Everything the chart needs from the backend —
candles, resolutions, sessions, symbol metadata — is already specified and
implemented in `@tp/market-core`, so the integration is adapter work, not
new engine work.

## Datafeed adapter

We implement TradingView's `IDatafeedChartApi` against our own REST and
WebSocket API. The mapping is direct because `market-core` was designed for it:

| Datafeed method | Backed by                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------ |
| `onReady`       | Supported resolutions from `Resolution`                                                          |
| `resolveSymbol` | `GET /symbols/:code` → `SymbolSpec` (pricescale from `pricePrecision`, `minmov` from `tickSize`) |
| `getBars`       | `GET /market/candles?from&to&resolution`                                                         |
| `subscribeBars` | WebSocket `candle.update`                                                                        |
| `getServerTime` | `meta.serverTime` on any response                                                                |

Sessions come from `market_sessions`, already stored per symbol in an explicit
timezone.

## The rule that must not be broken

**TradingView is never the source of truth for account state.**

The chart renders prices and draws position, order, SL and TP overlays. Dragging
an SL line issues a `PATCH /positions/:id` and the line moves only when the
server confirms. It does not move optimistically and then reconcile — a stop-loss
that appears to be at one price while the server holds another is the single
worst failure this UI can have.

## If the licence is unavailable

`lightweight-charts` (Apache-2.0) is the fallback. It covers candles, price
lines and overlays; indicators and drawing tools would have to be built. The
datafeed boundary above is deliberately library-agnostic, so this is a change in
`apps/web` alone — no engine, API or WebSocket change.
