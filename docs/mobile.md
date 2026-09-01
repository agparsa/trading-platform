# The mobile app

`apps/mobile`. Expo SDK 57, React Native 0.86, React 19.2, expo-router.

## What has and has not happened

**It has never been built, and it has never run on a device or a simulator.**

This session had no macOS, no Xcode, no Android SDK and no device. What is
verified is what can be verified without one: it typechecks under the same
strict configuration as the rest of the repository, it lints, and the logic that
does not need a device is unit-tested — 45 tests covering event deduplication,
the sound decisions, the token store and the number formatting.

What that leaves unverified is everything a screen does: layout, navigation,
whether a push actually arrives, whether the sounds play. Those need
`npx expo run:ios` / `run:android` on a machine with the toolchains, or an EAS
build. Recorded here rather than implied, because §46.22 says never to mark a
UI-only implementation as complete and this is exactly that half.

## Getting it onto a device

Push notifications do not work in Expo Go — Expo removed them from it in SDK 53
— so a development build is required from the start, not eventually:

```bash
cd apps/mobile
npx expo prebuild            # generates ios/ and android/
npx expo run:ios             # needs macOS and Xcode
npx expo run:android         # needs the Android SDK
```

`expo.extra.apiBaseUrl` must be set in `app.json` before the app will start; it
throws rather than falling back to localhost, because a client that silently
points at the wrong host looks like a network problem to everyone who has to
debug it.

## The shape of it

```
src/lib/         everything that can be decided without a device
src/components/  the handful of pieces every screen needs
src/app/         expo-router file routes
assets/sounds/   the eight notification sounds
```

The split is deliberate. `src/lib` holds no React and imports `react-native`
only where it must (`direction.ts`), so it can be tested in the repository's
existing Vitest setup. Anything that would need a renderer lives in
`src/components` or `src/app` and is checked by the compiler rather than by a
test.

## The three routes an event takes in

A single fill can reach this app three ways: a WebSocket frame while the app is
open, a push received in the foreground, and a push the trader taps from the
lock screen. All three carry the same `eventId`, all three go through
`TradingEventHandler`, and the first one wins.

`SeenEvents` is a bounded, insertion-ordered set of the last 500 event ids. It
is bounded because an unbounded one is a leak in the session of every trader who
leaves the app open all day, and it counts rather than using a timestamp cutoff
because a device with a drifted clock would either forget everything or remember
nothing.

## Why the app makes no sound in the background

Because the operating system already did, from the push payload. An app that
also played one on waking would make a trader with the app behind their browser
hear every fill twice — and that looks exactly like a duplicate-event failure
when it is not one.

Three things enforce it, in three places, and all three are needed:

- `setNotificationHandler` returns `shouldPlaySound: false`, so the OS does not
  sound a notification that arrives while the app is open;
- `decideSound` returns nothing when the app is not active;
- a tapped notification is treated as inactive, because the OS sounded it when
  it arrived.

## Android channels

Created at startup, before any token is registered, one per sound. From Android
8 a notification naming a channel the app has not created is delivered
**silently** — no sound, no heads-up, no complaint — which is the quietest
possible failure for a margin call. A channel's sound cannot be changed after
creation, which is why there is a channel per sound rather than a sound per
message.

## The push token

`getDevicePushTokenAsync()`, not `getExpoPushTokenAsync()`. This platform sends
through its own FCM and APNs credentials rather than Expo's push service, and
the two functions return different things: an FCM registration token on Android
and a raw APNs token on iOS. That difference is why the server routes by
platform — see [notifications.md](notifications.md).

Permission refused returns `null` rather than throwing. A trader who declines
notifications must still be able to trade.

## The session

Tokens live in `expo-secure-store` — the iOS Keychain and Android's
EncryptedSharedPreferences — with `AFTER_FIRST_UNLOCK`, which is the weakest
setting that still lets a background push read the token to fetch what it refers
to. Never `AsyncStorage`, which is a plaintext file readable by anything with
access to the app's sandbox, including a backup of it.

`TokenStore.current()` refreshes 30 seconds before expiry and deduplicates
concurrent refreshes. The second part matters more than it looks: refresh tokens
rotate, so five screens mounting at once without the in-flight guard means four
of them present a token the server has already invalidated — which reads as
replay and signs the trader out during the moment they most wanted to be signed
in. There is a test for exactly that.

## The sounds

Generated by `scripts/generate-sounds.py`, committed as files rather than
synthesised at build time. They are placeholders in quality, not in function:
each is a different interval, envelope and direction, so an opening is
distinguishable from a stop loss without looking. Replace them with recorded
assets when there is a designer; the contract they satisfy is in
[sounds.md](sounds.md).

## Prices come from the socket, not a poll

The repository has a lint rule that forbids `setInterval` — "polling is not a
substitute for the realtime architecture" — and it is right. A refetch every two
seconds costs the same whether or not anything moved, and arrives late by up to
the interval on the one tick that mattered.

`RealtimeClient` connects with the access token, subscribes to quotes, orders,
positions, account and P&L, and re-snapshots after every reconnect: whatever
happened while disconnected was never delivered, and a client that carries on
from stale state shows a P&L that is quietly wrong and stays wrong.

`seq` and `eventId` are two different checks and both are needed. `seq` counts
every frame the server _sent_, duplicates included, so it is noted **before** the
duplicate check — discarding a duplicate first would manufacture a gap and force
a pointless re-snapshot. The `eventId` memory is the same `SeenEvents` the push
path uses, so a fill arriving by both routes is handled once between them rather
than once each.

## The order ticket

Nothing on it is computed on the device. `POST /orders/preview` runs the same
`requiredMargin`, `notionalValue` and `commissionForLeg` the order itself will
run, so the estimate a trader sizes from is the figure they will be charged. The
alternative — reimplementing money arithmetic in JavaScript floats on three
clients — drifts from the engine and from itself.

The preview's risk answer is explicitly an estimate. It runs outside the account
lock, because a preview that held one would serialise every keystroke in every
order ticket against real order flow. The real decision is still made under the
lock inside the transaction, so two tickets that both preview as fine can still
not both fill. That is correct rather than a defect, and the field is named
`wouldBeAccepted` for that reason.

Two presses, always. Review, then place — §43, and placing a trade is the most
dangerous thing in the app. The confirmation shows the **snapped** volume and
the crossed price, because those are what will actually happen and they are not
always what was typed.

## Guessing an API shape is how a screen lies

Half the screens were written against field names I assumed. Checking them
against the services found five that did not exist:

| Screen assumed                    | Server actually returns                     |
| --------------------------------- | ------------------------------------------- |
| `position.unrealisedPnl`          | nothing — the list had no mark at all       |
| `trade.openedAt` / `closedAt`     | `entryTime` / `exitTime`                    |
| `instrument.displayName`          | `description`                               |
| `account.equity`, `freeMargin`, … | a different endpoint, `/accounts/:id/state` |

None would have failed to compile — they would have rendered `undefined`,
`NaN`, or `Invalid Date` on a screen that has never been opened. On a positions
list that is a trader looking at a blank where their profit should be.

The first one was not a client mistake. `GET /positions` genuinely had no
floating P&L, so the server was changed rather than the screen: the mark now
comes from `AccountStateService.valuate`, the same source the risk engine and
the account screen already use. Computing it on the device would have been money
arithmetic in floating point on three platforms.

A missing mark is `null` and renders as an em-dash, never `0`. A trader cannot
tell a genuine flat from a missing price, and one of those is a reason to act.

## The chart

`lightweight-charts` in a WebView, fed through `@tp/chart-core` — the same
renderer and the same datafeed boundary as the web terminal. See
[charting.md](charting.md) for why, and for what `scriptSafeJson` is protecting
against.

## Three states, two boxes

`protective-levels.ts` is a whole tested module for what looks like form
plumbing, because the API distinguishes three states a text input cannot:
`null` clears a level, omitting the field leaves it unchanged, a value sets it.

Collapse that wrongly and a trader is either protected when they believe they
are not, or unprotected when they believe they are — and neither is visible on
the screen afterwards.

A resting order needs _both_ rules at once. Price and volume are not nullable —
an order without a price is not an order — so an empty box there means "leave it
alone", and sending nothing for it lets the trader's other changes land instead
of the whole patch being refused over one blank field. Stop loss and take profit
keep the clearing semantics. Two different rules on one form is exactly what
gets written by hand twice and then quietly diverges.

## What the profile screen deliberately does not show

KYC. §17 wants verification states there, and there is no KYC anywhere in this
platform — no model, no endpoint, no provider. A "Verification: pending" row
would be a screen inventing a status for a process that does not exist, which is
worse than the gap it hides.

Two-factor _enrolment_ is also absent, for a different reason: it displays a
shared secret once and never again, and a screen that can show a secret is a
screen that can be shoulder-surfed. It belongs on the web terminal, where it can
be printed. The screen shows the status, warns when an enrolment was started and
never finished, and warns when no recovery codes remain.

## What is not built yet

KYC (which needs Phase 6 on the server first) and support. Phase 13 of
`IMPLEMENTATION_PLAN.md` is otherwise done: account, market, the chart,
positions with closing and SL/TP editing, the order ticket, resting orders with
modification and cancellation, trade history, profile with sessions and devices,
the notification centre and settings all exist and read real endpoints.
