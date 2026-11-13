# Chart trading

Stops and targets are drawn on the price chart and moved by dragging them. This
document is about the one rule that makes that safe, and what it costs to hold.

## The drawn level is always the server's value

A trader drags a stop. The line does **not** move.

That reads like a bug and is the whole design. What follows the cursor is a
_preview_ — a separate line, in a different colour and dash pattern, drawn beside
the real one. When the pointer is released the preview disappears and the
authoritative line is wherever the server says it is: at the new level if the
modification was accepted, at the old one if it was not.

The alternative — move the line, then put it back if the server refuses — has a
window in which the screen shows a stop that does not exist. On a chart a trader
is using to decide whether they are protected, that window is the failure. This
way there is no revert path to get wrong, because nothing authoritative was ever
moved by the browser.

```
drag                        drop
 │                            │
 ├─ preview follows cursor    ├─ validate locally (engine's own rule)
 │  real line unmoved         │    refused → show why, send nothing
 │                            │    allowed → PATCH /positions/:id
 │                            │                  ↓
 │                            │            server validates again
 │                            │                  ↓
 │                            │            position.updated → the real line moves
```

## Two validations, and why both

The drop is checked in the browser before anything is sent, using
`validateProtectiveLevels` **imported from `@tp/trading-core`** — the same
function the API runs. Not a copy of the rule: the rule.

That matters in both directions. The browser cannot invent a restriction the
engine does not have, and it cannot miss one the engine does. A trader who drags
a long's stop above the market is told so in the same gesture, with the engine's
own wording, instead of after a round trip.

The server validates again regardless, and its answer is the one that counts.
The client-side check only decides whether the request is worth sending.

## A pixel is not a price

A cursor lands between ticks. The dropped coordinate is quantised with
`normalizePrice`, the engine's own quantiser, before it becomes a request —
otherwise the server would reject a drag the trader performed exactly as they
meant to.

This is easy to test wrongly. An instrument whose tick size equals its decimal
precision — gold, at 0.01 and two decimals — cannot tell snapping from
`toFixed(2)`, and a test written against gold passed with the snapping removed
altogether. The test now uses an instrument that trades in five-cent ticks while
quoting two decimals, where the two disagree.

## Only the level that moved

A modification names one field. `null` is how the API spells "remove this level",
so sending `takeProfit: null` alongside a stop-loss change would silently clear a
trader's target every time they nudged their stop. `modificationFor` returns
exactly one key, and a test asserts it never contains a `null`.

## Labels are estimates, and say so

Each level carries what it would be worth if price reached it:

```
SL 4570.39   -$47.30
TP 4593.26  +$181.40
→  4612.70  +$287.50      ← the preview, mid-drag
```

Computed with the engine's `grossPnl`, so the arithmetic is not a second
implementation. It is still an **estimate**: the fill will happen at some future
quote, the closing commission has not been charged, and swap keeps accruing. It
is never presented as a result.

Each label shows the outcome at **its own line's price**. An earlier version put
the _dragged_ price's outcome on the unmoved line, so it read `TP 4640.98
+$295.90` while 295.90 was what 4647.64 would pay — two halves of one label
describing different prices, which is how somebody misreads their own risk. The
proposed figure belongs on the preview, beside the proposed price.

Where a figure cannot be computed the label shows nothing rather than zero. A
dash is honest; `$0.00` reads as "this stop costs you nothing".

## Keeping levels on screen

The price scale autoscales to the bars. A stop far from the market therefore
falls off the chart — and it is precisely the stop a trader most wants to look
at, because it is far from the market.

The series' `autoscaleInfoProvider` widens the range to include every drawn
level. It only ever widens; the bars' own range is the floor. This was found by
opening the terminal and seeing an entry line with no stop or target anywhere on
the chart.

## Grabbing

A level is grabbable within a few pixels of the line. A one-pixel target is
unusable, and a stop that is hard to grab is a stop that gets left where it is.

The pointer's position is measured against the chart container's bounding rect,
not `event.offsetY`. The library draws several canvases inside that container —
the price scale is one of them — and `offsetY` is relative to whichever element
the pointer happens to be over, so it silently changes origin as the cursor
crosses between them.

The entry line is never draggable: an entry price is history, not a setting.

A **trailing** stop is draggable, and its label names its distance. The trader
may tighten it by hand and the engine carries on from wherever they leave it;
refusing the drag would make the safer stop the harder one to set.

A finger gets a wider target than a cursor: within 20 pixels for a touch
pointer, against 6 for a mouse. A finger that misses the line pans the chart
instead, and on a phone that was most grabs. While a level is held the chart's
own pan and zoom are off, so the price scale cannot move under it.

## The SL/TP editor

Each open position is a chip at its entry: size and the live P/L from the
socket. Tapping the chip — or the entry line itself — opens the position's
editor, a small box (224 px) in the chart's lower corner, where the oldest bars
are and away from the toasts:

- side, size and entry price;
- a Stop Loss and a Take Profit field, each with **+** (draws a level half a
  percent from the market on the side it must sit, on the tick grid) or **×**
  (remove), and what the position would make or lose there;
- reward-to-risk when both are set;
- **Cancel** and **Save**; Close and Close half below.

The fields and the chart are one value. Typing moves the line; dragging the
position's SL or TP line while the editor is open fills the field instead of
sending. Unsaved lines carry a `•`. Nothing is sent until Save, which sends only
what changed — both levels in one `PATCH /positions/:id`, `null` for a removed
one. Save is off when nothing changed or a field would be refused: not a price,
off the tick grid, or on the wrong side of the market by the engine's own
`validateProtectiveLevels`. The server validates again.

While saving, the fields are disabled. The box closes only when the server has
answered and the position list holds the new values. A refusal keeps it open
with the server's reason and plays the refusal sound; the position is untouched.
A tap elsewhere on the chart closes an editor with nothing unsaved; with unsaved
changes it stays, and so does a tap on another position. A position that closes
takes its editor with it.

Without the editor open, dragging a stop or target still sends it on release, as
before: drawn as waiting until the answer, rolled back with the server's reason
on refusal.

Chips that would overlap are spread apart in price order. The chip's × asks
before closing. Close and Close half in the editor act at once, since opening
the editor was the deliberate step. A close in flight reads "Closing…", and a
double tap is one close.

## Notifications

The toasts are the server's events, never the button's: `position.created`
("Opened BUY 0.10 XAUUSD"), `position.closed` (named by its reason — stop loss,
take profit, trailing stop, stop-out, or a partial close with what is left),
`position.updated` and `order.rejected` with the server's reason. Each is keyed
by its subject, so the same news arriving twice — the order's answer and its
frame — replaces one toast instead of stacking two. A lost socket raises a
sticky "Connection lost — reconnecting…", replaced by "Connection restored"
when it returns and the lists have been re-read. See `lib/trading-toasts.ts`.

## What the chart is not

`lightweight-charts` renders; it decides nothing. Prices become JavaScript
numbers at the rendering boundary and nowhere else — a chart coordinate cannot
flow back into an order, because the decimal string it came from is what any
request carries. See [charting.md](./charting.md) for the adapter boundary and
the licensed-library seam.

## How this was verified

Driven in a real browser against a running stack, not asserted in a unit test:
register, open a position, set a stop and a target, drag the target up, watch the
preview and the unmoved line, release, and read the position back from the API to
confirm the server moved it.

Then the refusal path: drag a long's stop above the market. The preview turns
red and carries the engine's message inline — "A BUY stop loss must sit below
4584.6" — nothing is sent, and the stored stop is unchanged.

The panel, drafts, rollback and one-tap are covered by `pnpm smoke:web` on a
phone viewport against a real API and database: a refused level (the server's
envelope, injected) rolls back with its reason and leaves the row untouched; a
placed level is read back from the database and shown as the position's own;
close-half double-tapped removes exactly half once; and an armed one-tap
double-tapped on Buy creates exactly one order.
