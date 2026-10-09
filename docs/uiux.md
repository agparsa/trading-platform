# Terminal UX

What the trading screen does, why it does it that way, and what it does not do
yet.

This is the Phase 6 document. Phase 6 is the terminal upgrade; **most of it is
not built**, and §5 says exactly which parts and why. What follows describes
what is there, and the reasoning behind the parts that were changed.

---

## 1. The layout

Three columns on a wide screen — watchlist, chart over the activity panel,
order ticket — collapsing to one scrolling column below `lg`. The account strip
sits under the header; toasts and the shortcut card float.

The activity panel's tabs today are **Positions (n) · Pending (n) · Trades ·
Closed · Orders · Alerts**. `scripts/uiux-doc.test.ts` reads this line against
the tabs `terminal.tsx` renders; it had stopped at Orders for as long as the
Alerts tab had existed.

---

## 2. One calculator, shared

A stop loss can be expressed four ways — a price, a distance, a number of
points, or the money it would cost — and a trader moves between them freely.
Until this phase that arithmetic lived in three places in the web app and a
fourth on the phone, each free to disagree with the others.

The disagreement would only ever be visible to the person who dragged a stop on
the chart and read a different number in the ticket, which is the worst
possible way to find out. So there is one implementation now, in
`@tp/trading-core/levels.ts`, framework-free and on the platform's own decimal
arithmetic:

| Function                            | Answers                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `distanceBetween`                   | how far apart two prices are, in price and in points                      |
| `priceAtDistance` / `priceAtPoints` | the price a given distance away, on the side a stop or a target would sit |
| `outcomeAt`                         | what a position would be worth if it closed there                         |
| `rewardToRisk`                      | reward over risk                                                          |
| `percentOfEquity`                   | that money as a share of the account                                      |
| `levelView`                         | all of the above for one level, in one call                               |
| `volumeForRisk`                     | the size that risks exactly this much                                     |

Three rules run through it:

**Direction is derived, never asked for.** A stop is adverse and a target is
favourable, so the side follows from the position's side and the level's kind.
A caller that had to work it out is a caller that can get it wrong, and a
"stop" on the profitable side is an order that protects nothing.

**No rate is ever assumed.** Every figure that crosses currencies takes
`quoteToAccountRate` from the caller. A browser that does not hold one passes
`null` and gets `null` back. Assuming 1 is how a euro account is shown a dollar
figure that looks right and is not.

**Sizing rounds down.** `volumeForRisk` floors to the instrument's volume step.
A size that rounded up would risk more than was asked for, and the ceiling on
the loss is the entire point of the number.

---

## 3. Close all is a server command

It used to be a loop in the browser: one request per position, partial failure
swallowed. Three things were wrong with that. A trader who pressed it in a fast
market got some positions closed and some not, with no record of what they had
asked for. A dropped connection halfway through left the rest open under a
screen that said the button had been pressed. And the platform had no idea the
request had ever been made — the audit trail showed a burst of unrelated
closes.

`POST /positions/close-all` states the intent once and reports the outcome per
position.

**It is deliberately not atomic, and its result says so.** Each close takes its
own lock, its own quote and its own ledger entry. One transaction would hold a
lock on the account for the duration, deadlock against the tick loop closing a
stop on the same position, and — worse — let one unpriceable instrument roll
back closes that had already happened at real prices. So a `200` means the
command ran, not that everything shut: the caller reads `refused`, which names
each position still open and why.

**Largest margin first.** If the account is near a stop-out, releasing the most
margin soonest is what makes the rest closeable rather than liquidated halfway
through by the engine.

**A selection is the same command.** The positions table has a checkbox per row
and one in the header; ticking any shows "n of m selected" with **Close (n)**,
which asks first and then sends `POST /positions/close-all` with `positionIds`
— the ticked ids, as one command, not a loop of single closes, for the same
three reasons. The server answers for every name it was given: an id that is
not an open position on that account (closed meanwhile, or another account's,
even the same trader's) is in `refused` as `POSITION_NOT_FOUND`, never dropped,
because a selection that silently shrank is the partial failure the command
exists to end. The selection is kept as ids and re-read against the rows, so a
position that closes by its stop leaves the selection with the list; after the
command, what closed is forgotten and what was refused stays ticked beside the
notice that says why.

---

## 4. What changed on the screens

- **Risk as a share of equity** in the ticket, beside the money. "Two percent"
  is a rule people follow; "eighty-four dollars" is not, and cannot be compared
  between a small account and a large one.
- **Large-order confirmation** (§86). An order committing more than half of
  free margin, or risking more than 10% of equity at its own stop, is confirmed
  — **whatever the one-click setting says**. One-click is a convenience for
  ordinary size; it was never a request to skip the one order that could take
  the account down. The threshold is a share of the account rather than a lot
  count, so it is meaningful on a £500 account and a £5m one.
- **An account selector**, when there is more than one account. Until now the
  terminal set the account to `accounts[0]` at sign-in and never exposed a way
  to change it, so a trader with two accounts could reach only the first. The
  choice is remembered per browser and **validated against the account list on
  every sign-in** — a closed account, or a different person on the same device,
  must not leave the terminal pointed at an id this login cannot reach. When
  there is only one account it stays a label: a dropdown with one option
  suggests something can be done and then cannot.

---

**Swap per night on the ticket.** Below margin and commission the ticket shows
one night's financing for the chosen side and volume — `swapAccrual` from
`@tp/financial-core`, the same formula and rate the worker posts with, for one
night, signed as the ledger will show it. It is per night on purpose: how many
nights a position is held is not known at entry, and the triple-swap day posts
three at once; the row's tooltip says both. A zero rate shows as zero rather
than disappearing, so "nothing shown" only ever means "cannot be priced here"
(no quote yet, or a quote currency the account does not hold).

**Levels in the trader's own unit.** The position editor's stop and target
fields take a price, a distance from entry, a number of points, the money the
level would cost or make, or that money as a percent of equity — a unit
selector beside each field (`components/level-field.tsx`, logic in
`lib/level-entry.ts`). Every unit resolves to a price through the calculator
in `@tp/trading-core` (`priceAtDistance`, `priceAtPoints`, and a new
`priceForOutcome` that runs the outcome backwards, rounding towards the entry
so a stop never risks more than was named), and the line under the field shows
that price and its meaning in the other units before anything is sent. The API
still takes a price and only a price; what is sent is the resolved one, and
"Apply levels" is held while a typed level has not resolved. Changing the unit
clears the text rather than reinterpreting it: "12" as a distance and as a
percent are different stops. Money and percent need a rate the browser does
not hold, so on an instrument quoted in a currency the account does not hold
they say so and offer the other three. The ticket keeps price-only fields for
now.

**Trailing stop on the ticket.** A "Trailing distance" field below the levels,
for market and resting orders alike. It is sent only when typed, as
`trailingStopDistance`, and the position opens already trailing — anchored on
the exit price at the fill, for a resting order whenever that is — so there is
no longer a window between the fill and the first stop. The firm's
`trailing_stop` flag is the server's to apply; the ticket shows the field and
the server refuses the order, as the position editor's trail field already
worked. (Expiry is on the ticket too: a resting order is GTC or Day.)

**Filter and export in the positions panel.** A filter box above the table
(`lib/positions-view.ts`): each word must match the symbol, the side as a whole
word, or the start of the reference or id — words, not a pattern — and Escape
clears it. The count says "n of m shown", the header checkbox ticks what is
shown, and a ticked row the filter hides stays ticked. "Export CSV" writes the
shown rows through the same `ExportBar` the history screen uses (now
`components/export-bar.tsx`): the server's own decimals, every level and the
trail, and the P&L as marked at export — named `floatingPnlAtExport` so the
file does not pretend to be a settlement.

**Trading from the watchlist.** A row's bid and ask are buttons — "Sell
XAUUSD at 4,583.58", "Buy … at …" — that stage a market order in the ticket.
They never send. The ticket is the one place an order is built and checked,
and the press goes through it the way a B or S keystroke does. Unlike a
keystroke, it **always asks**, whatever the one-click setting: the same press
that stages the order also changed the instrument, under a volume chosen for
another one (1.00 lot of gold is not 1.00 lot of EURUSD), and a ticket left on
LIMIT would otherwise rest an order where the trader pressed a price to deal
at. So the ticket switches to market and asks "Send BUY 0.10 XAUUSD at
market?". A closed market or a missing quote shows a plain price, not a button
the server would only refuse. At rest the buttons look like the prices they
replace; hover and focus show which side they deal.

**Categories and Top movers.** The groups are the platform's own — the
`category` an administrator files an instrument under, sent on `GET /symbols`
— offered as chips in the order the platform lists its instruments, and only
when there are at least two (one chip filters nothing; an API older than the
field sends none, and the row of chips simply is not there). A chip narrows the
list the way the search box and the star do, and the three combine. A chosen
category whose last instrument has been disabled stops filtering instead of
leaving an empty list with no reason on it.

"Movers" ranks what is shown by the size of the move since each instrument's
reference price, either direction, at most ten. It reads the server's change
(`GET /market/stats`), which refreshes once a minute, not the live tick: a list
that reorders under the cursor on every tick is a list nobody can click. An
instrument with no reference yet — an em dash, not a zero — and one exactly
unchanged have not moved, and are not on it. Ties keep the platform's order.

Building it showed the column it ranks by was not on screen: at every width
the terminal lays out three columns, the watchlist's table was wider than its
panel and the change column sat behind a horizontal scroll. The cells are now
tight, a session label wraps under the code instead of widening the column,
the instrument badge appears from `xl`, the spread from `2xl` (where the panel
widens to 400px), and the panel is 280px rather than 250px at `lg`. The
browser walk measures it at 1100, 1440 and 1680px, so a column added later
that pushes the table past its panel fails a check rather than hiding.

## 5. What Phase 6 does not deliver

Stated rather than stubbed. None of this is built:

- **A ticket inside a watchlist row.** Search, favourites, categories and
  Top movers exist, and the bid and ask stage an order (§4); rows do not
  expand into a ticket of their own with a volume stepper.
- **Stop-limit orders.** The ticket offers market, limit and stop. `STOP_LIMIT`
  is already in the database's `OrderType` enum, so no migration is needed for
  the type — but the order's _second_ state is. After its stop is reached it
  rests as a limit, possibly for hours, and nothing in the order model can say
  "stop reached, now resting at the limit": `TRIGGERED` means a fill is in
  progress, and the interrupted-fill sweep rejects any order left there for two
  minutes; `PENDING → PENDING` is not an edge of the order state machine. The
  honest options are an `activated_at` column with a new `ACTIVATED` order
  event — an enum value an older image cannot read, so the deploy needs a
  rollback floor — or a new edge in the state machine and its documented
  table. Either is an engine change to make on its own, with its own tests,
  not alongside a form.
- **Finance and Logs tabs.** Neither has a design. (Alerts is built — price
  alerts have their own tab, next to pending orders; see `price-alerts.md`.)
- **Design tokens beyond colour.** There is no spacing scale and no typography
  scale; sizes are arbitrary utilities repeated inline. There is no light
  theme.
- **Documented screen-reader paths.** An _automated_ accessibility pass now
  runs on every browser suite — nine screens, WCAG 2.1 AA, serious violations
  failing the run — and it found two real defects on its first run (see
  [accessibility.md](./accessibility.md)). What it cannot check is still
  unchecked: whether a screen reader's path through the order ticket makes
  sense, whether a live P&L column announces politely, whether the chart is
  usable without sight. Shortcuts exist and are configurable; the keyboard path
  through them has not been walked by anyone who needs it.

The parts that were built are the ones where the alternative was a defect — a
calculator that could disagree with itself, a close-all that could half-happen
silently, an account a trader could not reach, an order that could take the
account down without a pause. The rest is presentation, and presentation
without the screenshots it is meant to match would be invention.
