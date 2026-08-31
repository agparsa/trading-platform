# Trading sounds

## Why the server decides

A sound is a client concern — the client is what makes noise. But _which_ sound,
and _whether_ to make one, are decided here, and the reason is the specification
itself: §18 requires that modifying a trade sounds different from opening one,
and a rule like that held independently by an Android app, an iOS app and a web
terminal is a rule that will be held three different ways within a year.

So the mapping lives in `@tp/shared-types` and travels on every notification. A
client that lacks an asset falls back to its default rather than playing the
wrong one.

## The sounds

| Identifier        | Raised by                                     |
| ----------------- | --------------------------------------------- |
| `trade_opened`    | `TRADE_OPENED`                                |
| `trade_closed`    | `TRADE_CLOSED`, including a partial close     |
| `trade_modified`  | `TRADE_MODIFIED` — SL, TP, or a pending order |
| `order_filled`    | `ORDER_FILLED`                                |
| `order_cancelled` | `ORDER_CANCELLED`                             |
| `stop_loss`       | `STOP_LOSS`                                   |
| `take_profit`     | `TAKE_PROFIT`                                 |
| `risk_warning`    | `RISK_ALERT` and `SECURITY_ALERT`             |

`SYSTEM` maps to no sound. Not every notice deserves a noise, and a platform
that beeps for everything is one whose users turn the sound off entirely — which
costs them the two or three notices that were worth hearing.

## The same name, three spellings

Each platform resolves a sound differently, and the mapping is in
`packages/push-core/src/message.ts`:

| Platform | Where it looks               | Form                        |
| -------- | ---------------------------- | --------------------------- |
| Android  | `android.notification.sound` | resource name, no extension |
| iOS      | `apns.payload.aps.sound`     | file name, `.caf`           |
| Any      | `data.sound`                 | the bare identifier         |

`data.sound` is there for the foreground case, where the app is open and plays
the sound itself rather than letting the OS do it.

Omitting any one of the three produces a notification that is silent on exactly
one platform — the kind of bug that ships because the developer tested on the
other two. There is a test for it.

## Interruption level

`aps.interruption-level` is `time-sensitive` only for a `CRITICAL` notice, and
`active` otherwise. Time-sensitive asks iOS to break through Focus modes;
requesting it for every fill is how an app loses the permission for the notices
that actually need it.

Android gets `priority: HIGH` throughout, because everything this platform sends
is time-critical by nature. A margin call delivered "when convenient" is a
margin call read after liquidation.

## The Android channel

`PUSH_ANDROID_CHANNEL_ID`, default `trading`. Channels are declared by the app,
and a message naming a channel the app has not created is delivered **silently**
on Android 8 and later — the quietest possible failure for a margin call. The
mobile app must declare this channel with the sound bundled.

## Turning them off

`soundEnabled` is a master switch and each category has its own. When the sound
is off the push carries no sound field at all, and Android is told
`default_sound: false` explicitly — leaving it out lets the channel's own
default play, which is not what the user asked for.

Volume is stored (`soundVolume`, 0–100) and served to clients, which apply it
themselves. Push notification sounds are played by the OS at the system volume;
the setting governs the in-app player, which is the case a person is actually
adjusting when they change it.

## What does not exist yet

The audio assets, and the clients that play them. The contract above is
complete, tested and served; `apps/mobile` does not exist. Recorded here rather
than implied, because a document describing a feature the repository does not
have is worse for a reader than one that says which half is missing.
