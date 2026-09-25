import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every configuration variable a page tells an operator to set is one the
 * platform reads — and every other upper-case name a page cites is one the
 * code defines.
 *
 * The README's "ones worth knowing" named `CREDENTIALS_ENCRYPTION_KEY` as what
 * seals two-factor secrets and stored credentials. Nothing has ever read it;
 * the variable is `SECRET_ENCRYPTION_KEYS`. An operator who followed the
 * README would have set a key the platform ignored — and the API, finding the
 * real one missing, would have refused to start with a name the README never
 * mentioned.
 *
 * "Reads" is taken from the schemas, the env examples, the compose files and
 * the deploy scripts. Names that belong to something else — the firewall, the
 * Android toolchain — are listed with what they belong to, and so is a name a
 * page mentions because it was removed.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8');

const DATED = new Set([
  'ADMIN_AUDIT.md',
  'ARCHITECTURE_AUDIT.md',
  'COMPLETION_STATUS.md',
  'DATABASE_AUDIT.md',
  'IMPLEMENTATION_PLAN.md',
  'MOBILE_AUDIT.md',
  'SECURITY_AUDIT.md',
  'TRADING_AUDIT.md',
  'architecture-audit.md',
  'final-audit.md',
]);

const NOT_OURS: Readonly<Record<string, string>> = {
  DOCKER_DEVICE: "CSF's csf.conf",
  DOCKER_NETWORK4: "CSF's csf.conf",
  ANDROID_HOME: 'the Android SDK',
  PUSH_ANDROID_CHANNEL_ID: 'sounds.md, as the setting that was removed',
};

/** Every UPPER_SNAKE name the configuration surface mentions. */
const configured = (): Set<string> => {
  const sources: string[] = [
    'apps/api/src/config/env.schema.ts',
    'apps/worker/src/env.ts',
    '.env.example',
    '.env.production.example',
    ...readdirSync(ROOT)
      .filter((name) => /^docker-compose.*\.ya?ml$/.test(name))
      .map((name) => name),
    ...readdirSync(resolve(ROOT, 'scripts'))
      // Not this file: every name in NOT_OURS is written in it.
      .filter((name) => /\.(sh|ts)$/.test(name) && name !== 'doc-variables.test.ts')
      .map((name) => `scripts/${name}`),
    ...readdirSync(resolve(ROOT, 'docker'), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => `${entry.parentPath.slice(ROOT.length + 1)}/${entry.name}`),
    ...readdirSync(resolve(ROOT, 'apps')).flatMap((app) =>
      readdirSync(resolve(ROOT, 'apps', app))
        .filter((name) => /^(Dockerfile.*|next\.config\..*|app\.json)$/.test(name))
        .map((name) => `apps/${app}/${name}`),
    ),
  ];
  // And every constant the code itself defines — enum members, event names,
  // permission names — so a page may name those; what it may not name is
  // something that appears nowhere at all.
  const code = (dir: string): string[] =>
    readdirSync(resolve(ROOT, dir), { recursive: true, withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          /\.(ts|tsx|prisma)$/.test(entry.name) &&
          !entry.parentPath.includes('node_modules') &&
          !entry.parentPath.includes('/dist'),
      )
      .map((entry) => `${entry.parentPath.slice(ROOT.length + 1)}/${entry.name}`);
  sources.push(
    ...readdirSync(resolve(ROOT, 'apps')).flatMap((app) => code(`apps/${app}/src`)),
    ...readdirSync(resolve(ROOT, 'packages')).flatMap((pkg) => code(`packages/${pkg}/src`)),
    ...code('prisma'),
  );
  const names = new Set<string>();
  for (const source of sources) {
    for (const [name] of read(source).matchAll(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g)) names.add(name);
  }
  return names;
};

describe('the variables the documents name', () => {
  const known = configured();
  const pages = [
    ...readdirSync(resolve(ROOT, 'docs'))
      .filter((name) => name.endsWith('.md') && !DATED.has(name))
      .map((name) => `docs/${name}`),
    'README.md',
  ];
  const named = pages.flatMap((page) =>
    [...read(page).matchAll(/`([A-Z][A-Z0-9]*_[A-Z0-9_]{2,})(?:=[^`]*)?`/g)].map((m) => ({
      page,
      name: m[1]!,
    })),
  );

  it('are found (the probe that cannot fail is the one that never looked)', () => {
    expect(known.has('SECRET_ENCRYPTION_KEYS')).toBe(true);
    expect(named.length).toBeGreaterThan(100);
  });

  it('are ones the platform reads, or say whose they are', () => {
    const unknown = named
      .filter(({ name }) => !known.has(name) && NOT_OURS[name] === undefined)
      .map(({ page, name }) => `${page}: ${name}`);
    expect([...new Set(unknown)]).toEqual([]);
  });

  it('list nothing as not ours that the platform has since started reading', () => {
    expect(Object.keys(NOT_OURS).filter((name) => known.has(name))).toEqual([]);
  });
});
