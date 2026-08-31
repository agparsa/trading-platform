# Mobile Audit

**Audited:** commit `76fd42a`.

---

## 1. Finding

**There is no mobile application. Not a partial one, not a scaffold — none.**

Checked by name across the whole repository:

| Marker                                         | Result |
| ---------------------------------------------- | ------ |
| `app.json` / `app.config.ts` (Expo)            | absent |
| `*.xcodeproj` / `*.xcworkspace` / `Podfile`    | absent |
| `build.gradle` / `AndroidManifest.xml`         | absent |
| `metro.config.js`                              | absent |
| `react-native` or `expo` in any `package.json` | absent |
| `apps/mobile` or any equivalent workspace      | absent |
| `PushDevice` model, FCM key, APNs certificate  | absent |

`pnpm-workspace.yaml` declares `apps/*` and `packages/*`; `apps/` contains
exactly `api`, `web`, `worker`.

This document therefore audits **readiness for** mobile rather than a mobile
application, because there is nothing else to audit. Saying so directly is more
useful than a document that describes gaps in something that does not exist.

## 2. What mobile can reuse today, unchanged

This is the good news, and it is substantial. The backend was built without a
browser assumption anywhere in it.

| Asset                               | Reusable?                | Why                                                        |
| ----------------------------------- | ------------------------ | ---------------------------------------------------------- |
| All 84 HTTP routes                  | **Yes, as-is**           | Token auth, JSON, no browser assumption                    |
| WebSocket gateway and envelope      | **Yes, as-is**           | Same token, same rooms, same `eventId`/`seq`               |
| `@tp/shared-types`                  | **Yes**                  | Framework-free; the wire contract compiles on React Native |
| `@tp/financial-core`                | **Yes**                  | `decimal.js` runs anywhere                                 |
| `@tp/trading-core`, `@tp/risk-core` | **Yes**                  | No DOM, no Node built-ins                                  |
| `@tp/api-client`                    | **Yes**, with one change | Refresh currently rides an httpOnly cookie                 |
| `@tp/ui`                            | **No**                   | React DOM components                                       |
| Chart panel                         | **No**                   | `lightweight-charts` is a DOM library                      |

A large share of the client-side work is therefore already done — the domain
packages are framework-free and the API has no browser-shaped edges, so business
logic, wire types and money arithmetic all cross unchanged. What remains is
navigation, presentation and platform integration, which is real work but not
re-derivation. That is a direct dividend of the architectural rule in
`TRADING_AUDIT.md` §1. (Stated as a judgement, not a measurement — no percentage
here would be more than a guess.)

## 3. The one real backend blocker: refresh tokens

The web client keeps its refresh token in an httpOnly, secure, sameSite cookie —
correct for a browser, where it defends against XSS reading the token.

A native app has no cookie jar in that sense and no XSS threat model. It needs
the refresh token in the response body, stored in the platform keychain
(iOS Keychain / Android Keystore).

**The wrong fix is to move the web client to body-delivered tokens** to make one
code path. That would trade a real browser protection for tidiness.

**The right fix** is for the token endpoint to deliver by client type:
`Set-Cookie` for the web client, response body for a native client, with the
client declaring itself and the server deciding — never the client asking for
whichever it prefers. Rotation, reuse detection and revocation are unchanged;
only the carrier differs. Roughly a day of work, plus tests that assert the web
path still refuses a body-delivered token.

## 4. Everything else mobile needs, none of which exists

| Requirement                   | State   | Note                                                                  |
| ----------------------------- | ------- | --------------------------------------------------------------------- |
| `PushDevice` model            | missing | token, platform, app version, last seen                               |
| FCM integration               | missing | needs a service account, kept out of git                              |
| APNs integration              | missing | needs a key, an Apple developer account                               |
| Push dispatch in the worker   | missing | the `NotificationChannel` enum has `IN_APP`, `EMAIL` only             |
| `NotificationPreference`      | missing | per-user, per-channel, per-kind                                       |
| Trading sounds                | missing | eight named events; see `TRADING_AUDIT.md` T-4                        |
| Biometric unlock              | missing | client-side; must gate a _local_ session, never replace server auth   |
| Offline / reconnect behaviour | partial | the envelope's `eventId` + `seq` already make correct replay possible |
| App store presence            | missing | accounts, review, and their timelines                                 |

## 5. Recommended approach

**React Native with Expo**, as the specification prefers, and one codebase for
both platforms. The justification here is specific rather than fashionable: the
domain packages are already TypeScript with no platform dependencies, so they
compile into a React Native bundle unchanged. A native-per-platform approach
would mean reimplementing margin and P&L arithmetic twice more, in two more
languages, and that is exactly the duplication the package boundary exists to
prevent — three implementations of a margin formula is three chances to disagree
about somebody's money.

Structure it as `apps/mobile` inside the existing workspace so it consumes
`@tp/shared-types` and `@tp/financial-core` by workspace reference rather than by
copy.

## 6. The rule that must not be bent

The specification says it and it is worth repeating in the document a mobile
engineer will actually read:

> **Never allow mobile clients to bypass the Risk Engine.**

Today this holds by construction: there is one `/orders` route, the guard chain
runs before it, and the risk engine runs inside it. The gateway does not know
what kind of client is calling and must never learn.

The way this rule gets broken is never deliberate. It gets broken by a
"lightweight mobile endpoint" added for latency, or a batch route added for a
slow network, that skips a check the main path performs. **If mobile needs a
different route, it gets a different transport to the same service — never a
different service.**

## 7. Honest estimate

A production mobile app — trading terminal, charts, positions, orders, account,
push, biometrics, two app-store submissions — is **not** a phase of a larger
piece of work. It is its own project, on the order of two to three months for
one competent mobile engineer, after the backend changes in §3 and §4 are done.

It is sequenced late in `IMPLEMENTATION_PLAN.md` for that reason, and because
building it before tenancy exists would mean building it twice.
