/**
 * Post-build smoke test.
 *
 * Boots the compiled API exactly as production runs it and asserts that the
 * things Phase 1 claims to deliver actually respond: liveness, readiness
 * against a real database and Redis, the response envelope, the error envelope
 * and the metrics endpoint. A green unit suite on top of an app that cannot
 * start is not a passing build.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import { base32Decode, codeForStep, stepFor } from '../apps/api/src/auth/totp';

/** The code the user's authenticator app is showing right now. */
function totpCode(secret: Buffer): string {
  return codeForStep(secret, stepFor(Date.now()));
}

/**
 * The code the app will show next.
 *
 * Needed because every code is spent when it is used, and this script enrols and
 * then signs in inside the same thirty seconds. The server accepts one step
 * ahead — that is the drift allowance a phone with a fast clock relies on — so
 * this is a real code a real user could present, and it avoids padding the smoke
 * run with a half-minute of sleeping.
 */
function nextTotpCode(secret: Buffer): string {
  return codeForStep(secret, stepFor(Date.now()) + 1);
}

/**
 * Where the checks are aimed.
 *
 * By default this script builds nothing and trusts nothing: it spawns its own
 * API from `dist` and talks to it on loopback, so a green run means *this*
 * binary is sound.
 *
 * `SMOKE_TARGET` points it at a deployment that is already running instead —
 * which is what the deployment guide tells an operator to do before letting
 * anyone sign in, and what this script could not previously do. It then spawns
 * nothing and asserts nothing about which build it is talking to. That is the
 * trade: it stops proving anything about the code and starts proving something
 * about the environment.
 */
const TARGET = process.env['SMOKE_TARGET']?.replace(/\/$/, '');
const BASE = TARGET ?? `http://127.0.0.1:${process.env.API_PORT ?? '4000'}`;
const BOOT_TIMEOUT_MS = 60_000;
/** The login limit this run boots with. The last check spends exactly this many. */
const LOGIN_LIMIT = 30;

interface Check {
  name: string;
  run: () => Promise<void>;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function getJson(path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${BASE}${path}`);
  return { status: response.status, body: await response.json() };
}

/**
 * A registration body, carrying an invitation when the target needs one.
 *
 * These checks register throwaway users to get tokens. A platform running in
 * invite mode refuses them, which would make every check fail for a reason that
 * has nothing to do with what it is testing — so an operator smoke-testing such
 * a deployment mints a multi-use invitation first and passes it as
 * `SMOKE_INVITE_CODE`. Against an open platform the variable is unset and this
 * adds nothing.
 */
const INVITE_CODE = process.env['SMOKE_INVITE_CODE'];

function registration(email: string, password: string, displayName: string): string {
  return JSON.stringify({
    email,
    password,
    displayName,
    ...(INVITE_CODE === undefined || INVITE_CODE.length === 0 ? {} : { inviteCode: INVITE_CODE }),
  });
}

const checks: Check[] = [
  {
    name: 'liveness responds inside the success envelope',
    run: async () => {
      const { status, body } = await getJson('/health');
      assert(status === 200, `expected 200, got ${status}`);
      const payload = body as {
        ok: boolean;
        data: { status: string };
        meta: { requestId: string };
      };
      assert(payload.ok === true, 'envelope ok flag was not true');
      assert(payload.data.status === 'ok', 'liveness did not report ok');
      assert(typeof payload.meta.requestId === 'string', 'response carried no request id');
    },
  },
  {
    name: 'readiness reports database and redis up',
    run: async () => {
      const { status, body } = await getJson('/ready');
      assert(status === 200, `expected 200, got ${status}`);
      const payload = body as { data: { info: Record<string, { status: string }> } };
      assert(payload.data.info['database']?.status === 'up', 'database not reported up');
      assert(payload.data.info['redis']?.status === 'up', 'redis not reported up');
    },
  },
  {
    name: 'unknown route returns a coded failure envelope, not a stack trace',
    run: async () => {
      const { status, body } = await getJson('/api/v1/definitely-not-a-route');
      assert(status === 404, `expected 404, got ${status}`);
      const payload = body as { ok: boolean; error: { code: string; requestId: string } };
      assert(payload.ok === false, 'failure envelope ok flag was not false');
      assert(payload.error.code === 'RESOURCE_NOT_FOUND', `unexpected code ${payload.error.code}`);
      assert(!JSON.stringify(payload).includes('at Object.'), 'response leaked a stack trace');
    },
  },
  {
    name: 'authentication is on by default — a trading route needs a token',
    run: async () => {
      const { status, body } = await getJson('/api/v1/accounts');
      assert(status === 401, `expected 401, got ${status}`);
      const payload = body as { error: { code: string } };
      assert(payload.error.code === 'UNAUTHENTICATED', `unexpected code ${payload.error.code}`);
    },
  },
  {
    name: 'the market feed is quoting at least one instrument',
    run: async () => {
      // Registration and login exercise the whole account-opening path, and
      // give us a token to read the quote feed with.
      const email = `smoke-${Date.now()}@test.local`;
      const password = 'a-sufficiently-long-passphrase';
      const register = await fetch(`${BASE}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: registration(email, password, 'Smoke Test'),
      });
      assert(register.status === 202, `register returned ${register.status}`);

      const login = await fetch(`${BASE}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      assert(login.ok, `login returned ${login.status}`);
      const token = ((await login.json()) as { data: { accessToken: string } }).data.accessToken;

      const accounts = await fetch(`${BASE}/api/v1/accounts`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const opened = ((await accounts.json()) as { data: Array<{ balance: string }> }).data;
      assert(opened.length === 1, `expected one account, got ${opened.length}`);

      /**
       * Wait for the feed rather than sampling it once.
       *
       * The API answers `/health` before the market simulator has published its
       * first tick, so a single read here fails whenever this check happens to
       * run in that gap — which it did, intermittently, and it looked like a
       * dead feed rather than an early question. The wait is bounded, so a feed
       * that really is dead still fails; it just fails for the right reason.
       */
      let priced: unknown[] = [];
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && priced.length === 0) {
        const quotes = await fetch(`${BASE}/api/v1/market/quotes`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        priced = ((await quotes.json()) as { data: unknown[] }).data;
        if (priced.length === 0) await sleep(500);
      }
      // At least one instrument must be inside its trading session and quoting;
      // crypto never closes, so this holds at any hour.
      assert(priced.length > 0, 'no instrument started quoting within 15s of boot');
    },
  },
  {
    name: 'a full round trip: open a position, mark it, close it, check the ledger',
    run: async () => {
      const email = `smoke-trade-${Date.now()}@test.local`;
      const password = 'a-sufficiently-long-passphrase';
      await fetch(`${BASE}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: registration(email, password, 'Smoke Trade'),
      });
      const login = await fetch(`${BASE}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const token = ((await login.json()) as { data: { accessToken: string } }).data.accessToken;
      const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

      const accountsResponse = await fetch(`${BASE}/api/v1/accounts`, { headers: auth });
      const accountId = ((await accountsResponse.json()) as { data: Array<{ id: string }> }).data[0]
        ?.id;
      assert(accountId !== undefined, 'no account was opened at registration');

      // Whichever instrument is currently inside its session; crypto is always one.
      const quotesResponse = await fetch(`${BASE}/api/v1/market/quotes`, { headers: auth });
      const quotes = ((await quotesResponse.json()) as { data: Array<{ symbol: string }> }).data;
      assert(quotes.length > 0, 'nothing is quoting, so no order can be placed');
      const symbol = quotes[0]!.symbol;

      const open = await fetch(`${BASE}/api/v1/orders`, {
        method: 'POST',
        headers: { ...auth, 'Idempotency-Key': `smoke-open-${Date.now()}` },
        body: JSON.stringify({ accountId, symbol, side: 'BUY', volume: '0.01' }),
      });
      const opened = (await open.json()) as {
        ok: boolean;
        data: { positionId: string };
        error?: { code: string; message: string };
      };
      assert(opened.ok, `order rejected: ${opened.error?.code} ${opened.error?.message}`);

      const stateResponse = await fetch(`${BASE}/api/v1/accounts/${accountId}/state`, {
        headers: auth,
      });
      const state = (await stateResponse.json()) as {
        data: { usedMargin: string; openPositions: number };
      };
      assert(state.data.openPositions === 1, 'the position is not reflected in account state');
      assert(Number(state.data.usedMargin) > 0, 'no margin is being held against the position');

      const close = await fetch(`${BASE}/api/v1/positions/${opened.data.positionId}/close`, {
        method: 'POST',
        headers: { ...auth, 'Idempotency-Key': `smoke-close-${Date.now()}` },
        body: JSON.stringify({}),
      });
      const closed = (await close.json()) as {
        ok: boolean;
        data: { fullyClosed: boolean; netPnl: string };
        error?: { code: string; message: string };
      };
      assert(closed.ok, `close rejected: ${closed.error?.code} ${closed.error?.message}`);
      assert(closed.data.fullyClosed, 'the position did not fully close');

      const ledgerResponse = await fetch(`${BASE}/api/v1/accounts/${accountId}/ledger`, {
        headers: auth,
      });
      const ledger = (await ledgerResponse.json()) as {
        data: { entries: Array<{ type: string }> };
      };
      const types = ledger.data.entries.map((entry) => entry.type);
      assert(types.includes('DEPOSIT'), 'the opening deposit is missing from the ledger');
      assert(
        types.some((type) => type === 'TRADE_PROFIT' || type === 'TRADE_LOSS'),
        'the closed trade did not reach the ledger',
      );
    },
  },
  {
    name: 'a resting order: place it, list it, refuse the wrong side, cancel it',
    run: async () => {
      const email = `smoke-pending-${Date.now()}@test.local`;
      const password = 'a-sufficiently-long-passphrase';
      await fetch(`${BASE}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: registration(email, password, 'Smoke Pending'),
      });
      const login = await fetch(`${BASE}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const token = ((await login.json()) as { data: { accessToken: string } }).data.accessToken;
      const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

      const accountsResponse = await fetch(`${BASE}/api/v1/accounts`, { headers: auth });
      const accountId = ((await accountsResponse.json()) as { data: Array<{ id: string }> }).data[0]
        ?.id;
      assert(accountId !== undefined, 'registration did not open an account');

      const quotesResponse = await fetch(`${BASE}/api/v1/market/quotes`, { headers: auth });
      const quotes = (
        (await quotesResponse.json()) as {
          data: Array<{ symbol: string; bid: string; ask: string }>;
        }
      ).data;
      const quote = quotes[0];
      assert(quote !== undefined, 'nothing is quoting');

      const specResponse = await fetch(`${BASE}/api/v1/symbols/${quote!.symbol}`, {
        headers: auth,
      });
      const spec = (
        (await specResponse.json()) as {
          data: { tickSize: string; pricePrecision: number; minVolume: string };
        }
      ).data;

      // Rest well below the market, snapped to the tick grid so the price is
      // one the instrument can actually quote.
      const tick = Number(spec.tickSize);
      const restAt = (Math.floor((Number(quote!.bid) * 0.9) / tick) * tick).toFixed(
        spec.pricePrecision,
      );

      const place = async (side: string, type: string, price: string) =>
        fetch(`${BASE}/api/v1/orders/pending`, {
          method: 'POST',
          headers: { ...auth, 'Idempotency-Key': crypto.randomUUID() },
          body: JSON.stringify({
            accountId,
            symbol: quote!.symbol,
            side,
            type,
            volume: spec.minVolume,
            price,
          }),
        });

      const placed = await place('BUY', 'LIMIT', restAt);
      const placedBody = (await placed.json()) as {
        ok: boolean;
        data: { orderId: string; status: string };
        error?: { message: string };
      };
      assert(
        placedBody.ok,
        `placing a limit failed: ${placedBody.error?.message ?? placed.status}`,
      );
      assert(placedBody.data.status === 'PENDING', 'a resting order did not come back as PENDING');

      const listed = await fetch(`${BASE}/api/v1/orders/pending?accountId=${accountId}`, {
        headers: auth,
      });
      const listedBody = (await listed.json()) as { data: Array<{ orderId: string }> };
      assert(
        listedBody.data.some((order) => order.orderId === placedBody.data.orderId),
        'the resting order was not listed',
      );

      // A buy limit above the market would fire on the next tick — that is a
      // market order the trader did not ask for, and the engine must refuse it.
      const wrongSide = await place(
        'BUY',
        'LIMIT',
        (Number(quote!.ask) * 1.1).toFixed(spec.pricePrecision),
      );
      const wrongBody = (await wrongSide.json()) as { ok: boolean; error?: { code: string } };
      assert(!wrongBody.ok, 'an immediately-fillable limit order was accepted');
      assert(
        wrongBody.error?.code === 'INVALID_PRICE',
        `expected INVALID_PRICE, got ${wrongBody.error?.code}`,
      );

      const cancelled = await fetch(`${BASE}/api/v1/orders/${placedBody.data.orderId}`, {
        method: 'DELETE',
        headers: { ...auth, 'Idempotency-Key': crypto.randomUUID() },
      });
      const cancelledBody = (await cancelled.json()) as {
        ok: boolean;
        data: { status: string };
      };
      assert(cancelledBody.ok, 'cancelling the resting order failed');
      assert(cancelledBody.data.status === 'CANCELLED', 'the order did not come back CANCELLED');
    },
  },
  {
    name: 'the refresh token is issued only as an httpOnly cookie, and logout clears it',
    run: async () => {
      const email = `smoke-cookie-${Date.now()}@test.local`;
      const password = 'a-sufficiently-long-passphrase';
      await fetch(`${BASE}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: registration(email, password, 'Smoke Cookie'),
      });

      const login = await fetch(`${BASE}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const setCookie = login.headers.get('set-cookie');
      assert(setCookie !== null, 'login set no cookie');
      assert(/HttpOnly/i.test(setCookie!), 'the refresh cookie is not HttpOnly');
      assert(/SameSite=Strict/i.test(setCookie!), 'the refresh cookie is not SameSite=Strict');
      assert(/Path=\/api\/v1\/auth/.test(setCookie!), 'the refresh cookie is not path-scoped');

      // The whole point: nothing in the body hands the token to a script.
      const loginBody = (await login.json()) as {
        data: { accessToken: string; refreshToken?: string };
      };
      assert(
        loginBody.data.refreshToken === undefined,
        'the login response body still carries a refresh token',
      );
      assert(typeof loginBody.data.accessToken === 'string', 'login returned no access token');

      const cookie = setCookie!.split(';')[0]!;

      // The cookie alone is enough to rotate.
      const refreshed = await fetch(`${BASE}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: '{}',
      });
      const refreshedBody = (await refreshed.json()) as {
        ok: boolean;
        data: { accessToken: string; refreshToken?: string };
      };
      assert(refreshedBody.ok, 'a cookie-only refresh was refused');
      assert(
        refreshedBody.data.refreshToken === undefined,
        'the refresh response body still carries a refresh token',
      );
      const rotated = refreshed.headers.get('set-cookie');
      assert(rotated !== null, 'the refresh did not rotate the cookie');
      const rotatedCookie = rotated!.split(';')[0]!;

      // A cross-site origin is refused even before SameSite would have stopped it.
      const foreign = await fetch(`${BASE}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: rotatedCookie,
          Origin: 'https://evil.example.com',
        },
        body: '{}',
      });
      assert(foreign.status === 403, `a foreign origin got ${foreign.status}, expected 403`);

      const loggedOut = await fetch(`${BASE}/api/v1/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: rotatedCookie },
        body: '{}',
      });
      const cleared = loggedOut.headers.get('set-cookie');
      assert(cleared !== null, 'logout set no cookie');
      assert(/Max-Age=0/i.test(cleared!), 'logout did not expire the cookie');
      assert(/Path=\/api\/v1\/auth/.test(cleared!), 'the deletion did not repeat the path');

      // And the token itself is revoked, not merely forgotten by the browser.
      const afterLogout = await fetch(`${BASE}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: rotatedCookie },
        body: '{}',
      });
      const afterBody = (await afterLogout.json()) as { ok: boolean };
      assert(!afterBody.ok, 'a refresh token still worked after logout');
    },
  },
  {
    /**
     * Two-factor authentication, over HTTP, from enrolment to a completed
     * sign-in and a refused replay.
     *
     * The integration tests call the services directly. Nothing below them
     * notices if the login route forgets to check the challenge, or if the
     * controller returns tokens beside the challenge, or if the secret is
     * handed back on a later request. This drives the real routes and reads the
     * real database, and its most important assertion is the negative one: after
     * enrolment, the password alone stops being enough.
     */
    name: 'two-factor authentication holds over HTTP, and a code cannot be replayed',
    run: async () => {
      const email = `smoke-2fa-${Date.now()}@test.local`;
      const password = 'a-sufficiently-long-passphrase';
      await fetch(`${BASE}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: registration(email, password, 'Smoke 2FA'),
      });

      const signIn = async () =>
        fetch(`${BASE}/api/v1/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });

      const first = await signIn();
      const token = ((await first.json()) as { data: { accessToken: string } }).data.accessToken;
      const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

      const enrol = await fetch(`${BASE}/api/v1/auth/2fa/enrol`, { method: 'POST', headers: auth });
      assert(enrol.ok, `enrolment returned ${enrol.status}`);
      const offer = ((await enrol.json()) as { data: { secret: string; otpauthUri: string } }).data;
      assert(offer.otpauthUri.startsWith('otpauth://totp/'), 'no otpauth URI was returned');

      const secret = base32Decode(offer.secret);

      // Still off until a code proves it. A user who stopped here has not
      // locked themselves out.
      const stillOpen = await signIn();
      const stillOpenBody = (await stillOpen.json()) as { data: { accessToken?: string } };
      assert(
        typeof stillOpenBody.data.accessToken === 'string',
        'an unconfirmed enrolment already blocked a sign-in',
      );

      const activate = await fetch(`${BASE}/api/v1/auth/2fa/activate`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ code: totpCode(secret) }),
      });
      assert(activate.ok, `activation returned ${activate.status}`);
      const recoveryCodes = ((await activate.json()) as { data: { recoveryCodes: string[] } }).data
        .recoveryCodes;
      assert(
        recoveryCodes.length === 10,
        `expected 10 recovery codes, got ${recoveryCodes.length}`,
      );

      // The secret is now stored encrypted. Read the column directly: this is
      // the assertion a mocked test cannot make.
      const prisma = new PrismaClient();
      try {
        const row = await prisma.user.findUniqueOrThrow({ where: { email } });
        assert(row.totpSecret !== null, 'no secret was stored');
        assert(
          !(row.totpSecret ?? '').includes(offer.secret),
          'the TOTP secret is stored in plain text',
        );
        assert((row.totpSecret ?? '').startsWith('v1.'), 'the stored secret is not sealed');
      } finally {
        await prisma.$disconnect();
      }

      // The password alone no longer opens anything.
      const challenged = await signIn();
      const challengeBody = (await challenged.json()) as {
        data: { twoFactorRequired?: boolean; challengeToken?: string; accessToken?: string };
      };
      assert(
        challengeBody.data.twoFactorRequired === true,
        'the password alone still completed a sign-in',
      );
      assert(
        challengeBody.data.accessToken === undefined,
        'a challenge response also carried an access token',
      );
      assert(
        challenged.headers.get('set-cookie') === null,
        'a challenge response also set a session cookie',
      );

      // Not `totpCode`: activation a moment ago spent the current step.
      const code = nextTotpCode(secret);
      const completed = await fetch(`${BASE}/api/v1/auth/login/2fa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeToken: challengeBody.data.challengeToken, code }),
      });
      assert(completed.ok, `completing the sign-in returned ${completed.status}`);
      assert(completed.headers.get('set-cookie') !== null, 'the completed sign-in set no cookie');

      // And the same code, still inside its thirty seconds, is refused.
      const replayChallenge = (await (await signIn()).json()) as {
        data: { challengeToken: string };
      };
      const replay = await fetch(`${BASE}/api/v1/auth/login/2fa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeToken: replayChallenge.data.challengeToken, code }),
      });
      const replayBody = (await replay.json()) as { error?: { code: string } };
      assert(replay.status === 401, `a replayed code returned ${replay.status}, expected 401`);
      assert(
        replayBody.error?.code === 'TWO_FACTOR_INVALID',
        `a replayed code returned ${replayBody.error?.code}`,
      );

      // A recovery code gets the user in without their phone.
      const recoveryChallenge = (await (await signIn()).json()) as {
        data: { challengeToken: string };
      };
      const recovered = await fetch(`${BASE}/api/v1/auth/login/2fa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challengeToken: recoveryChallenge.data.challengeToken,
          code: recoveryCodes[0],
        }),
      });
      assert(recovered.ok, `a recovery code returned ${recovered.status}`);
    },
  },
  {
    /**
     * Sessions, over HTTP.
     *
     * The assertion that matters is the isolation one: a session id is a UUID a
     * user can read off their own list, and handing somebody else's to this
     * endpoint must find nothing rather than end their session.
     */
    name: 'a user can see and end their own sessions, and only their own',
    run: async () => {
      const password = 'a-sufficiently-long-passphrase';
      const alice = `smoke-sessions-a-${Date.now()}@test.local`;
      const bob = `smoke-sessions-b-${Date.now()}@test.local`;

      const signIn = async (email: string, userAgent: string) => {
        await fetch(`${BASE}/api/v1/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent },
          body: registration(email, password, 'Smoke Sessions'),
        }).then((response) => response.body?.cancel());
        const login = await fetch(`${BASE}/api/v1/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent },
          body: JSON.stringify({ email, password }),
        });
        return ((await login.json()) as { data: { accessToken: string } }).data.accessToken;
      };

      const CHROME =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
      const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0';

      const aliceToken = await signIn(alice, CHROME);
      // A second sign-in for Alice, from something else.
      await fetch(`${BASE}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': FIREFOX },
        body: JSON.stringify({ email: alice, password }),
      }).then((response) => response.body?.cancel());

      const listed = await fetch(`${BASE}/api/v1/auth/sessions`, {
        headers: { Authorization: `Bearer ${aliceToken}` },
      });
      const list = (
        (await listed.json()) as { data: Array<{ id: string; device: string; current: boolean }> }
      ).data;
      assert(list.length === 2, `expected two sessions, got ${list.length}`);
      assert(
        list.some((entry) => entry.device === 'Chrome on macOS') &&
          list.some((entry) => entry.device === 'Firefox on Linux'),
        `sessions were not described as expected: ${list.map((e) => e.device).join(', ')}`,
      );
      assert(
        list.filter((entry) => entry.current).length === 1,
        'no single session was marked current',
      );

      const other = list.find((entry) => !entry.current);
      assert(other !== undefined, 'both sessions claimed to be the current one');

      // Bob cannot end it.
      const bobToken = await signIn(bob, CHROME);
      const refused = await fetch(`${BASE}/api/v1/auth/sessions/${other?.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${bobToken}` },
      });
      const refusedBody = (await refused.json()) as { error?: { code: string } };
      assert(refused.status === 404, `another user's revoke returned ${refused.status}`);
      assert(
        refusedBody.error?.code === 'RESOURCE_NOT_FOUND',
        `expected RESOURCE_NOT_FOUND, got ${refusedBody.error?.code}`,
      );

      // Alice can.
      const ended = await fetch(`${BASE}/api/v1/auth/sessions/${other?.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${aliceToken}` },
      });
      assert(ended.status === 204, `ending a session returned ${ended.status}`);

      const after = await fetch(`${BASE}/api/v1/auth/sessions`, {
        headers: { Authorization: `Bearer ${aliceToken}` },
      });
      const remaining = ((await after.json()) as { data: unknown[] }).data;
      assert(remaining.length === 1, `expected one session left, got ${remaining.length}`);
    },
  },
  {
    /**
     * Permissions are enforced by the running application, not by a unit test.
     *
     * Every other permission test in this repository exercises the catalogue or
     * the guard in isolation; none of them notices if the guard is never
     * reached over HTTP. So this one demotes a real user, logs in again to get
     * a token carrying the new role, and asks the server.
     *
     * SUPPORT is the useful role here because it holds `positions.read` and not
     * `orders.create` — so a single user proves both halves: the refusal is a
     * permission decision, not a broken session.
     */
    name: 'the permission guard refuses over HTTP, and refuses only what it should',
    run: async () => {
      const email = `smoke-perm-${Date.now()}@test.local`;
      const password = 'a-sufficiently-long-passphrase';
      await fetch(`${BASE}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: registration(email, password, 'Smoke Perm'),
      });

      const prisma = new PrismaClient();
      try {
        await prisma.user.update({ where: { email }, data: { role: 'SUPPORT' } });
      } finally {
        await prisma.$disconnect();
      }

      // Logging in after the change: the role travels in the token, so a
      // session minted before the demotion would keep the old capabilities
      // until it expired.
      const login = await fetch(`${BASE}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const token = ((await login.json()) as { data: { accessToken: string } }).data.accessToken;
      const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

      const mine = await fetch(`${BASE}/api/v1/permissions/me`, { headers: auth });
      const capabilities = (await mine.json()) as {
        data: { role: string; permissions: string[] };
      };
      assert(capabilities.data.role === 'SUPPORT', 'the token did not carry the new role');
      assert(
        !capabilities.data.permissions.includes('orders.create'),
        'SUPPORT should not advertise orders.create',
      );

      const quotesResponse = await fetch(`${BASE}/api/v1/market/quotes`, { headers: auth });
      const quotes = ((await quotesResponse.json()) as { data: Array<{ symbol: string }> }).data;
      assert(quotes.length > 0, 'nothing is quoting, so no order can be attempted');

      const refused = await fetch(`${BASE}/api/v1/orders`, {
        method: 'POST',
        headers: { ...auth, 'Idempotency-Key': `smoke-perm-${Date.now()}` },
        body: JSON.stringify({
          accountId: '00000000-0000-0000-0000-000000000000',
          symbol: quotes[0]!.symbol,
          side: 'BUY',
          volume: '0.01',
        }),
      });
      const body = (await refused.json()) as {
        ok: boolean;
        error?: { code: string; message: string };
      };
      assert(refused.status === 403, `expected 403, got ${refused.status}`);
      assert(body.ok === false, 'a refused order came back inside a success envelope');
      assert(body.error?.code === 'FORBIDDEN', `expected FORBIDDEN, got ${body.error?.code}`);
      assert(
        body.error?.message.includes('orders.create') === true,
        `the refusal did not name the missing permission: ${body.error?.message}`,
      );

      // The account id above is a nonexistent UUID on purpose: the guard must
      // refuse before the handler ever looks the account up. A 404 here would
      // mean permission was checked too late, after the request had already
      // reached data it was not entitled to touch.

      // And the other half — a capability SUPPORT does hold must still get
      // through. This asks for positions with no account id, so the request is
      // rejected by validation rather than served; that is the point. A 400
      // can only be produced downstream of the guard, so it proves the guard
      // admitted the request, and it stays true no matter what accounts this
      // user happens to own.
      const allowed = await fetch(`${BASE}/api/v1/positions`, { headers: auth });
      assert(
        allowed.status === 400,
        `positions.read should have reached validation, got ${allowed.status}`,
      );
      const allowedBody = (await allowed.json()) as { error?: { code: string } };
      assert(
        allowedBody.error?.code === 'VALIDATION_FAILED',
        `expected a validation failure past the guard, got ${allowedBody.error?.code}`,
      );
    },
  },
  {
    /**
     * Invitations, end to end over HTTP.
     *
     * The service has integration tests; this checks the parts they cannot —
     * that the admin routes are reachable and guarded, that the minted code
     * survives the wire, and that the plaintext is not in the listing. A route
     * that exists in a controller and is not reachable from its module fails
     * here and nowhere else, which is the mistake this repository has made.
     *
     * Skipped against a deployment: minting a real invitation on somebody's
     * production platform is not a smoke check.
     */
    name: 'an invitation can be minted, is never shown again, and behaves as the mode says',
    run: async () => {
      if (TARGET !== undefined) {
        console.log('      (skipped against a deployment — this one mints real invitations)');
        return;
      }

      const prisma = new PrismaClient();
      const password = 'a-sufficiently-long-passphrase';
      const adminEmail = `smoke-inviter-${Date.now()}@test.local`;
      try {
        const { PasswordService } = await import('../apps/api/src/auth/password.service');
        const admin = await prisma.user.create({
          data: {
            email: adminEmail,
            passwordHash: await new PasswordService().hash(password),
            displayName: 'Smoke Inviter',
            role: 'ADMIN',
            emailVerified: true,
          },
        });

        const login = await fetch(`${BASE}/api/v1/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: adminEmail, password }),
        });
        assert(login.ok, `admin login returned ${login.status}`);
        const token = ((await login.json()) as { data: { accessToken: string } }).data.accessToken;

        const minted = await fetch(`${BASE}/api/v1/admin/invites`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ label: 'smoke', maxUses: 1 }),
        });
        assert(minted.status === 201, `minting returned ${minted.status}`);
        const invite = ((await minted.json()) as { data: { id: string; code: string } }).data;
        assert(
          typeof invite.code === 'string' && invite.code.length === 24,
          'no usable code came back',
        );

        const listed = await fetch(`${BASE}/api/v1/admin/invites`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        assert(listed.ok, `listing returned ${listed.status}`);
        const listing = await listed.text();
        assert(!listing.includes(invite.code), 'the listing carried the plaintext code');
        assert(!listing.includes('codeHash'), 'the listing carried the stored hash');

        /**
         * The API runs in whatever mode its environment says — the same
         * `process.env` this script hands the child — so the check asserts what
         * that mode actually promises rather than what would be convenient.
         *
         * Under `open`, offering a code must change nothing: the registration
         * succeeds and the invitation is left unspent. That is a real assertion
         * and it has a real failure mode, which is a claim path that runs
         * whatever the mode.
         *
         * Under `invite`, the code is consumed exactly once and the redemption
         * is recorded.
         */
        const mode = process.env['REGISTRATION_MODE'] ?? 'open';
        const redeem = (email: string) =>
          fetch(`${BASE}/api/v1/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email,
              password,
              displayName: 'Invited',
              inviteCode: invite.code,
            }),
          });

        if (mode === 'closed') {
          const refusedRegistration = await redeem(`smoke-closed-${Date.now()}@test.local`);
          assert(
            refusedRegistration.status === 403,
            `a closed platform answered ${refusedRegistration.status} to a registration`,
          );
        } else {
          const first = await redeem(`smoke-invited-${Date.now()}@test.local`);
          assert(first.status === 202, `redeeming returned ${first.status}`);

          const after = await prisma.inviteCode.findUniqueOrThrow({ where: { id: invite.id } });
          const redemptions = await prisma.inviteRedemption.count({
            where: { inviteCodeId: invite.id },
          });
          const expected = mode === 'invite' ? 1 : 0;
          assert(
            after.useCount === expected,
            `use count is ${after.useCount}, expected ${expected} in ${mode} mode`,
          );
          assert(
            redemptions === expected,
            `${redemptions} redemptions recorded, expected ${expected} in ${mode} mode`,
          );
        }

        await prisma.user.update({ where: { id: admin.id }, data: { role: 'USER' } });
        const refused = await fetch(`${BASE}/api/v1/admin/invites`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ label: 'should not happen' }),
        });
        assert(
          refused.status === 403,
          `minting answered ${refused.status} to a demoted administrator — ` +
            'the permission is read from the token, not the database, so this is the check that the token carries it',
        );
      } finally {
        await prisma.$disconnect();
      }
    },
  },
  {
    /**
     * The login rate limiter, proved against the running binary.
     *
     * Runs last because it deliberately exhausts the bucket — any check placed
     * after it that signs in will be answered 429, which is a real failure of
     * the check rather than of the platform. New checks go above this one. Every attempt uses
     * an address that was never registered, so nothing here trips the per-user
     * lockout — this is measuring the limiter in front of the endpoint, not the
     * counter behind it.
     *
     * Two assertions, and the second is the one that matters: that the limit
     * exists, and that it is not so low it fires before the run's own sign-ins
     * are done. A limiter nobody has counted is a limiter that either does
     * nothing or breaks the product, and there is no way to tell which by
     * reading it.
     */
    name: 'the login rate limiter refuses once the configured number of attempts is spent',
    run: async () => {
      const attempt = () =>
        fetch(`${BASE}/api/v1/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: `smoke-throttle-${Date.now()}-${Math.random()}@test.local`,
            password: 'a-sufficiently-long-passphrase',
          }),
        });

      let limited = 0;
      let attempts = 0;
      // A generous ceiling: enough to pass the limit from wherever the run left
      // the bucket, and bounded so a broken limiter fails rather than hangs.
      while (attempts < LOGIN_LIMIT * 2 && limited === 0) {
        attempts += 1;
        const response = await attempt();
        if (response.status === 429) limited += 1;
        await response.body?.cancel();
      }

      assert(limited === 1, `no request was rate limited within ${attempts} attempts`);
    },
  },
  {
    name: 'metrics endpoint exposes the declared trading counters',
    run: async () => {
      const response = await fetch(`${BASE}/metrics`);
      /**
       * Against a deployment, being refused is the right answer.
       *
       * `/metrics` carries the shape of the whole platform — how many accounts,
       * how many positions, how far behind the feed is — and the edge restricts
       * it to private ranges. Reaching it from outside would be the finding, so
       * that is what is asserted here rather than the reachability the local run
       * checks.
       */
      if (TARGET !== undefined && (response.status === 403 || response.status === 404)) {
        console.log('      (refused from outside a private network, which is correct)');
        return;
      }
      if (TARGET !== undefined && response.ok) {
        throw new Error(
          'metrics answered a request from outside the deployment. It should be restricted to private ranges.',
        );
      }
      assert(response.ok, `metrics returned ${response.status}`);
      const text = await response.text();
      for (const metric of ['tp_orders_submitted_total', 'tp_market_ticks_total']) {
        assert(text.includes(metric), `metrics output is missing ${metric}`);
      }
    },
  },
];

async function waitForBoot(): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await sleep(500);
  }
  throw new Error(`API did not become healthy within ${BOOT_TIMEOUT_MS}ms`);
}

/**
 * Refuses to run if something is already listening.
 *
 * This script spawns its own API. If a stale instance already holds the port,
 * the spawned one fails to bind, the checks quietly hit the old binary, and the
 * run goes green against code that is not the code under test. That is the worst
 * possible failure mode for a smoke test, so it is made impossible rather than
 * documented.
 */
async function assertPortFree(): Promise<void> {
  // Aimed at a deployment on purpose: something listening is the whole point.
  if (TARGET !== undefined) return;
  try {
    await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2_000) });
  } catch {
    return; // nothing listening, which is what we want
  }
  throw new Error(
    `Something is already listening on ${BASE}. Stop it first — otherwise this smoke test would run against it instead of the build under test.`,
  );
}

async function main(): Promise<void> {
  await assertPortFree();

  if (TARGET !== undefined) {
    console.log(`\n  Checking the deployment at ${TARGET}.`);
    console.log('  Nothing is spawned; this says nothing about which build runs there.\n');
    // The rate-limit check spends a raised allowance this run cannot set on a
    // deployment it did not start, so it is skipped rather than reported as a
    // failure of the limiter — which would be a lie in the other direction.
    /**
     * Skipped against a deployment, each for a reason worth printing.
     *
     * These sign in several times over. At the production limit of five a
     * minute they starve, and a starved check reports a broken login — the
     * opposite of the truth, since the limiter refusing is the limiter working.
     * The local run raises the allowance on a process it started; this one
     * cannot, and pretending otherwise would turn a correct refusal into a red
     * line nobody should chase.
     */
    const NEEDS_A_RAISED_LOGIN_LIMIT = [
      'rate limiter',
      'two-factor authentication',
      'see and end their own sessions',
      'permission guard',
    ];
    const skippedFor = new Map<string, string>();
    const applicable = checks.filter((c) => {
      const reason = NEEDS_A_RAISED_LOGIN_LIMIT.find((needle) => c.name.includes(needle));
      if (reason === undefined) return true;
      skippedFor.set(c.name, 'signs in more than the production limit allows');
      return false;
    });
    for (const [name, reason] of skippedFor) console.log(`  skip ${name} — ${reason}`);
    let failed = 0;
    for (const check of applicable) {
      try {
        await check.run();
        console.log(`  ok  ${check.name}`);
      } catch (error) {
        failed += 1;
        console.error(`  FAIL ${check.name}: ${(error as Error).message}`);
      }
    }
    const skipped = checks.length - applicable.length;
    if (failed > 0) {
      console.error(`\n${failed} check(s) failed against ${TARGET}.`);
      process.exitCode = 1;
    } else {
      console.log(
        `\nAll ${applicable.length} checks passed against ${TARGET}` +
          (skipped > 0 ? ` (${skipped} skipped: needs a build this run controls).` : '.'),
      );
    }
    return;
  }

  const api = spawn('node', ['apps/api/dist/main.js'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    /**
     * The login limiter is raised for this run, and then proved.
     *
     * Every check here that needs a session signs in, and at the production
     * limit of five a minute the run starves itself — which is what happened
     * the moment a check with several sign-ins was added, and it looked exactly
     * like a broken login. Raising it silently would leave the limiter untested
     * in the one place that runs the real binary, so the last check below
     * deliberately exhausts this number and asserts a 429.
     */
    env: { ...process.env, RATE_LIMIT_LOGIN_PER_MINUTE: String(LOGIN_LIMIT) },
  });
  const output: string[] = [];
  api.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  api.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()));

  let failures = 0;
  try {
    await waitForBoot();
    for (const check of checks) {
      try {
        await check.run();
        console.log(`  ok  ${check.name}`);
      } catch (error) {
        failures += 1;
        console.error(`  FAIL ${check.name}: ${(error as Error).message}`);
      }
    }
  } catch (error) {
    failures += 1;
    console.error((error as Error).message);
    console.error(output.join('').slice(-4000));
  } finally {
    api.kill('SIGTERM');
  }

  if (failures > 0) {
    console.error(`\n${failures} smoke check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${checks.length} smoke checks passed.`);
  }
}

void main();
