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
Closed · Orders · Alerts · Finance · Logs**. `scripts/uiux-doc.test.ts` reads this line against
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

**A row's own ticket.** The arrow beside an instrument's code opens a ticket
inside that row: a volume stepper and the two prices as Sell and Buy. It
exists for the problem the bare prices cannot solve — they stage whatever
volume the main ticket held, chosen for a different instrument. The row
opens on the trader's default volume where that instrument accepts it and on
the instrument's minimum where it does not (never on more), steps by the
instrument's own lot step, and names a volume the server would refuse
(`volumeProblem`, the same `checkVolume` the API runs) instead of offering to
stage it. Pressing Sell or Buy stages that volume in the main ticket, which
asks "Send BUY 0.37 XAUUSD at market?" exactly as above — the row never
sends. One row is open at a time; on a closed market its buttons are
disabled with the reason beside them. Rendered tests in
`watchlist.test.tsx`; the browser walk opens one, stages, cancels, checks
that no order exists, and runs the terminal's accessibility audit with the
row ticket open (its first version, tinted buttons, failed it at 4.2:1).

**The Finance tab.** The account's balance history: every entry of its
ledger, newest first — deposits, transfers, closed trades, commission, swap,
fees and adjustments — each with the balance it left, so the top row's
balance is the balance the account shows. It reads `GET
/accounts/:id/ledger`, the append-only rows reconciliation replays, fifty at
a time with "Load older movements"; nothing is netted or recomputed in the
browser, and the CSV export writes the loaded rows with the server's own
decimal strings. TRADE_PROFIT and TRADE_LOSS both read "Closed trade" — the
sign says which — and a type the screen does not know is shown as the server
spelled it rather than hidden. The account page shows the same component
under "Balance history". The browser walk compares the tab with the database
(row count, and the newest balance against the account's) and audits it.

Building it turned up the endpoint's paging: ordered by `created_at` alone
with an id cursor, Prisma could not form a keyset and sent every entry at or
before the cursor **with no LIMIT**, cutting the page in memory — each page
of a long ledger read the ledger. It now orders by `(created_at, id)`, which
becomes a bounded keyset query; `scripts/cursor-order.test.ts` holds every
cursor query in the API to that.

**Language: English or Persian.** Settings (and the sign-in page, so a
Persian reader need not find Settings in English first) offers English and
فارسی, per browser like the theme. A script in the document head sets
`lang` and `dir` before the first paint, so a Persian page is right to left
from the start; `locale.test.ts` runs that script against every stored value
and compares it with the bundle's own rule. Every changing figure keeps the
`numeric` class, and in a right-to-left page that class stays left to right
with its own isolation, so `-1,204.50` is never mirrored; figures stay in Latin
digits, as on the charts and statements they are compared with. A figure set into a
Persian sentence (`{amount}` in a message) is wrapped in a left-to-right
isolate by `translate`, so `$10.00` is not reordered into `10.00$` by the
words around it. Fields that hold words (`wordInputClass`) follow the page's
direction; fields that hold figures stay `numeric`. A figure is left to right but aligned as
the page is: `text-align: -webkit-match-parent` (Chromium resolves the
unprefixed keyword against the figure's own direction), and an explicit
`text-end` on a figure means the page's end. A figure that needs inline
padding or margin on one side is wrapped in a `numeric` span, so the padding
follows the page. The browser walk measures a label and its figure in
Persian and fails if their right edges part. The words are
in `lib/messages.ts`: English is the source, the Persian table is typed against
its keys, so an untranslated key fails the build, and both must use the same
placeholders. Translated: every trader screen — navigation, sign-in, Settings,
the terminal (order ticket, chart caption, watchlist, every activity panel and
popover), Account, Wallet, Verification, History, Analytics, Instruments,
Security and Developer — and the codes the server sends, worded through the
tables in `lib/server-words.ts` (order status, close reason, account status and
type), which `client-vocabularies.test.ts` holds to the Prisma enums. CSV
exports keep the codes. Still English: the server's own messages, the admin
console and the phone; the language note says so on screen. The layout mirrors: every margin, padding,
alignment and offset in the web app is a logical utility (`ms-`, `pe-`,
`text-end`, `end-`), not a physical one, so start and end swap with the
direction rather than staying pinned to left and right. The browser walk chooses فارسی, reloads, checks the page is right to
left with Persian links and a left-to-right figure, and audits Settings and the
terminal in it.

**Density.** The terminal's header is one row at a laptop width (the email
shows only at `2xl`; the sign-out button carries it as a title), and the
account strip is one row of twelve figures, sized by a container query so the
Account page's narrower panel gets two rows of six. Small controls use the type
scale (`text-caption`, `text-label`): `cn()` in `@tp/ui` is told those are
sizes — tailwind-merge had read them as colours and dropped them beside a
colour class, so every control built with `cn()` had rendered at 16px.
`scripts/type-scale.test.ts` holds `TYPE_SCALE` to globals.css. The order
ticket puts Sell first, at the bid, and Buy second, at the ask, as the
watchlist's row ticket and the bid/ask line do. A change that rounds to zero
reads `0.00%`, uncoloured — never a red `-0.00%`.

**On a phone.** Below `lg` the terminal is not the desktop's columns stacked
(that put a 200-pixel header and a block of twelve figures above a
thumbnail-sized chart). It is five screens behind a tab bar — Markets, Chart,
Trade, Positions, Account — as trading apps lay it out. The header names the
instrument (a searchable list opens from it) and the account's floating P&L.
The Chart screen shows the visible range's high and low, scrolling timeframes,
and a quick ticket under the thumb: the bid to sell at, a lot size, the ask to
buy at, Sell on the left and Buy on the right in Persian too (a price ladder
reads left to right like its figures). Sell and Buy _stage_ the order and open the Trade screen, where the
same ticket as on the desktop asks before sending — nothing on a phone sends on
one tap. Positions are cards (side and size, entry → now, the server's P&L),
which open to the levels, swap, margin and three actions: Edit (the desktop's
position editor), Break even (one modify moving the stop to the entry and
keeping the target and trail; the server refuses it when the market is on the
wrong side) and Close, which asks when confirmations are on. Close all always
asks. The same queries and socket as the desktop: a second layout, not a second
calculation. The browser walk checks at 390×844 that nothing is wider than the
screen, that Sell stages and sends nothing, that there is one card per open
position in the database, and audits both screens.

**Positions on the chart.** Each open position on the chart's instrument is
marked at its entry with a chip — its size, coloured by side, and the server's
live P&L — and a close button. The chip is HTML over the chart, so the button
is a real, named, focusable button, placed from the chart's own price
coordinate whenever the bars, the visible range or the positions change (no
timer). Closing asks on the chip itself, Close or Cancel: a cross beside a
moving price is the easiest thing on the screen to hit by accident. The browser
walk checks one chip per open position in the database and that Cancel leaves
the position open.

**Size by risk.** The ticket can size an order from the money a trader is
willing to lose: tick "Size by risk", name the amount, set a stop loss on the
losing side, and the volume follows — `volumeForRisk` in `@tp/trading-core`,
rounded down to the lot step so the loss at the stop is never more than named,
and capped at the maximum lot. It answers nothing (and says what it needs)
without a stop on the losing side, for an amount below the minimum lot, or
when the instrument is quoted in a currency other than the account's: the
browser holds no exchange rate and a guessed size is a wrong size. The order is
checked as any other; "If stopped" shows what it risks.

**The pre-trade check.** A market order complete enough to send is shown to
the risk engine before it is sent: `POST /orders/preview`, asked once the
ticket's fields have been still for half a second (a quote tick asks
nothing). When the engine would refuse it, the ticket lists **every** rule
it would break — the per-position limit _and_ the margin, not the first of
them — above the estimates, and its warnings below. It decides nothing: the
order is checked again, under the account lock, when it is sent, and a
preview that fails to answer leaves the ticket as it was. Until 3 November
only the phone asked; the web showed its own arithmetic and learned the
rules from a refusal.

**The Logs tab.** The account's order log: every event the engine recorded
for every order on the account — placed, checked, accepted, triggered,
filled, changed, cancelled, expired, refused — newest first, each in the same
words as an order's own trail in the Orders tab, with the order's symbol,
side and type in front. Orders shows one trail at a time when it is opened,
Finance what reached the balance, Settings the sign-ins; this is the one list
of what happened to the account's orders, in order. It reads `GET
/accounts/:id/order-events` — the stored rows, with the venue's side dropped
as on the trail — fifty at a time with "Load older events", and exports the
loaded lines. Within one transaction the rows share a timestamp, so they are
ordered by the sequence they were written in (`seq`), newest first: a market
order's Filled sits above its Placed. Not in it: an order the risk engine
refused before it existed, because the refusal rolls the order back — the
ticket shows that refusal at the time. The browser walk compares the tab with
the stored events and audits it.

**Analytics.** `/analytics` is the account's results from its closed
trades over three months, a year or all time: net result, return, average
win and loss, profit factor, gross profit and loss, and the split by side,
by trading day and by month. Every figure is the server's
(`GET /accounts/:id/performance`, computed by `performanceOf` in
`@tp/trading-core` with exact decimals from `Trade.netPnl`); the page only
lays them out. A trade counts on the day and in the month it closed, in the
trading server's timezone. A figure that cannot honestly be given is a dash
with its reason: no profit factor without a losing trade, no return without
a balance from before the period (read from the ledger, so deposits and
withdrawals in between are not counted as results). Prop challenges and copy
trading, which some terminals put beside it, are not this platform's.

**Instruments.** `/instruments` lists every enabled instrument on the terms
this firm trades it — contract size and quote currency, tick size and the
value of one tick on one lot (`tickValue`), volume minimum, maximum and step,
margin, commission per lot (charged on opening and again on closing) and swap
long and short per lot per night — with each one's trading hours opening on
request from `GET /symbols/:code`. Margin is the rate this account is
charged, the engine's `effectiveMarginRate`: where the account's leverage
asks for more than the instrument does, both are shown. The hours are read
with the engine's own rule for joining windows, now in `@tp/shared-types`
(`mergedSessionRanges`) rather than private to the API, so the metals week —
stored a day at a time — reads as "Sun 22:00 – Fri 21:00", the same session
the engine opens and closes. Before this screen a trader learned an
instrument's commission or swap by trading it.

**The type scale.** The sizes below Tailwind's `text-xs` are named by role
in `globals.css` — `text-micro` (9px, a badge in a cell), `text-label` (10px,
headers, labels, units), `text-caption` (11px, secondary lines, hints, small
controls) and `text-body` (13px) — and 460 inline `text-[10px]` /
`text-[11px]` (plus a few 9, 12 and 13) became them, one for one, at the
same pixel size and with no line height of their own, as before. The two
12px uses became Tailwind's `text-xs`. `scripts/type-scale.test.ts` refuses
an arbitrary font size anywhere in the web app and any size name nothing
defines — `text-lable` generates no CSS and failed nothing before.

**An order's trail.** Each row of the Orders tab (terminal and `/history`)
opens its trail — `GET /orders/:id/events`, the order's recorded state
changes in the order they happened: placed, checked, triggered, changed
(with what it was before), filled, refused, cancelled, expired, and the
reason where the server gave one. The Orders tab says where an order ended;
the trail says how, which is the question asked about the order that did
not fill. Labels cover every `OrderEventType` (a test reads the enum), an
unknown type is shown as spelled, and the browser walk compares the steps
shown with the database's count for that order.

Wiring it found that the endpoint returned each event's payload whole — and
a venue-executed order's payload names the firm's broker connection
(`venue`), the venue's ids (`clientOrderId`, `externalOrderId`) and the
venue's names for the instrument and the account (`externalSymbol`,
`externalAccountId`). The trader's view is now an allowlist
(`traderEventPayload` in `@tp/trading-core`): a key added to a payload later
stays hidden until somebody decides a trader should read it. The admin
console's own route still reads the full record.

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

**Stop-limit orders.** A fourth tab, "STOP LMT", with a stop price (what
activates it) and a limit price (where it then rests and fills, or better). The
ticket runs the server's own `validateStopLimit` as you type, so a stop the
market has already passed is refused before sending, in the server's words. The
pending tab shows both prices and the phase — "waiting" for the stop, "at
limit" once reached — measures the distance to whichever it is waiting for,
and edits both prices while it waits and only the limit after. On the chart a
waiting stop-limit is two lines, its stop and its limit, neither draggable;
activated, it is one limit line that drags like any other. The phone lists it
as "stop 4600, then limit 4602" or "stop reached · resting at limit 4602". The
engine side is in `order-lifecycle.md`.

**Appearance: light or dark.** Settings offers Dark (the default — the
terminal is looked at for hours), Light, and "Same as this device", which
follows the operating system and keeps following it. The choice is per
browser, like the trading preferences. It is the same colour names with other
values (`:root[data-theme='light']` in `globals.css`), so every screen follows
without a per-screen change; the long and short colours are darker in light
(#26a69a on white is 2.9:1), and every light colour clears 4.5:1 as text on
the page, a panel and a raised row. A script in the document head sets the
theme before the first paint — no dark flash on load — and `theme.test.ts`
runs that script against every case of the TypeScript rule so the two cannot
drift. The chart draws on a canvas that cannot see a stylesheet, so it reads
its colours from the theme's variables and repaints when the theme changes.
The browser walk chooses Light in settings, reloads, checks the page is light,
and runs the same accessibility audit on settings and the terminal.

Building it found a leak in the stop-limit chart lines: a waiting stop-limit's
two lines shared one identity, so the chart kept only the limit line's handle
and added a new, never-removed stop line on every redraw — every quote. Each
leg now has its own identity, and a test says so.

**The spacing scale.** Measured before it was written down: no arbitrary
spacing value anywhere in the web app, and nearly every gap one of six
Tailwind steps — 0.5, 1, 1.5, 2, 3 and 4 (2px to 16px) — with a few larger
ones on the pages that are not the terminal. That is the scale, now listed in
`scripts/spacing-scale.test.ts` with what each step is for; a step not on it,
or an arbitrary `p-[13px]`, fails there, so a new gap is a decision made in
that file rather than a value typed into a component. Type has the same
arrangement (`--text-*`, above).

## 5. What Phase 6 does not deliver

Stated rather than stubbed. None of this is built:

- **Documented screen-reader paths.** An _automated_ accessibility pass now
  runs on every browser suite — forty-one views, WCAG 2.1 AA, serious violations
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
