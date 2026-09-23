# Web routes

Until phase 3 the application had four addresses — `/`, `/login`, `/admin`,
`/status` — and everything else was a tab or a popover. That is a reasonable
shape for one dense screen and a bad one for an operator working an incident,
who is handed an account number in a message and needs a link, not a route
through a search box.

Every screen has an address now. The terminal did not change.

## The map

| Route                   | What it is                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `/`                     | redirects to `/terminal`                                                                          |
| `/terminal`             | the trading terminal, full height                                                                 |
| `/account`              | balances, margin, the terms an account trades on                                                  |
| `/wallet`               | money held for you, and moving it to and from an account                                          |
| `/verification`         | prove who you are, once, so withdrawals can be paid to you                                        |
| `/history`              | trades, closed positions, orders — including refused ones                                         |
| `/security`             | two-factor, recovery codes, active sessions, your API keys, and what has happened to your account |
| `/developer`            | the API as it describes itself: every route, authentication, idempotency, verifying a webhook     |
| `/settings`             | one-click trading, confirmations, default size                                                    |
| `/login`                | sign in and register                                                                              |
| `/status`               | build and deployment status                                                                       |
| `/admin`                | redirects to `/admin/overview`                                                                    |
| `/admin/overview`       | platform figures                                                                                  |
| `/admin/people`         | search people                                                                                     |
| `/admin/people/:id`     | one person, their accounts and sessions                                                           |
| `/admin/accounts`       | search accounts                                                                                   |
| `/admin/accounts/:id`   | one account, with its owner one click away                                                        |
| `/admin/book`           | orders, positions and closed trades across the firm, with an order's own event history            |
| `/admin/instruments`    | what the platform trades, and on what terms                                                       |
| `/admin/risk`           | accounts at risk, exposure, risk events                                                           |
| `/admin/desks`          | master accounts and who may act on which account, by delegation preset                            |
| `/admin/payments`       | deposits waiting for a person, and every one before them                                          |
| `/admin/kyc`            | verifications waiting for a reviewer                                                              |
| `/admin/withdrawals`    | withdrawal requests to review, approve and mark paid                                              |
| `/admin/reconciliation` | runs and findings                                                                                 |
| `/admin/reports`        | report jobs, and their downloads until they expire                                                |
| `/admin/roles`          | what each role may do                                                                             |
| `/admin/credentials`    | everyone's API keys, and the firm's service tokens                                                |
| `/admin/connections`    | venue connections, instrument mappings, the venue inbox, orders waiting on a venue                |
| `/admin/security`       | the firm's security feed: sign-ins, credentials, changes                                          |
| `/admin/notifications`  | push deliveries: what was tried, for whom, what the provider said; figures for the last day       |
| `/admin/webhooks`       | where this firm's events are sent, and what each delivery got back                                |
| `/admin/features`       | feature flags, and who may flip each                                                              |
| `/admin/brokers`        | the platform's brokers; create one and hand its owner the invitation (platform tenant only)       |
| `/admin/audit`          | the audit trail                                                                                   |

`/wallet` arrived with phase 4 and not before. Until there was a wallet the link
was deliberately absent — §50 says not to build UI for functionality that does
not exist, and a page reading "Balance: —" is a promise the platform cannot keep.

It gained a deposit form in phase 5, and the same rule shaped it. The form offers
whatever `GET /payments/providers` returns, which on this build is a bank
transfer and nothing else: no card logos, because a button for a provider nobody
has a contract with is a button that fails on submit. A deployment with no
provider configured gets a sentence saying so rather than a disabled form.

Nothing on that page moves a balance. Starting a deposit is an instruction to the
payer; the money appears when it actually arrives. The instructions and the
reference stay visible in the payment list rather than being shown once, because
the reference is the only thing tying a line on a bank statement to a person and
somebody who closed the tab has to be able to find it again.

`/admin/payments` is the other half — the queue an operator works, opening on
"awaiting confirmation" because that is the only part of it that is _work_.

## Why the terminal is not inside the shell

`/terminal` keeps its own full-height chrome and is not wrapped in the header the
other pages share. It is one dense screen where every pixel of vertical space is
another row of the book, and a second header would cost that space on the one
screen that cannot spare it.

For the same reason the settings and security panels still open from the
terminal's header as well as having pages of their own. Both answer questions a
trader asks _while_ watching a position — arming one-click, ending a session they
do not recognise — and navigating away from open risk to do either is the wrong
shape for the question. The page and the popover are the same component with a
`presentation` prop; two implementations of a two-factor enrolment flow would be
two places to get the "shown once" rule wrong.

## What the route split is not

It is not a permission boundary. `/admin/*` is gated on having a session and on
nothing else, and a trader who types one of those URLs gets a page whose every
panel answers "your role does not include this" — which is exactly the truth, and
what they would see with the URL typed by hand anyway. Hiding the section would
be a courtesy, not a control, and building it as though it were one is how a UI
check quietly becomes the only check.

## Opening them

`pnpm smoke:web` boots the built API and the built web application, signs in
through the real login form, and visits every route above.

It exists because everything else in this repository proves something about the
server or about a pure function, and the web application had been typechecked,
linted and unit-tested and **never rendered** — which catches nothing, because a
component that throws on mount typechecks perfectly.

It needs the web application built (`pnpm --filter @tp/web build`) and a browser.
`PLAYWRIGHT_CHROMIUM_PATH` points it at one that is already installed, for
environments that provision Chromium separately from Playwright's pinned build.

Three things it found the first time it ran, none of which any existing test
could have:

- **A sign-in that bounced back to the login form**, about one time in six. The
  login page navigated as soon as the sign-in promise resolved, which is before
  React has committed the new session state — so the destination could mount
  while the context still read `user: null`, and the gate there sent the trader
  straight back. Navigation now waits for the state.
- **A refusal that looked like a hang.** Failed reads were retried once,
  including refusals, so a trader who opened an administrative page watched
  "Loading…" while the browser was refused a second time. A 4xx is an answer;
  asking again cannot change it. See `isWorthRetrying`.
- **A permission decorator orphaned by an insertion.** Adding
  `GET /admin/accounts/:id` between an existing `@RequirePermissions` and its
  `@Post` left the POST declaring nothing — any authenticated user could have
  frozen an account. Caught by the coverage test rather than by the browser, but
  found while doing this.
