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
 * The administrator is promoted in the database because there is no endpoint
 * that mints one — which is the right answer, and the reason this is here rather
 * than in a fixture.
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
  const tenant = await prisma.tenant.findFirstOrThrow({ select: { id: true } });
  await prisma.wallet.upsert({
    where: { userId_currency: { userId: traderRow.id, currency: 'USD' } },
    create: { tenantId: tenant.id, userId: traderRow.id, currency: 'USD' },
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
    await visit(page, '/account', { url: '/account', text: /Account/i });
    await visit(page, '/wallet', { url: '/wallet', text: /Wallet/i });
    /**
     * The deposit form must offer what the *server* has, not a list written in
     * the client. A build that shipped card logos against a deployment with only
     * a bank transfer would render fine and fail on submit.
     */
    const walletBody = await page.locator('body').innerText();
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
    await visit(adminPage, '/admin/payments', {
      url: '/admin/payments',
      text: /Awaiting confirmation/i,
    });
    await visit(adminPage, '/admin/kyc', { url: '/admin/kyc', text: /Awaiting review/i });
    await visit(adminPage, '/admin/withdrawals', {
      url: '/admin/withdrawals',
      text: /In flight/i,
    });
    await visit(adminPage, '/admin/audit', { url: '/admin/audit' });
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
