import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FILE_BACKED_SECRETS } from '@tp/crypto-core';

/**
 * Every secret a process declares can arrive as a file, and `docs/secrets.md`
 * says which process reads which.
 *
 * `APNS_CREDENTIALS_JSON` — the APNs signing key, a private key — was declared
 * by the worker and missing from `FILE_BACKED_SECRETS`, so it could only be
 * given as an environment variable: in `docker inspect`, in
 * `/proc/<pid>/environ`, in whatever a child process inherits. The deployment
 * test that guards the list reads `.env.production.example`, which carries no
 * push credentials, so nothing noticed. And the document said the other push
 * credential was read by the API, which has never sent a push.
 *
 * So the declared schemas are the source here, not an example file.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMAS = {
  API: 'apps/api/src/config/env.schema.ts',
  worker: 'apps/worker/src/env.ts',
} as const;

/** Variable names a schema declares. */
const declared = (file: string): Set<string> =>
  new Set(
    [...readFileSync(resolve(ROOT, file), 'utf8').matchAll(/^\s{2,4}([A-Z][A-Z0-9_]+): z/gm)].map(
      (m) => m[1]!,
    ),
  );

/**
 * What counts as a secret, by name. Written out rather than inferred, with the
 * look-alikes that are not secrets excluded by name so that each exclusion is
 * a decision somebody can read.
 */
const SECRET = /SECRET|PASSWORD|CREDENTIALS|SERVICE_ACCOUNT|PRIVATE_KEY|^DATABASE_URL|^REDIS_URL/;
const NOT_SECRET = new Set([
  'PASSWORD_HASH_MEMORY_COST',
  'PASSWORD_HASH_TIME_COST',
  'PASSWORD_RESET_TTL_MINUTES',
]);

const byProcess = Object.fromEntries(
  Object.entries(SCHEMAS).map(([name, file]) => [name, declared(file)]),
) as Record<keyof typeof SCHEMAS, Set<string>>;

/** The table in docs/secrets.md: variable → the processes it names. */
const documented = (): Map<string, string> => {
  const doc = readFileSync(resolve(ROOT, 'docs/secrets.md'), 'utf8');
  const start = doc.indexOf('| Variable');
  const rows = doc.slice(start, doc.indexOf('\n\n', start)).split('\n').slice(2);
  const table = new Map<string, string>();
  for (const row of rows) {
    const [names = '', readBy = ''] = row
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    for (const [, name] of names.matchAll(/`([A-Z][A-Z0-9_]+)`/g)) table.set(name!, readBy);
  }
  return table;
};

describe('file-backed secrets', () => {
  it('reads the schemas (the probe that cannot fail is the one that never looked)', () => {
    expect(byProcess.API.has('JWT_ACCESS_SECRET')).toBe(true);
    expect(byProcess.worker.has('APNS_CREDENTIALS_JSON')).toBe(true);
  });

  it('include every secret a process declares', () => {
    const secrets = [...new Set([...byProcess.API, ...byProcess.worker])].filter(
      (name) => SECRET.test(name) && !NOT_SECRET.has(name),
    );
    expect(secrets.filter((name) => !FILE_BACKED_SECRETS.includes(name))).toEqual([]);
  });

  it('are each in docs/secrets.md, naming the processes that declare them', () => {
    const table = documented();
    expect([...table.keys()].sort()).toEqual([...FILE_BACKED_SECRETS].sort());
    for (const [name, readBy] of table) {
      const readers = (Object.keys(SCHEMAS) as Array<keyof typeof SCHEMAS>).filter((process) =>
        byProcess[process].has(name),
      );
      const expected = readers.length === 0 ? 'compose' : readers.join(', ');
      expect(readBy.startsWith(expected), `${name}: "${readBy}"`).toBe(true);
    }
  });
});
