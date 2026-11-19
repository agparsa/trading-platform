/**
 * Opens the mobile app's screens in a phone-sized browser and photographs them.
 *
 * The app ships to phones, and nobody had ever seen one of its screens: the
 * machines that built it had no device and no emulator (no KVM). Expo renders
 * the same components on the web through react-native-web, so this exports
 * that build against a local API, signs a fresh trader in, and walks every
 * tab — a picture of each screen, and every console error, at a phone's size.
 * It is a look, not a test of native behaviour: push, haptics, sounds and the
 * keychain are the phone's and are not exercised here.
 *
 *   pnpm build && pnpm tsx --env-file-if-exists=.env scripts/preview-mobile.ts [outDir]
 *
 * Needs Postgres and Redis up and the API built (`apps/api/dist`).
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import { chromium, devices } from 'playwright';

const ROOT = resolve(__dirname, '..');
const OUT = resolve(process.argv[2] ?? join(ROOT, '.mobile-preview'));
const API_PORT = '4000';
const API = `http://localhost:${API_PORT}`;
const WEB_PORT = 8082;
const WEB = `http://localhost:${WEB_PORT}`;
const BUILD = join(ROOT, 'apps/mobile/dist-web');
const PASSWORD = 'preview-mobile-password-1';
const LOCALE = process.env['PREVIEW_LOCALE'] ?? 'en-US';

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.wav': 'audio/wav',
};

async function waitFor(url: string): Promise<void> {
  for (let i = 0; i < 120; i += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`${url} never answered`);
}

async function main(): Promise<void> {
  console.log('Exporting the app for the web…');
  rmSync(BUILD, { recursive: true, force: true });
  execFileSync('npx', ['expo', 'export', '-p', 'web', '--clear', '--output-dir', BUILD], {
    cwd: join(ROOT, 'apps/mobile'),
    env: { ...process.env, CI: '1', EXPO_PUBLIC_API_URL: API },
    stdio: 'inherit',
  });

  // A static server with the single-page fallback expo-router's web build wants.
  const web = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    let file = join(BUILD, path);
    if (!file.startsWith(BUILD) || !existsSync(file) || statSync(file).isDirectory()) {
      file = join(BUILD, 'index.html');
    }
    res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
    res.end(readFileSync(file));
  }).listen(WEB_PORT);

  let api: ChildProcess | null = null;
  const prisma = new PrismaClient();
  try {
    api = spawn('node', ['apps/api/dist/main.js'], {
      cwd: ROOT,
      stdio: ['ignore', 'ignore', 'inherit'],
      env: {
        ...process.env,
        API_PORT,
        CORS_ORIGINS: `${WEB},http://localhost:3000`,
        RATE_LIMIT_LOGIN_PER_MINUTE: '100',
      },
    });
    await waitFor(`${API}/health`);

    const email = `preview-mobile-${Date.now()}@test.local`;
    const registered = await fetch(`${API}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ email, password: PASSWORD, displayName: 'Preview Trader' }),
    });
    if (!registered.ok) throw new Error(`register answered ${registered.status}`);
    await prisma.user.updateMany({ where: { email }, data: { emailVerified: true } });

    mkdirSync(OUT, { recursive: true });
    // A browser already on the machine, when one is named — as smoke-web does.
    const executablePath = process.env['PLAYWRIGHT_CHROMIUM_PATH'];
    const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath });
    const context = await browser.newContext({ ...devices['Pixel 7'], locale: LOCALE });
    const page = await context.newPage();
    /**
     * The API treats a request with an \`Origin\` header as a browser, and a
     * browser gets its refresh token as a cookie — the phone gets it in the
     * body. The preview is the phone's code in a browser, so its API calls are
     * passed through without the header, as the phone sends them, and the
     * answer is let back in to the page.
     */
    await page.route(`${API}/**`, async (route) => {
      const cors = {
        'access-control-allow-origin': WEB,
        'access-control-allow-credentials': 'true',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      };
      if (route.request().method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: cors });
        return;
      }
      const headers = { ...route.request().headers() };
      delete headers['origin'];
      delete headers['referer'];
      const response = await route.fetch({ headers });
      if (response.status() >= 400 && process.env['PREVIEW_DEBUG'] === '1') {
        console.log(
          `  ${route.request().method()} ${route.request().url()} → ${response.status()} auth=${headers['authorization'] === undefined ? 'none' : 'yes'}`,
        );
      }
      await route.fulfill({ response, headers: { ...response.headers(), ...cors } });
    });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    const shot = async (name: string) => {
      await page.waitForTimeout(1_500);
      await page.screenshot({ path: join(OUT, `${name}.png`) });
      console.log(`  ${name}  (${errors.length} console errors so far)`);
    };

    await page.goto(WEB);
    await page.waitForTimeout(2_000);
    await shot('01-login');
    await page.locator('input').nth(0).fill(email);
    await page.locator('input').nth(1).fill(PASSWORD);
    await page
      .getByText(/^sign in$/i)
      .last()
      .click();
    await page.waitForTimeout(3_000);
    await shot('02-home');

    // Every tab, pressed as a thumb would — a full reload would race the
    // session being read back, which on a phone happens once at launch.
    const tabs = ['Quotes', 'Chart', 'Trade', 'History', 'More'];
    for (const [index, label] of tabs.entries()) {
      await page.getByText(label, { exact: true }).last().click();
      await shot(`03-tab-${index}-${label.toLowerCase()}`);
    }
    for (const [index, label] of [
      'Account',
      'Notifications',
      'Profile & security',
      'Settings',
    ].entries()) {
      await page.getByText('More', { exact: true }).last().click();
      await page.waitForTimeout(500);
      await page.getByText(label, { exact: true }).first().click();
      await shot(`03-more-${index}-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`);
    }
    // Registration, as a new trader sees it.
    await page.getByText('More', { exact: true }).last().click();
    await page.waitForTimeout(500);
    await page.getByText('Sign out', { exact: true }).first().click();
    await page.waitForTimeout(1_500);
    await page.getByText('Create account', { exact: true }).first().click();
    await page.locator('input').nth(2).fill('short');
    await shot('05-register');
    await page.locator('input').nth(2).fill(PASSWORD);
    await page.locator('input').nth(1).fill(email);
    await page.locator('input').nth(0).fill('Preview Trader');
    await page.locator('input').nth(1).fill(`preview-mobile-new-${Date.now()}@test.local`);
    await page.getByText('Create account', { exact: true }).last().click();
    await shot('06-registered');
    await page.locator('input').nth(1).fill(PASSWORD);
    await page
      .getByText(/^sign in$/i)
      .last()
      .click();
    await page.waitForTimeout(3_000);

    // One instrument's trade screen and chart.
    // The order ticket, opened from a price as a trader opens it.
    await page.getByText('Quotes', { exact: true }).last().click();
    await page.waitForTimeout(1_500);
    await page
      .getByLabel(/^Buy XAUUSD/)
      .first()
      .click();
    await shot('04-ticket');

    await browser.close();
    console.log(`\n${errors.length} console error(s):`);
    for (const line of [...new Set(errors)].slice(0, 30)) console.log(`  ${line.slice(0, 300)}`);
    console.log(`\nScreens in ${OUT}`);
  } finally {
    api?.kill();
    web.close();
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
