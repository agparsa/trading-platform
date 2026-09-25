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

## 5. What Phase 6 does not deliver

Stated rather than stubbed. None of this is built:

- **The watchlist's inline quick ticket.** Rows do not expand into SELL/BUY
  price buttons with volume steppers and a notional. Categories and Top Movers
  do not exist either; search and favourites do.
- **Stop-limit orders.** The ticket offers market, limit and stop. The API's
  `PendingOrderType` is `LIMIT | STOP` — adding stop-limit is an engine change
  (a second trigger price, and a resting order that becomes a limit rather than
  filling), not a control on a form.
- **Trailing stop on the ticket.** Trailing exists on an open position and is
  not offered at entry. (Expiry is: a resting order is GTC or Day. This entry
  used to list expiry as missing too.)
- **Estimated swap in the ticket.** Swap depends on how many nights a position
  is held, which nobody knows at entry. Showing "per night" would be honest and
  is not built; showing a total would not be.
- **Finance and Logs tabs.** Neither has a design. (Alerts is built — price
  alerts have their own tab, next to pending orders; see `price-alerts.md`.)
- **Multi-select with "Close (n)"** in the positions panel, and filter/export
  there. Close-all now exists as a command; selecting a subset does not.
- **The edit-position dialog with the calculator's other modes.** The editor is
  an inline row taking prices only — no distance, points, money or percent
  entry, though the calculator that would drive them now exists and is tested.
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
