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

## What is not built yet

The market screen, the chart, the order ticket, position modification and
closing, order management, trade history, KYC and profile, and support. Phase 13
of `IMPLEMENTATION_PLAN.md`. The account, positions, notification centre and
settings screens exist and read real data from real endpoints.
