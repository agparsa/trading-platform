# One-click and keyboard trading

Both are **off** when the terminal arrives, and confirmation is **on**.

A terminal that can send an order on a single keystroke before anyone asked it to
has made a decision about somebody's money that they did not make. Arming it is
the trader's act, and the defaults say so.

## Where the settings live

In the browser, per device, in `localStorage`.

They are **input preferences**, not account state, and that is the whole
justification. Nothing here changes what the server will accept: an order sent
with one click is validated identically to one sent with three, by the same
engine, against the same limits. What they change is how many gestures stand
between a decision and a request.

Per-device is also the safer default for the setting that matters. "Skip the
confirmation" syncing silently onto a machine the trader did not arm is a worse
failure than having to arm it twice.

Everything read out of storage is checked field by field rather than spread over
the defaults. A spread would let `{"oneClick": "yes"}` through as truthy, and
`"yes"` is not a decision anybody made. The forgiveness runs one way only:
anything unreadable becomes the **safe** value, so a corrupted store cannot arm
one-click trading or switch off a confirmation.

Confirmation is asymmetric with the rest — it stays on unless something
explicitly says `false` — so a partial or half-written object leaves the safer
behaviour standing.

## The armed badge

When one-click is on and confirmation off, the header carries a permanent
`⚡ One-click armed` marker and the ticket repeats it under the cost estimate.

This is not decoration. Without it, a trader's model of what a click does is a
memory of a checkbox they ticked at some point, and the first time that memory is
wrong they are already filled.

## Keyboard trading

| Key       | Action    |
| --------- | --------- |
| `b`       | Buy       |
| `s`       | Sell      |
| `c`       | Close     |
| `Shift+C` | Close all |

All four are remappable.

### It never fires while you are typing

The single most dangerous thing a trading shortcut can do is fire while somebody
fills in a form. `s` belongs in a volume box as readily as it belongs on a sell
button, and the two must never be confused. Any keystroke aimed at an `input`,
`textarea`, `select` or a `contenteditable` element means nothing to the trader.

A keystroke carrying a modifier the map did not ask for also means nothing.
`Ctrl+S` is "save this page" in every browser ever made, and it must not also be
"sell".

`c` and `C` are matched **by case**, not by folding the case and reading
`shiftKey` separately — a keyboard layout can produce the shift without the case,
or the case without the shift, and the difference between them is closing one
position and closing all of them.

### One order path, not two

A shortcut does not place an order. It asks the ticket to.

The ticket already owns volume, side, protective levels and the validation that
decides whether an order is worth sending. Routing a shortcut around it would
create a second way to place an order with a second set of rules to keep in
step — which is exactly how the two drift apart.

That principle has a sharp edge worth naming. A disabled button stops a click; it
stops nothing at all about a keystroke. The first version of this let a keyboard
order through with a volume the ticket had already flagged as invalid, sending
the server a request it was always going to reject and telling the trader only
after a round trip. The reason a ticket cannot be sent is now computed in one
place and consulted by both paths.

### Closing

`c` closes the expanded position, or the only position if there is only one.
Anything else is ambiguous, and **ambiguity is not resolved by guessing** —
closing the wrong position is not a mistake a trader can undo at the same price.
They are asked to expand the one they mean.

A close shortcut also brings the positions tab up first. The panel that handles
it is only mounted on its own tab, so without that the key would do nothing at
all while the trader happened to be looking at pending orders — and a shortcut
that silently does nothing depending on which tab is showing is worse than one
that does not exist.

`Shift+C` **always** asks, whatever the one-click setting says. One-click exists
to remove a step from an action a trader takes all day; "close everything" is not
that action, and the setting that speeds up routine trading must not quietly also
arm the panic button.

Each position is closed on its own request, so one refusal does not strand the
rest.

### The confirmation names the order

"Send BUY 0.05 XAUUSD?" rather than "Are you sure?". A trader confirming a
keystroke they may have half-pressed needs to see what they are agreeing to, not
be asked whether they meant something the dialog will not name. The same applies
to closing: "Close all 4 positions?".

## How this was verified

The pure decisions — what a keystroke means, when it means nothing, what a stored
blob is allowed to arm — are unit-tested, and each was checked by breaking it:
firing while typing, ignoring modifiers, letting close-all skip its
confirmation, spreading stored preferences over the defaults, and defaulting
confirmation off. All five fail the suite.

The wiring was driven in a real browser against a running stack, because "does
typing `s` into the volume field sell a lot of gold" is not a question a unit
test can answer:

- pressing `b` with shortcuts off opened nothing;
- typing `0.05sbc` into the volume field opened nothing;
- an invalid ticket refused the keystroke locally, with the ticket's own message,
  and sent no request;
- `b` outside a field, one-click armed, opened exactly one position with no
  confirmation;
- `s` with confirmation back on showed the prompt and placed no order;
- `Shift+C` prompted, and closing from the prompt closed the position.
