# Accessibility

What has been checked, what was found, and — the part that matters most — what
this does **not** claim.

## The claim, stated narrowly

Nine screens are audited by `axe-core` on every `pnpm smoke:web` run, against
the WCAG 2.1 A and AA rule set, in a real browser with real data. Serious and
critical violations fail the run; moderate and minor ones are printed.

That is a **machine-checkable subset of WCAG, and it is a minority of it** —
roughly a third of the success criteria can be determined by a tool at all. A
green line here means no automated check found a violation on that screen. It
does not mean the screen is accessible, and this document exists so nobody
reads it that way.

What is **not** covered, and is therefore still unknown:

- whether a screen reader's path through the order ticket makes sense in the
  order it is read;
- whether the keyboard shortcuts can be discovered by someone who cannot see
  the settings screen that lists them;
- whether a live-updating P&L column announces politely or interrupts;
- whether the chart is usable at all without sight — it almost certainly is
  not, and no automated rule will say so;
- anything that needs a person with the assistive technology they actually use.

Naming those is the honest version of a pass. A suite that reported "9/9
accessible" would be worse than having none, because it would end the question.

### And a narrower limit, found by breaking it

There is a fourth category beside pass, fail and "not machine-checkable":
**cases axe declines to judge.** It reports them as `incomplete`, and this
audit discarded them for months.

What that cost was measured rather than guessed. A price colour in the
watchlist was changed to a genuinely unreadable dark grey, the web build was
rebuilt, and the audit **passed**. The defect had not been missed by the rule —
it had been filed as `incomplete`, because the cell sits on a semi-transparent
row background and axe will not guess at a composited colour. On a dark UI
built largely from translucent surfaces, that is not a rare case: one screen
alone had thirteen.

They are now counted and printed on every run. They do not fail it — most are
unresolvable without changing the design to suit the tool, which is the wrong
way round — but the number is the honest measure of how much of a screen the
audit actually covered. A screen reporting no violations and twenty
undetermined elements has not been checked in the way the green line suggests.

The audit also **freezes CSS transitions** before measuring. The terminal
colours a price for 300 ms when it ticks, and axe was computing contrast on
whatever blend the cell happened to be showing at that instant — producing a
violation that appeared and vanished between runs on an element whose settled
colours both pass comfortably. An intermittent gate teaches people to re-run it
rather than look. What that gives up: a transition that passes through an
unreadable colour will not be caught.

## Why it runs in the browser suite

These faults live in the rendered page, not in the components: a contrast ratio
depends on the colour a number went red in, an accessible name depends on what
the API returned, and neither is visible in a unit test. The audit runs where
the browser checks already run — against the built standalone output, signed in
as a real trader and a real administrator, with a position open and a trade in
the history.

## What the first run found

Both were real, both were fixed, and both are the kind of thing that survives
every other test in this repository.

### Five inputs with no accessible name

The settings screen's `Field` helper rendered its label as a `<p>` above the
control. Visually a label; programmatically a caption with no relationship to
anything. A screen reader announced the default-volume box as "edit text, 0.10"
— and the same for the stop-loss and take-profit beside it, and for the
shortcut keys below. The `Field` now wraps its control in a `<label>`, which
needs no ids to go stale.

### Zoom was capped on every page

The root layout set `maximumScale: 1`, with a reason beside it: a trader
double-tapping a Close button should not zoom the page instead of closing a
position. The reason is real and the remedy was wrong. Capping zoom takes
pinch-zoom away from everyone who needs it, permanently, to prevent an
accidental gesture — and somebody who cannot read a price without magnifying it
cannot trade at all. That is WCAG 1.4.4, and it applied to every screen.

The gesture is now handled where it happens: `touch-action: manipulation` on
controls in `globals.css` stops double-tap zoom on the controls themselves and
leaves the page pinchable. The intent is kept; the cost is not.

## Running it

```bash
pnpm smoke:web        # the whole browser suite, audit included
```

The audit needs the web app **built** — the suite serves the standalone output,
so a source fix that is not rebuilt will appear not to have worked. That cost a
confusing run once.

## The line between failing and reporting

Serious and critical fail; moderate and minor print. Not because the rest do
not matter, but because a gate that fails on everything at once is a gate
somebody turns off. The line is the one axe itself draws: "serious" means a
person using assistive technology cannot complete the task.

Best-practice rules are excluded deliberately. They are opinions, and a failing
opinion printed beside a failing standard makes both easy to ignore.

## What would come next

A person, using the assistive technology they actually use, on the trading
terminal. Everything above is the part that can be automated, done so that the
part that cannot be automated is the only part left.
