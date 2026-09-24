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
| `price_alert`     | `PRICE_ALERT`                                 |

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

## The Android channels

From Android 8 a notification's sound is its **channel's** sound. The `sound`
field in the message, and `default_sound: false`, are read only by Android 7 and
older. So the channel a push names is the sound it makes, and naming the wrong
one is not a cosmetic fault.

It was the wrong one for every notice. The worker posted every push to one
configured channel, `PUSH_ANDROID_CHANNEL_ID`, default `trading` — whose sound
is `trade_opened`. On a current phone with the app in the background, a stop
loss, a take profit and a margin call all sounded like an opened trade, and a
trader who had turned a category's sound off heard it anyway, because the
channel still had a sound. The phone had created a channel per sound all along;
nothing was ever sent to the others.

`ANDROID_CHANNEL_FOR_CATEGORY` in `@tp/shared-types` is now the one table: the
app creates a channel per category from it, carrying that category's sound, plus
a soundless `quiet` channel; the worker names the category's channel on every
push, or `quiet` when the person has that category's sound off. The setting is
gone. A channel's sound cannot be changed once the app has created it, so the
ids of the channels phones already have are pinned by a test.

A message naming a channel the app has not created is delivered **silently** on
Android 8 and later — the quietest possible failure for a margin call — so a
test also holds every channel the worker can name to one the app creates.

## Turning them off

`soundEnabled` is a master switch and each category has its own. When the sound
is off the push carries no sound field at all, and Android is told
`default_sound: false` explicitly — leaving it out lets the channel's own
default play, which is not what the user asked for.

Volume is stored (`soundVolume`, 0–100) and served to clients, which apply it
themselves. Push notification sounds are played by the OS at the system volume;
the setting governs the in-app player, which is the case a person is actually
adjusting when they change it.

## Where the sounds are played

On the phone (`apps/mobile`): by the operating system for a notice that arrives
in the background, through the channel above; and by the app itself in the
foreground, after deduplicating, at the trader's volume. The files are generated
placeholders — distinct in interval and direction, so an opening is not a stop
loss, but not recorded by anyone; see [mobile.md](mobile.md).

This section used to say `apps/mobile` did not exist. It has for months.

`bundled-sounds.test.ts` holds every `TradingSound` to a file, to the list
`app.json` bundles for the operating system, and to the list the Android build
checks for. `price_alert` was in none of the last two: it was added to the
contract, generated, and given to the in-app player, and a price alert arriving
in the background named a sound the build did not contain — while the build's
check, which listed eight names by hand, passed.

The web terminal plays no sounds. It shows a notice; it does not make a noise.
