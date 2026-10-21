import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `apps/mobile/app.config.js` — the Android app is built with the firm's
 * Firebase client config when one is supplied, and untouched when not.
 *
 * Without the file an Android build cannot be issued an FCM token, so the
 * server's whole FCM path reached no phone; the first test APK went out that
 * way. The config is the only place that connects the two.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const config = require(join(ROOT, 'apps/mobile/app.config.js')) as {
  googleServicesFile: (env: Record<string, string | undefined>, dir: string) => string | null;
  withFirebase: (config: object, file: string | null) => { android?: Record<string, unknown> };
};

describe('the Android Firebase config', () => {
  const base = {
    name: 'Trading Platform',
    android: { package: 'ir.devopss.trading', versionCode: 1 },
  };

  it('is added when GOOGLE_SERVICES_JSON names a file, keeping the rest of android', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gs-'));
    const file = join(dir, 'firm.json');
    writeFileSync(file, '{}');
    const found = config.googleServicesFile({ GOOGLE_SERVICES_JSON: file }, '/nowhere');
    expect(found).toBe(file);
    expect(config.withFirebase(base, found).android).toEqual({
      package: 'ir.devopss.trading',
      versionCode: 1,
      googleServicesFile: file,
    });
  });

  it('is read from beside app.json when the variable is unset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gs-'));
    writeFileSync(join(dir, 'google-services.json'), '{}');
    expect(config.googleServicesFile({}, dir)).toBe(join(dir, 'google-services.json'));
  });

  it('leaves the config exactly as it was when there is none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gs-'));
    expect(config.googleServicesFile({}, dir)).toBeNull();
    expect(
      config.googleServicesFile({ GOOGLE_SERVICES_JSON: join(dir, 'missing.json') }, dir),
    ).toBeNull();
    expect(config.withFirebase(base, null)).toBe(base);
  });
});
