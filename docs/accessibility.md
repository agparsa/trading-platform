# Accessibility

What has been checked, what was found, and — the part that matters most — what
this does **not** claim.

## The claim, stated narrowly

**Thirty-three views** are audited by `axe-core` on every `pnpm smoke:web` run,
against the WCAG 2.1 A and AA rule set, in a real browser with real data.
Serious and critical violations fail the run; moderate and minor ones are
printed.

Thirty-three *views*, not thirty-three pages: five of them are tab panels that
share a URL with a page already audited. That distinction is the whole of the
next section.

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

Naming those is the honest version of a pass. A suite that reported "33/33
accessible" would be worse than having none, because it would end the question.

### And a narrower limit, found by breaking it

There is a fourth category beside pass, fail and "not machine-checkable":
**cases axe declines to judge.** It reports them as `incomplete`, and this
audit discarded them for months.

On a dark UI built largely from translucent surfaces this is not a rare case:
one screen alone had thirteen, and they were thrown away.

So the audit now **resolves them itself**. It walks up from the element
collecting background layers until it reaches something opaque, blends them in
order, blends the text colour over the result, and compares luminances — the
composite axe declines to guess at. Where that succeeds the element is judged
like any other and a failure fails the run. Where it genuinely cannot — a
background image, nothing opaque in the ancestry — it stays undetermined and is
counted as such, because inventing an answer there would be worse than
admitting the gap. On the terminal: eleven resolved, two still unknown.

**The first run found a real defect.** The watchlist's star buttons were
`#232a35` on a `#12161d` row — **1.26:1**. The intent was "subtle until
hovered"; the effect was invisible. Eight of them, on the busiest screen in the
product, and the only way to favourite an instrument. Every previous audit had
passed it.

A correction worth recording, because getting it wrong is the same mistake this
document keeps warning about. This section first claimed the gap had been
proved by a mutation — a price colour changed to an unreadable grey, the audit
still passing. That mutation did survive, but **not for this reason**: the
branch it changed only renders before an instrument's first tick, so by audit
time nothing on screen used it. Mutating a cell that is always rendered is
caught by axe directly. The `incomplete` gap is real and the star buttons are
the evidence for it; the mutation was not.

The audit also **freezes CSS transitions** before measuring. The terminal
colours a price for 300 ms when it ticks, and axe was computing contrast on
whatever blend the cell happened to be showing at that instant — producing a
violation that appeared and vanished between runs on an element whose settled
colours both pass comfortably. An intermittent gate teaches people to re-run it
rather than look. What that gives up: a transition that passes through an
unreadable colour will not be caught.

## Coverage was narrower than the count suggested

The audit ran on nine screens while the suite visited twenty-eight. The other
nineteen were rendered, asserted against, and never audited — and the count in
this document was the only place anybody would have noticed.

Auditing all twenty-eight found exactly one serious violation: the security
feed's severity filter was a `<select>` with no `aria-label`, no
`aria-labelledby` and no wrapping `<label>`. A screen reader announced it as
"combo box" and nothing else.

### A survey that was wrong, and a mutation that proved it

Finding one offender raised the obvious question — how many more? The first
answer was produced by a script that read each `<select ... >` by scanning to
the first `>`. An `onChange={(event) => ...}` supplies a `>` of its own, so the
scan stopped before `aria-label` was reached, and the script reported 24
unnamed selects — including one that demonstrably had `aria-label="Severity"`.
Acting on that number would have meant 24 edits to fix one bug.

A scanner that tracks JSX brace depth and quoting gives the real figure: of 29
selects, **six** had no accessible name of their own and were not wrapped in a
`<label>` or the `Field` helper. All six now carry an `aria-label`, as do the
placeholder-only text inputs beside them:

| File | Control |
| --- | --- |
| `verification/page.tsx` | document type |
| `admin/features-panel.tsx` | broker |
| `admin/ip-rules-panel.tsx` | allow/deny, scope, address, reason |
| `admin/people-panel.tsx` | role, reason |
| `admin/security-panel.tsx` | severity, event kind |

### And the coverage gap under the coverage gap

Removing `aria-label="Allow or deny"` from the IP rules panel to check the
audit would catch it — **it did not.** The run passed.

The IP rules panel is a *tab* inside `/admin/security`, and the audit for that
URL runs before the tab is switched. Four other panels were hidden the same
way: the alerts tab on the terminal, the venue-disagreement tab on
reconciliation, the ceilings tab on the risk console, and the service-tokens
tab on credentials. Each is now audited after its tab is opened, which is where
the count of thirty-three comes from.

With the audit in place the same mutation fails the run —
`FAIL the IP rules tab has no serious accessibility violations — select-name×1`
— and passes again when the label is restored.

The lesson is not about selects. A screen counted as audited was audited; a
*view* that only exists after a click was not, and no number in this document
distinguished the two. Anything reached by a tab, a dialog, or a disclosure is
invisible to a per-URL audit unless somebody opens it first.

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
