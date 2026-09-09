/**
 * The first time any of these screens is opened.
 *
 * Every other check in this repository proves something about the server or
 * about a pure function. The web application had been typechecked, linted and
 * unit-tested and **never rendered** — which caught nothing, because a component
 * that throws on mount typechecks perfectly. This boots the built API and the
 * built web application, signs in through the real login form, and visits every
 * route the phase-3 restructure created.
 *
 * What it asserts is deliberately shallow: that each page renders, that it does
 * not throw, that the console is clean, and that the URL a person would be sent
 * lands on the thing it names. Deeper assertions belong in tests that do not
 * need two servers and a browser.
 *
 *   pnpm smoke:web
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import { chromium, type Browser, type ConsoleMessage, type Page } from 'playwright';

/**
 * The ports the *build* expects, not ports of this script's choosing.
 *
 * `NEXT_PUBLIC_API_URL` is inlined by Next at build time, so the compiled
 * bundle already contains an address and setting the variable at run time does
 * nothing at all — the page loads, the form submits, and every request goes to
 * whatever was baked in. That failure looks exactly like a broken login.
 *
 * So this runs on the addresses the build was made with. Point the build
 * elsewhere and point these at the same place.
 */
const API_PORT = process.env['SMOKE_API_PORT'] ?? '4000';
const WEB_PORT = process.env['SMOKE_WEB_PORT'] ?? '3000';
const API = `http://localhost:${API_PORT}`;
const WEB = `http://localhost:${WEB_PORT}`;
const PASSWORD = 'smoke-web-password-1';
const BOOT_TIMEOUT_MS = 90_000;

let failures = 0;
const problems: string[] = [];

function ok(condition: boolean, label: string, detail = ''): void {
  if (condition) {
    console.log(`  ok  ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`);
}

/**
 * Refuses to run against something that was already listening.
 *
 * Every confusing failure in this script's first hour was this: a server left
 * running by an earlier attempt held the port, the one this script spawned died
 * with EADDRINUSE, and the browser talked to the *old* build with the old rate
 * limits. It presented as a broken login, then as a chunk that would not load,
 * then as a 429 — never as "something else is on port 3000".
 *
 * Both spellings of the host, deliberately. The servers bind IPv4; Node's
 * `fetch` resolves `localhost` to `::1` first and gets a refusal while Chromium
 * resolves it to `127.0.0.1` and connects, so a guard that asked only about
 * `localhost` declared the port free and the browser then found the leftover.
 */
async function requireFreePort(url: string, name: string): Promise<void> {
  const answered = await Promise.all(
    [url, url.replace('//localhost:', '//127.0.0.1:')].map((candidate) =>
      fetch(candidate)
        .then(() => true)
        .catch(() => false),
    ),
  ).then((results) => results.some(Boolean));
  if (answered) {
    throw new Error(
      `Something is already answering at ${url}. This script starts its own ${name} and would ` +
        'otherwise test whatever is already there. Stop it first.',
    );
  }
}

/**
 * Kills the whole process group, not the child.
 *
 * Next's standalone entry point re-execs itself, so `child.kill()` returns
 * happily and leaves a `next-server` holding the port for the next run to trip
 * over. `detached: true` puts the child in its own group so the negative pid
 * reaches everything it started.
 */
function stop(child: ChildProcess | undefined): void {
  if (child?.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

async function waitFor(url: string, name: string): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 404) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`${name} did not come up at ${url} within ${BOOT_TIMEOUT_MS}ms`);
}

/**
 * A trader and an administrator, both real.
 *
 * The administrator is promoted in the database because no endpoint mints the
 * first one — which is the right answer, and the reason this is here rather
 * than in a fixture. On a host that act is `scripts/first-administrator.sh`;
 * here the smoke test already holds the database.
 */
async function seedPeople(prisma: PrismaClient): Promise<{
  trader: { email: string };
  admin: { email: string };
  userId: string;
  accountId: string | null;
}> {
  const stamp = Date.now();
  const trader = `smoke-web-${stamp}@test.local`;
  const admin = `smoke-web-admin-${stamp}@test.local`;

  for (const email of [trader, admin]) {
    const response = await fetch(`${API}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ email, password: PASSWORD, displayName: 'Smoke' }),
    });
    if (response.status !== 202 && response.status !== 201) {
      throw new Error(`registering ${email} answered ${response.status}`);
    }
  }

  await prisma.user.updateMany({
    where: { email: { in: [trader, admin] } },
    data: { emailVerified: true },
  });
  await prisma.user.updateMany({ where: { email: admin }, data: { role: 'ADMIN' } });
  const traderRow = await prisma.user.findFirstOrThrow({ where: { email: trader } });

  const account = await prisma.account.findFirst({ where: { userId: traderRow.id } });

  /**
   * A wallet, so the wallet page shows its whole self — the deposit form is
   * there without one, the withdraw form is not, and the walk asserts on
   * both. Created the way the platform creates one: an empty row, no money.
   */
  /**
   * The trader's own tenant, not `findFirstOrThrow()`.
   *
   * That is what this was, and it was wrong the moment the deployment held
   * more than one tenant — which it does as soon as a broker has been created,
   * as this very walk does. An unordered "first" tenant filed the wallet under
   * a firm the trader does not belong to, so the wallet page found none and
   * the withdrawal assertions described an empty screen.
   */
  await prisma.wallet.upsert({
    where: { userId_currency: { userId: traderRow.id, currency: 'USD' } },
    create: { tenantId: traderRow.tenantId, userId: traderRow.id, currency: 'USD' },
    update: {},
  });

  return {
    trader: { email: trader },
    admin: { email: admin },
    userId: traderRow.id,
    accountId: account?.id ?? null,
  };
}

async function signIn(page: Page, email: string): Promise<void> {
  const loginResponses: string[] = [];
  page.on('response', (response) => {
    if (response.url().includes('/auth/login')) {
      loginResponses.push(`${String(response.status())} ${response.url()}`);
    }
  });
  await page.goto(`${WEB}/login`, { waitUntil: 'domcontentloaded' });
  /**
   * Wait for the session restore to finish before touching the form.
   *
   * The login page mounts, asks `/auth/refresh` whether there is a cookie, and
   * re-renders when the answer comes back. Filling a field during that render
   * detaches the element mid-keystroke — Playwright says "element was detached
   * from the DOM, retrying" and then gives up, which reads like a broken form.
   */
  const emailField = page.locator('input[type="email"]');
  await emailField.waitFor({ state: 'visible', timeout: 20_000 });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);

  await emailField.fill(email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  try {
    /**
     * `waitUntil: 'commit'` rather than the default `load`.
     *
     * The landing page is the terminal, which opens a socket and keeps fetching
     * candles, so "load" is a moment it reaches late and sometimes not at all
     * within the timeout — and the failure reads as a broken login rather than a
     * busy page. What is being waited for here is that the navigation happened.
     */
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), {
      timeout: 30_000,
      waitUntil: 'commit',
    });
  } catch (error) {
    // What the screen actually said beats "timed out waiting for navigation".
    const shown = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 300);
    throw new Error(
      `signing in as ${email} did not leave /login. The page says: ${shown}. Login responses: ${loginResponses.join(' | ')}`,
      { cause: error },
    );
  }
}

/** Visits a path and reports what the page turned out to be. */
async function visit(
  page: Page,
  path: string,
  expect: { url?: string; text?: RegExp },
): Promise<void> {
  const errors: string[] = [];
  const onConsole = (message: ConsoleMessage) => {
    if (message.type() === 'error') errors.push(message.text());
  };
  const onPageError = (error: Error) => errors.push(error.message);
  page.on('console', onConsole);
  page.on('pageerror', onPageError);

  try {
    await page.goto(`${WEB}${path}`, { waitUntil: 'domcontentloaded' });
    // Next streams; give the client component a moment to mount and fetch.
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);

    const landed = new URL(page.url()).pathname;
    if (expect.url !== undefined) {
      ok(landed === expect.url, `${path} lands on ${expect.url}`, `landed on ${landed}`);
    }
    if (expect.text !== undefined) {
      const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
      ok(expect.text.test(body), `${path} shows ${String(expect.text)}`, body.slice(0, 160));
    }
    /**
     * A screen that renders and throws is not a screen that works. React logs a
     * caught render error to the console and shows the fallback, which looks
     * fine in a screenshot and is not.
     */
    const real = errors.filter((message) => !isExpectedNoise(message));
    ok(real.length === 0, `${path} renders without console errors`, real.slice(0, 2).join(' | '));
    if (real.length > 0) problems.push(`${path}: ${real[0] ?? ''}`);
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
  }
}

/**
 * Noise that is not this application's fault or is a deliberate refusal.
 *
 * A trader who opens an admin page *should* see 403s in the console: the server
 * refusing is the point, and every panel there asks anyway. Filtering them out
 * is not hiding a failure — the assertion those pages carry is that they render
 * the refusal rather than a blank screen.
 */
function isExpectedNoise(message: string): boolean {
  return (
    message.includes('Failed to load resource') ||
    message.includes('403') ||
    message.includes('status of 401') ||
    message.includes('Download the React DevTools')
  );
}

/**
 * Next's standalone output deliberately omits `.next/static` and `public`.
 *
 * They are meant to be served by a CDN, so the build leaves them out and the
 * deployment copies them in. Doing it here rather than by hand is not tidiness:
 * copying them *into* an existing directory merges old files with new, and the
 * page then asks for a chunk hash that no longer exists and dies with
 * `ChunkLoadError` — which presents as "Application error: a client-side
 * exception has occurred" and looks nothing like a stale copy. That cost half an
 * hour once. The directories are removed first for the same reason.
 */
function prepareStandalone(): void {
  const root = 'apps/web/.next/standalone/apps/web';
  if (!existsSync(`${root}/server.js`)) {
    throw new Error('apps/web is not built. Run `pnpm --filter @tp/web build` first.');
  }
  rmSync(`${root}/.next/static`, { recursive: true, force: true });
  cpSync('apps/web/.next/static', `${root}/.next/static`, { recursive: true });
  if (existsSync('apps/web/public')) {
    rmSync(`${root}/public`, { recursive: true, force: true });
    cpSync('apps/web/public', `${root}/public`, { recursive: true });
  }
}

/**
 * Signs in over HTTP and places one market order.
 *
 * Through the API rather than by inserting a row, because a row inserted by a
 * script is not an order — it has no events, no fill, and nothing for the
 * order-history screen to show. The point of the check that follows is that
 * the console can explain a real order.
 */
async function placeOneOrder(email: string): Promise<void> {
  const signedIn = await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!signedIn.ok) throw new Error(`signing ${email} in answered ${signedIn.status}`);
  const body = (await signedIn.json()) as { data?: { accessToken?: string } };
  const token = body.data?.accessToken;
  if (token === undefined) throw new Error('no access token to place an order with');

  const accounts = await fetch(`${API}/api/v1/accounts`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const list = (await accounts.json()) as { data?: { id: string }[] };
  const accountId = list.data?.[0]?.id;
  if (accountId === undefined) throw new Error('the trader has no account to trade');

  /**
   * The feed only ticks while the session is open, so a market that was shut a
   * moment ago has no price yet. Waiting for one is the honest thing: the
   * order must be placed against a real quote, not a made-up one.
   */
  let last = '';
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const placed = await fetch(`${API}/api/v1/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({ accountId, symbol: 'XAUUSD', side: 'BUY', volume: '0.01' }),
    });
    if (placed.status === 201 || placed.status === 200) return;
    last = `${placed.status}: ${await placed.text()}`;
    if (!last.includes('NO_QUOTE_AVAILABLE')) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`placing the order answered ${last}`);
}

/**
 * Make sure the instrument is open right now, through the console's own route.
 *
 * XAUUSD keeps real hours, so on a Saturday this walk could not place an order
 * at all — and a check that skips itself at weekends is a check that is not
 * run when somebody most needs it. Using the sessions endpoint rather than
 * writing the row means the API's cached week is refreshed too, which writing
 * the row directly would not do.
 */
async function openMarketToday(adminEmail: string): Promise<void> {
  const token = await tokenFor(adminEmail);
  const current = await fetch(`${API}/api/v1/admin/instruments/XAUUSD/sessions`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const week = (await current.json()) as {
    data?: {
      timezone: string;
      windows: { dayOfWeek: number; openMinute: number; closeMinute: number }[];
    };
  };
  const today = new Date().getUTCDay();
  const windows = week.data?.windows ?? [];
  /**
   * A window *covering right now*, not merely a window today.
   *
   * Gold trades on a Sunday — from 22:00 UTC. A check for "is there any window
   * today" was satisfied by that one at half past four in the afternoon and
   * returned early, and the order that followed was refused MARKET_CLOSED with
   * nothing in the output to say why. "There is a session today" and "the
   * market is open" are different questions and only one of them is the one
   * this script is asking.
   */
  const nowMinute = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  const open = windows.some(
    (window) =>
      window.dayOfWeek === today &&
      window.openMinute <= nowMinute &&
      nowMinute < window.closeMinute,
  );
  if (open) return;

  const response = await fetch(`${API}/api/v1/admin/instruments/XAUUSD/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify({
      timezone: week.data?.timezone ?? 'UTC',
      /**
       * Today is replaced rather than added to. Appending a second window for a
       * day that already has a narrow one is how the same instrument ends up
       * with two overlapping sessions, and the next reader has to work out
       * which of them the platform believes.
       */
      windows: [
        ...windows.filter((window) => window.dayOfWeek !== today),
        { dayOfWeek: today, openMinute: 0, closeMinute: 1440 },
      ],
      reason: 'web smoke needs a market that is open to place a real order',
    }),
  });
  if (!response.ok) {
    throw new Error(`opening the market answered ${response.status}: ${await response.text()}`);
  }
}

/** An access token for an email, over HTTP, the way anything else signs in. */
async function tokenFor(email: string): Promise<string> {
  const signedIn = await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!signedIn.ok) throw new Error(`signing ${email} in answered ${signedIn.status}`);
  const body = (await signedIn.json()) as { data?: { accessToken?: string } };
  const token = body.data?.accessToken;
  if (token === undefined) throw new Error(`no access token for ${email}`);
  return token;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  let api: ChildProcess | undefined;
  let web: ChildProcess | undefined;
  let browser: Browser | undefined;

  try {
    await requireFreePort(`${API}/health`, 'API');
    await requireFreePort(`${WEB}/login`, 'web application');

    api = spawn('node', ['apps/api/dist/main.js'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: {
        ...process.env,
        API_PORT,
        CORS_ORIGINS: `${WEB},http://127.0.0.1:${WEB_PORT}`,
        RATE_LIMIT_LOGIN_PER_MINUTE: '100',
      },
    });
    api.stdout?.on('data', () => undefined);
    api.stderr?.on('data', () => undefined);
    await waitFor(`${API}/health`, 'the API');

    prepareStandalone();
    web = spawn('node', ['apps/web/.next/standalone/apps/web/server.js'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: {
        ...process.env,
        PORT: WEB_PORT,
        HOSTNAME: '0.0.0.0',
        NEXT_PUBLIC_API_URL: `${API}/api/v1`,
        NEXT_PUBLIC_WS_URL: API,
      },
    });
    web.stdout?.on('data', () => undefined);
    web.stderr?.on('data', () => undefined);
    await waitFor(`${WEB}/login`, 'the web application');

    const people = await seedPeople(prisma);

    /**
     * `PLAYWRIGHT_CHROMIUM_PATH` names a browser that is already on the machine.
     *
     * Playwright pins a build number and refuses anything else, which is right
     * for a test suite that must be reproducible and wrong for an environment
     * where Chromium is provisioned separately. Without it this script would
     * demand a download on a box that already has a perfectly good browser.
     */
    const executablePath = process.env['PLAYWRIGHT_CHROMIUM_PATH'];
    browser = await chromium.launch({
      args: ['--no-sandbox'],
      ...(executablePath === undefined ? {} : { executablePath }),
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    console.log('\n  As a trader\n');
    await signIn(page, people.trader.email);
    await visit(page, '/', { url: '/terminal' });
    await visit(page, '/terminal', { url: '/terminal' });
    /**
     * Price alerts, set through the browser and read back from the database.
     *
     * Checked end to end rather than "the tab renders": a panel that posts to
     * the wrong path, or posts a number where the API wants a string, looks
     * exactly the same on screen as one that works. The assertion is that a row
     * exists afterwards carrying the level the trader typed, unrounded.
     *
     * The level is far above any price on purpose. The first version used a
     * level near the market and the alert fired between being set and being
     * read — which was the engine working, and made the check depend on which
     * instrument happened to be selected.
     */
    await page.getByRole('tab', { name: /^Alerts$/ }).click();
    const alertLevel = '99999999.5';
    await page.getByLabel('Level').fill(alertLevel);
    await page.getByRole('button', { name: /Set alert/i }).click();

    let alertRow: { price: unknown; symbol: string; status: string } | null = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      alertRow = await prisma.priceAlert.findFirst({
        where: { user: { email: people.trader.email } },
        select: { price: true, symbol: true, status: true },
      });
      if (alertRow !== null) break;
      await page.waitForTimeout(500);
    }
    ok(
      alertRow !== null && String(alertRow.price) === alertLevel && alertRow.status === 'ACTIVE',
      'an alert set in the browser reaches the database with the level as typed',
      alertRow === null
        ? 'no alert row'
        : `${alertRow.symbol} @ ${String(alertRow.price)} (${alertRow.status})`,
    );

    /**
     * And the trader can see their own alert on the screen that set it. The
     * list refetches after the mutation; give it a moment rather than reading
     * the instant before it arrives.
     */
    let alertsPanel = '';
    for (let attempt = 0; attempt < 20; attempt += 1) {
      alertsPanel = await page.getByTestId('alerts-panel').innerText();
      if (alertsPanel.includes('99,999,999.5') || alertsPanel.includes(alertLevel)) break;
      await page.waitForTimeout(500);
    }
    ok(
      alertsPanel.includes('99,999,999.5') || alertsPanel.includes(alertLevel),
      'the alert the trader set is listed back to them',
      alertsPanel.replace(/\s+/g, ' ').slice(0, 200),
    );

    await visit(page, '/account', { url: '/account', text: /Account/i });
    await visit(page, '/wallet', { url: '/wallet', text: /Wallet/i });
    /**
     * The deposit form must offer what the *server* has, not a list written in
     * the client. A build that shipped card logos against a deployment with only
     * a bank transfer would render fine and fail on submit.
     */
    /**
     * Waited for, not read once.
     *
     * The visit above waits for the word "Wallet", which is in the navigation
     * and therefore present immediately — so a single read can happen before
     * the wallet's own queries have resolved, and the assertions below then
     * describe an empty page. Earlier runs passed on timing rather than on
     * the page being right, which is the least useful kind of green.
     */
    let walletBody = '';
    for (let attempt = 0; attempt < 40; attempt++) {
      walletBody = await page.locator('body').innerText();
      if (/leaves your wallet balance the moment you ask/i.test(walletBody)) break;
      await page.waitForTimeout(500);
    }
    ok(
      /Add money/i.test(walletBody) && /Bank transfer/i.test(walletBody),
      'the wallet page offers the deposit method this deployment actually has',
      walletBody.slice(0, 300),
    );
    /**
     * The withdraw form must say the one thing that surprises people — that
     * the balance goes down on asking — and must say what is required before
     * a bank account is typed in.
     */
    ok(
      /leaves your wallet balance the moment you ask/i.test(walletBody) &&
        /identity has to be verified/i.test(walletBody),
      'the wallet page states the hold and the identity gate before a request is made',
      walletBody.slice(0, 400),
    );
    await visit(page, '/verification', { url: '/verification', text: /Not started/i });
    /**
     * The page must say what is still needed, in words, before anything is
     * uploaded. A verification screen that showed only a status would leave a
     * person guessing which of five document kinds to start with.
     */
    const verificationBody = await page.locator('body').innerText();
    ok(
      /Still needed/i.test(verificationBody) && /identity document/i.test(verificationBody),
      'the verification page names what is missing',
      verificationBody.slice(0, 300),
    );
    await visit(page, '/history', { url: '/history', text: /Trades/i });
    await visit(page, '/security', { url: '/security', text: /Two-factor/i });
    /**
     * A key, minted through the page. The secret appears once, in a box the
     * page marks, and nothing else on the page carries it afterwards — which
     * is the one property of this feature worth driving a browser to prove.
     */
    const securityBody = await page.locator('body').innerText();
    ok(
      /API keys/i.test(securityBody) && /Create key/i.test(securityBody),
      'the security page offers API keys beside sessions',
      securityBody.slice(0, 300),
    );
    await page.getByPlaceholder(/What will use it/i).fill('smoke bot');
    await page
      .locator('label', { hasText: /^positions\.read$/ })
      .locator('input[type="checkbox"]')
      .check();
    await page.locator('input[autocomplete="current-password"]').fill(PASSWORD);
    await page.getByRole('button', { name: /Create key/i }).click();
    const secretBox = page.getByTestId('api-key-secret');
    const minted = await secretBox.waitFor({ timeout: 10_000 }).then(
      () => true,
      () => false,
    );
    ok(minted, 'a key can be minted from the security page');
    const secret = minted ? (await secretBox.locator('pre').innerText()).trim() : '';
    ok(
      /^tpk_[A-Za-z0-9]{12}_[A-Za-z0-9_-]{43}$/.test(secret),
      'the minted key has its shape',
      secret.slice(0, 20),
    );
    await page.getByRole('button', { name: /I have saved it/i }).click();
    const afterwards = await page.locator('body').innerText();
    ok(
      secret !== '' && !afterwards.includes(secret) && afterwards.includes(secret.slice(0, 16)),
      'once dismissed, the page shows the fingerprint and never the secret again',
      afterwards.slice(0, 200),
    );
    /**
     * The security feed is the same page, on real rows: the sign-in that
     * opened this browser session and the key minted a moment ago must both
     * be there, in the person's words rather than as enum codes.
     */
    await page.reload({ waitUntil: 'domcontentloaded' });
    const feed = page.getByTestId('security-events');
    const feedShown = await feed
      .getByText(/API key created/i)
      .first()
      .waitFor({ timeout: 10_000 })
      .then(
        () => true,
        () => false,
      );
    const feedBody = feedShown ? await feed.innerText() : '';
    ok(
      feedShown && /Signed in/i.test(feedBody),
      'the security page lists the sign-in and the minted key in its feed',
      feedBody.replace(/\s+/g, ' ').slice(0, 200),
    );
    await visit(page, '/settings', { url: '/settings', text: /One-click/i });

    console.log('\n  As an administrator\n');
    const adminContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const adminPage = await adminContext.newPage();
    await signIn(adminPage, people.admin.email);
    await visit(adminPage, '/admin', { url: '/admin/overview' });
    await visit(adminPage, '/admin/people', { url: '/admin/people' });
    await visit(adminPage, `/admin/people/${people.userId}`, {
      url: `/admin/people/${people.userId}`,
      text: new RegExp(people.trader.email.replace(/[.@+]/g, '.')),
    });
    await visit(adminPage, '/admin/accounts', { url: '/admin/accounts' });
    if (people.accountId !== null) {
      await visit(adminPage, `/admin/accounts/${people.accountId}`, {
        url: `/admin/accounts/${people.accountId}`,
        text: new RegExp(people.trader.email.replace(/[.@+]/g, '.')),
      });
    }
    await visit(adminPage, '/admin/instruments', { url: '/admin/instruments' });
    await visit(adminPage, '/admin/risk', { url: '/admin/risk' });
    await visit(adminPage, '/admin/reconciliation', { url: '/admin/reconciliation' });
    /**
     * The venue tab renders and says the honest thing when there is nothing.
     *
     * Checked for its *wording* rather than merely that it loads: an empty list
     * here means the last run found nothing, which is not the same as anybody
     * having looked recently — and a screen that implies otherwise is the whole
     * failure this feature exists to avoid.
     */
    await adminPage.getByRole('tab', { name: /Against the venue/i }).click();
    let venueBody = '';
    for (let attempt = 0; attempt < 30; attempt++) {
      venueBody = await adminPage.locator('body').innerText();
      if (/disagreement|Runs tab/i.test(venueBody)) break;
      await adminPage.waitForTimeout(500);
    }
    ok(
      /Runs tab says when that was\s+last checked/i.test(venueBody.replace(/\s+/g, ' ')) ||
        /disagreement\(s\)/i.test(venueBody),
      'the venue tab distinguishes "nothing disagrees" from "nobody has looked"',
      venueBody.replace(/\s+/g, ' ').slice(0, 220),
    );
    await visit(adminPage, '/admin/payments', {
      url: '/admin/payments',
      text: /Awaiting confirmation/i,
    });
    await visit(adminPage, '/admin/kyc', { url: '/admin/kyc', text: /Awaiting review/i });
    await visit(adminPage, '/admin/withdrawals', {
      url: '/admin/withdrawals',
      text: /In flight/i,
    });
    /**
     * The firm's book. What is checked is not that a table renders but that it
     * shows *another* account's order — the whole point of the screen is that
     * it is not account-scoped, and a blotter that quietly showed only the
     * reader's own orders would look identical.
     */
    /**
     * One real order, placed by the trader over the real path, so the book has
     * something in it that is not the reader's own.
     */
    await openMarketToday(people.admin.email);
    await placeOneOrder(people.trader.email);

    await visit(adminPage, '/admin/book', { url: '/admin/book' });
    const book = adminPage.getByTestId('book-panel');
    await book.waitFor({ timeout: 10_000 });
    let bookBody = '';
    for (let attempt = 0; attempt < 30; attempt++) {
      bookBody = await book.innerText();
      if (bookBody.includes(people.trader.email)) break;
      await adminPage.waitForTimeout(500);
    }
    ok(
      bookBody.includes(people.trader.email) && /XAUUSD/.test(bookBody),
      "the firm's book shows another account's orders, with whose account they are",
      bookBody.replace(/\s+/g, ' ').slice(0, 200),
    );

    await book
      .getByRole('button', { name: /^History$/ })
      .first()
      .click();
    const history = adminPage.getByTestId('order-history');
    await history.waitFor({ timeout: 10_000 });
    let historyBody = '';
    for (let attempt = 0; attempt < 30; attempt++) {
      historyBody = await history.innerText();
      if (/CREATED/.test(historyBody)) break;
      await adminPage.waitForTimeout(500);
    }
    ok(
      /CREATED/.test(historyBody),
      'one order\u2019s own events answer what happened to it',
      historyBody.replace(/\s+/g, ' ').slice(0, 160),
    );

    /**
     * The trading week: the model has existed since the beginning and nothing
     * could edit it. Saved whole, and the reason is mandatory.
     */
    await visit(adminPage, '/admin/instruments', { url: '/admin/instruments' });
    await adminPage
      .getByRole('button', { name: /^Edit$/ })
      .first()
      .click();
    const week = adminPage.getByTestId('session-editor');
    await week.waitFor({ timeout: 10_000 });
    await week.getByLabel('Friday closes').fill('21:00');
    await week
      .getByPlaceholder('the venue moved its Friday close')
      .fill('the venue moved its Friday close');
    await week.getByRole('button', { name: /Save the week/i }).click();

    let sessions: { dayOfWeek: number; closeMinute: number }[] = [];
    for (let attempt = 0; attempt < 30; attempt++) {
      sessions = await prisma.marketSession.findMany({ where: { dayOfWeek: 5 } });
      if (sessions[0]?.closeMinute === 1260) break;
      await adminPage.waitForTimeout(500);
    }
    ok(
      sessions[0]?.closeMinute === 1260,
      'an instrument\u2019s trading week can be changed from the console, and it lands',
      String(sessions[0]?.closeMinute),
    );

    await visit(adminPage, '/admin/audit', { url: '/admin/audit' });

    /**
     * Desks: create one, delegate an account to it as a named preset, and
     * check the screen shows what was actually stored.
     *
     * The grant is the sharp edge of this whole feature — one person given
     * power over someone else's money — so what is checked is not that the
     * form submits but that the delegation that came back confers what the
     * preset says it confers, and that the desk book then reports the account.
     */
    await visit(adminPage, '/admin/desks', { url: '/admin/desks' });
    const traderRow = await prisma.user.findFirstOrThrow({
      where: { email: people.trader.email },
    });
    const traderAccount = await prisma.account.findFirstOrThrow({
      where: { userId: traderRow.id },
    });
    const operatorRow = await prisma.user.findFirstOrThrow({
      where: { email: people.admin.email },
    });

    await adminPage.getByPlaceholder('London desk').fill(`Smoke desk ${Date.now()}`);
    await adminPage.getByPlaceholder('user id').fill(operatorRow.id);
    await adminPage.getByRole('button', { name: /Create desk/i }).click();
    const opened = await adminPage
      .getByRole('button', { name: /^Open$/ })
      .last()
      .waitFor({ timeout: 10_000 })
      .then(
        () => true,
        () => false,
      );
    ok(opened, 'a desk can be created from the console');
    await adminPage
      .getByRole('button', { name: /^Open$/ })
      .last()
      .click();

    const detail = adminPage.getByTestId('desk-detail');
    await detail.waitFor({ timeout: 10_000 });
    await detail.getByPlaceholder('account id').fill(traderAccount.id);
    await detail.locator('select').selectOption('MASTER_TRADER');
    await detail.getByRole('button', { name: /^Grant$/ }).click();

    let deskBody = '';
    for (let attempt = 0; attempt < 30; attempt++) {
      deskBody = await detail.innerText();
      if (deskBody.includes(traderAccount.number)) break;
      await adminPage.waitForTimeout(500);
    }
    ok(
      deskBody.includes(traderAccount.number) && /Trader/.test(deskBody),
      'an account is delegated to a desk as a named preset, and the desk shows it',
      deskBody.replace(/\s+/g, ' ').slice(0, 200),
    );

    const link = await prisma.masterAccountLink.findFirstOrThrow({
      where: { accountId: traderAccount.id },
    });
    ok(
      link.grantedAsRole === 'MASTER_TRADER' &&
        link.capabilities.includes('orders.create') &&
        // A trader trades; a trader does not manage the account it trades.
        !link.capabilities.includes('accounts.manage'),
      'the preset was expanded and stored, so what is enforced is a list and not a name',
      link.capabilities.join(','),
    );

    /**
     * And the ceiling: a layer may tighten what is above it and never loosen
     * it, which is the one rule the hierarchy exists to keep.
     */
    await visit(adminPage, '/admin/risk', { url: '/admin/risk' });
    // The tabs render as role="tab", not role="button".
    await adminPage.getByRole('tab', { name: /^Ceilings$/ }).click();
    const ceilings = adminPage.getByTestId('risk-ceilings');
    await ceilings.waitFor({ timeout: 10_000 });
    await ceilings.getByPlaceholder('unset').first().fill('2.5');
    await ceilings.getByRole('button', { name: /Set ceiling/i }).click();
    let ceilingBody = '';
    for (let attempt = 0; attempt < 30; attempt++) {
      ceilingBody = await ceilings.innerText();
      if (/BROKER/.test(ceilingBody)) break;
      await adminPage.waitForTimeout(500);
    }
    ok(
      /BROKER/.test(ceilingBody) && /2\.5/.test(ceilingBody),
      'a firm ceiling can be set from the risk console and is shown back',
      ceilingBody.replace(/\s+/g, ' ').slice(0, 200),
    );
    await visit(adminPage, '/admin/roles', { url: '/admin/roles', text: /Administrator/i });

    /**
     * The one check that is about behaviour rather than rendering: the roles
     * screen is the admin surface for grants, so it must actually show them.
     */
    const rolesBody = await adminPage.locator('body').innerText();
    ok(
      rolesBody.includes('orders.cancel') &&
        !/\borders\.create\b/.test(rolesBody.split('ADMIN')[1] ?? ''),
      'the roles screen shows real grants',
      rolesBody.slice(0, 200),
    );

    await visit(adminPage, '/admin/credentials', {
      url: '/admin/credentials',
      text: new RegExp(people.trader.email.replace(/[.@+]/g, '.')),
    });
    await adminPage.getByRole('tab', { name: /Service tokens/i }).click();
    const tokensBody = await adminPage.locator('body').innerText();
    ok(
      /New service token/i.test(tokensBody) && /accounts\.read_any/.test(tokensBody),
      'the credentials screen offers service tokens with reads across the tenant',
      tokensBody.slice(0, 200),
    );

    /**
     * Connections: the screen exists, the mock connector is offered, and the
     * credential form asks for the fields that connector declared. What it
     * must never do is show a value back, so the form is filled, saved, and
     * the page checked for the secret afterwards.
     */
    await visit(adminPage, '/admin/connections', {
      url: '/admin/connections',
      text: /Mock venue|No venue is connected/i,
    });
    /**
     * A fresh name each run. The suite does not empty the database, and a
     * fixed name meant the second run found the connection already made, with
     * credentials already on it — so the flow below silently exercised a
     * different screen than the one it claims to.
     */
    const venueName = `Smoke venue ${Date.now()}`;
    await adminPage.getByPlaceholder('Primary liquidity').fill(venueName);
    await adminPage.getByRole('button', { name: /Create connection/i }).click();
    await adminPage
      .getByRole('button', { name: /Set credentials/i })
      .last()
      .waitFor({ timeout: 10_000 });
    await adminPage
      .getByRole('button', { name: /Set credentials/i })
      .last()
      .click();
    const credentialForm = adminPage.getByTestId('broker-credential-form');
    await credentialForm.waitFor({ timeout: 10_000 });
    const venueSecret = `web-smoke-secret-${Date.now()}`;
    await credentialForm.locator('input[type="text"]').first().fill('1001');
    await credentialForm.locator('input[type="password"]').first().fill(venueSecret);
    await credentialForm.locator('input[type="text"]').nth(1).fill('Mock-Live');
    await credentialForm.getByRole('button', { name: /Save credentials/i }).click();
    await adminPage
      .getByRole('button', { name: /^Test$/ })
      .last()
      .waitFor({ timeout: 10_000 });
    await adminPage
      .getByRole('button', { name: /^Test$/ })
      .last()
      .click();
    const connected = await adminPage
      .getByText(/Connected/i)
      .first()
      .waitFor({ timeout: 15_000 })
      .then(
        () => true,
        () => false,
      );
    const connectionsBody = await adminPage.getByTestId('connections-panel').innerText();
    ok(
      connected && connectionsBody.includes(venueName) && !connectionsBody.includes(venueSecret),
      'a venue connects from the console and the screen never shows the credential back',
      connectionsBody.replace(/\s+/g, ' ').slice(0, 220),
    );

    /**
     * Instruments: the mapping a person writes by hand, end to end.
     *
     * The point of clicking it rather than posting to the route is that this
     * is the screen where a firm decides which contract at a venue its orders
     * reach. If the catalogue does not arrive, or the mapping does not come
     * back with the venue's own lot terms on it, the screen is lying about
     * something that decides where money goes.
     */
    await adminPage
      .getByRole('button', { name: /^Instruments$/ })
      .last()
      .click();
    const mappings = adminPage.getByTestId('broker-mappings');
    await mappings.waitFor({ timeout: 10_000 });
    // `<option>` elements are never "visible" to Playwright, so the catalogue
    // is read from the select's contents rather than waited on as an element.
    let options: string[] = [];
    for (let attempt = 0; attempt < 30 && !options.some((o) => o.includes('XAUUSD.m')); attempt++) {
      options = await mappings.locator('select option').allTextContents();
      if (options.some((o) => o.includes('XAUUSD.m'))) break;
      await adminPage.waitForTimeout(500);
    }
    ok(
      options.some((option) => option.includes('XAUUSD.m')),
      "the venue's own instrument catalogue is read live into the mapping screen",
      options.join(' | ').slice(0, 160),
    );
    await mappings.getByPlaceholder('XAUUSD').fill('XAUUSD');
    await mappings.locator('select').selectOption('XAUUSD.m');
    await mappings.getByRole('button', { name: /Map instrument/i }).click();
    const mapped = await mappings
      .getByText('XAUUSD.m')
      .first()
      .waitFor({ timeout: 10_000 })
      .then(
        () => true,
        () => false,
      );
    const mappingsBody = await mappings.innerText();
    ok(
      mapped && /contract 100/.test(mappingsBody) && /step 0.01/.test(mappingsBody),
      "an instrument maps to the venue's name for it, carrying the venue's own terms",
      mappingsBody.replace(/\s+/g, ' ').slice(0, 200),
    );

    await adminPage
      .getByRole('button', { name: /^Inbox$/ })
      .last()
      .click();
    const inbox = adminPage.getByTestId('broker-inbox');
    await inbox.waitFor({ timeout: 10_000 });
    let inboxBody = '';
    for (let attempt = 0; attempt < 30; attempt++) {
      inboxBody = await inbox.innerText();
      if (!/Loading…/.test(inboxBody)) break;
      await adminPage.waitForTimeout(500);
    }
    ok(
      /sent nothing yet|ORDER_|POSITION_/.test(inboxBody),
      'the inbox screen reports what the venue has sent, and says so plainly when it is nothing',
      inboxBody.replace(/\s+/g, ' ').slice(0, 160),
    );

    await visit(adminPage, '/admin/connections', {
      url: '/admin/connections',
      text: /Waiting on a venue/i,
    });
    const waiting = await adminPage.getByTestId('unconfirmed-orders-panel').innerText();
    ok(
      /Nothing is waiting on a venue/i.test(waiting),
      'the venue-recovery console is on the connections page and reports an empty queue',
      waiting.replace(/\s+/g, ' ').slice(0, 160),
    );

    await visit(adminPage, '/admin/security', { url: '/admin/security', text: /SIGN_IN/ });
    const securityFeed = await adminPage.getByTestId('security-feed').innerText();
    ok(
      new RegExp(people.trader.email.replace(/[.@+]/g, '.')).test(securityFeed) &&
        /API_KEY_MINTED/.test(securityFeed),
      "the firm's security feed shows the trader's sign-in and minted key",
      securityFeed.replace(/\s+/g, ' ').slice(0, 200),
    );

    /**
     * The IP rules tab says plainly whether rules would be enforced, and the
     * webhooks page opens with nothing registered. Neither is a control; both
     * are screens that must not reassure anybody about something that is off.
     */
    await adminPage.getByRole('tab', { name: /Where we can be reached from/i }).click();
    let ipRules = '';
    for (let attempt = 0; attempt < 20; attempt += 1) {
      ipRules = await adminPage.getByTestId('ip-rules').innerText();
      if (/You are calling from/i.test(ipRules)) break;
      await adminPage.waitForTimeout(500);
    }
    ok(
      /You are calling from/i.test(ipRules),
      'the IP rules screen leads with the address the caller is coming from',
      ipRules.replace(/\s+/g, ' ').slice(0, 160),
    );

    await visit(adminPage, '/admin/webhooks', {
      url: '/admin/webhooks',
      text: /Register endpoint/i,
    });
    const webhooks = await adminPage.getByTestId('webhooks').innerText();
    ok(
      /No endpoints/i.test(webhooks),
      'the webhooks page opens with nothing registered and says so',
      webhooks.replace(/\s+/g, ' ').slice(0, 160),
    );

    /**
     * Brokers: the admin here is an ADMIN on the platform tenant, which reads
     * the list (tenants.read is not in ADMIN's set, so the refusal is the
     * honest outcome) — the platform super administrator's screen is proven by
     * promoting and reloading.
     */
    await visit(adminPage, '/admin/brokers', { url: '/admin/brokers' });
    const adminRow = await prisma.user.findFirstOrThrow({ where: { email: people.admin.email } });
    await prisma.user.update({
      where: { id: adminRow.id },
      data: { role: 'PLATFORM_SUPER_ADMIN' },
    });
    // The role travels in the token: end the session and sign in again.
    await prisma.refreshToken.updateMany({
      where: { userId: adminRow.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await adminContext.clearCookies();
    await signIn(adminPage, people.admin.email);
    await visit(adminPage, '/admin/brokers', { url: '/admin/brokers', text: /New broker/i });
    await adminPage.getByPlaceholder('acme-fx').fill(`smoke-broker-${Date.now()}`);
    await adminPage.getByPlaceholder('Acme FX').fill('Smoke Broker');
    await adminPage.getByRole('button', { name: /Create broker/i }).click();
    const inviteBox = adminPage.getByTestId('broker-owner-invite');
    const brokerMade = await inviteBox.waitFor({ timeout: 10_000 }).then(
      () => true,
      () => false,
    );
    const inviteCode = brokerMade ? (await inviteBox.locator('pre').innerText()).trim() : '';
    ok(
      brokerMade && /^[A-Z2-9]{24}$/.test(inviteCode),
      'a broker can be created from the console and the owner invitation is shown once',
      inviteCode.slice(0, 8),
    );
    await adminPage.getByRole('button', { name: /I have passed it on/i }).click();
    const brokersBody = await adminPage.getByTestId('brokers-panel').innerText();
    ok(
      /Smoke Broker/.test(brokersBody) && !brokersBody.includes(inviteCode),
      'the broker is listed and the invitation code is gone from the page',
      brokersBody.replace(/\s+/g, ' ').slice(0, 200),
    );

    console.log('\n  A trader reaching an administrative URL\n');
    await visit(page, '/admin/people', { url: '/admin/people' });
    /**
     * The refusal must arrive, and it must arrive *promptly*.
     *
     * Ten seconds is generous for a message the server sent in one round trip.
     * It was not generous enough when every failed read was retried: the page
     * sat on "Loading…" through a second refusal before saying anything.
     */
    const refused = await page
      .getByText(/does not include|does not carry|not permit/i)
      .first()
      .waitFor({ timeout: 10_000 })
      .then(
        () => true,
        () => false,
      );
    ok(
      refused,
      'a trader on an admin page is refused rather than left loading',
      (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 200),
    );
  } finally {
    await browser?.close();
    stop(api);
    stop(web);
    await prisma.$disconnect();
  }

  console.log('');
  if (failures > 0) {
    console.log(`  ${failures} web smoke checks failed.`);
    for (const problem of problems) console.log(`    ${problem}`);
    process.exit(1);
  }
  console.log('  Every web smoke check passed.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
