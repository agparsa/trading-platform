import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { envSchema } from '../apps/api/src/config/env.schema';
import { workerEnvSchema } from '../apps/worker/src/env';

/**
 * `.env.example` against the things that actually read an environment variable.
 *
 * `production-env.test.ts` checks `.env.production.example` in both directions
 * and is the reason this file is short. It treats the **schemas** as ground
 * truth, though, so it cannot see a name that is in neither schema — and
 * `.env.example` is the file a developer copies and an operator reads first.
 *
 * Two names were in exactly that state: `PASSWORD_HASH_MEMORY_COST` and
 * `PASSWORD_HASH_TIME_COST`, printed in the security block directly under
 * `SECRET_ENCRYPTION_KEYS`, with plausible OWASP values, and existing **nowhere
 * else in the repository**. An operator hardening a deployment could raise the
 * iteration count, restart, and have changed nothing — and nothing would say
 * so, because a name no schema knows is a name nothing rejects.
 */

const ROOT = resolve(__dirname, '..');

/**
 * Names `.env.example` carries that no application schema validates, each
 * because something other than the API or the worker reads it.
 *
 * A reason per entry, and the test below checks the reason rather than taking
 * it: an allow-list nobody has to justify is how a real orphan gets added.
 */
const NOT_APPLICATION_CONFIG: Readonly<Record<string, string>> = {
  API_PORT: 'compose: which host port the API container publishes',
  WEB_PORT: 'compose: which host port the web container publishes',
  POSTGRES_DB: 'compose: the database image’s own environment',
  POSTGRES_USER: 'compose: the database image’s own environment',
  POSTGRES_PASSWORD: 'compose: the database image’s own environment',
  POSTGRES_PORT: 'compose: which host port Postgres publishes',
  REDIS_PORT: 'compose: which host port Redis publishes',
  NEXT_PUBLIC_API_URL: 'the web app, baked in at build time by Next.js',
  NEXT_PUBLIC_WS_URL: 'the web app, baked in at build time by Next.js',
  TEST_DATABASE_URL: 'the test harness, not either application',
  TEST_DATABASE_URL_TENANT: 'the test harness, not either application',
};

/**
 * Names that nothing reads **yet**, deliberately.
 *
 * A different claim from the list above and checked differently. "Something
 * else reads it" can be verified by looking; "this is reserved for work not
 * done" cannot, so what is checked instead is that the reader of
 * `.env.example` is told — the line is marked reserved there, and the document
 * named here explains what is waiting on it. That is the whole difference
 * between a placeholder and an orphan, and it is the part an operator needs.
 */
const RESERVED: Readonly<Record<string, string>> = {
  NEXT_PUBLIC_CHARTING_LIBRARY_PATH: 'docs/charting.md',
};

const apiShape = (envSchema as unknown as { shape: Record<string, unknown> }).shape;
const workerShape = (workerEnvSchema as unknown as { shape: Record<string, unknown> }).shape;

/** Every name `.env.example` sets, commented-out lines included. */
export function declaredNames(source: string): string[] {
  const names: string[] = [];
  for (const line of source.split('\n')) {
    const match = /^#?\s*([A-Z][A-Z0-9_]{2,})=/.exec(line.trim());
    if (match?.[1] !== undefined) names.push(match[1]);
  }
  return [...new Set(names)];
}

function repositoryText(): string {
  const parts: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(ts|tsx|yml|yaml|sh|json)$/.test(entry)) continue;
      /**
       * Not this file.
       *
       * The exemption list below lives here, so searching a corpus that
       * includes this file means every exemption vindicates itself by existing
       * — the escape hatch and its only second opinion in the same place. A
       * mutation proved it: an invented name added to the list passed.
       */
      if (path === __filename || path.endsWith('env-example.test.ts')) continue;
      parts.push(readFileSync(path, 'utf8'));
    }
  };
  for (const directory of ['apps', 'packages', 'scripts', 'docker']) walk(join(ROOT, directory));
  for (const file of [
    'docker-compose.yml',
    'docker-compose.prod.yml',
    'docker-compose.cpanel.yml',
  ]) {
    try {
      parts.push(readFileSync(join(ROOT, file), 'utf8'));
    } catch {
      // Not every checkout has every compose file; absence is not this test's business.
    }
  }
  return parts.join('\n');
}

const EXAMPLE = readFileSync(join(ROOT, '.env.example'), 'utf8');
const REPOSITORY = repositoryText();

describe('.env.example', () => {
  it('finds the names it is meant to be checking', () => {
    const declared = declaredNames(EXAMPLE);
    expect(declared.length).toBeGreaterThan(80);
    expect(declared).toContain('DATABASE_URL');
    // Commented-out lines are settings too — an operator uncomments them.
    expect(declared).toContain('DATABASE_URL_TENANT');
  });

  /**
   * The headline. A variable printed here and validated by neither schema is a
   * setting an operator can change with no effect and no error.
   */
  it('sets nothing that no schema validates and nothing explains', () => {
    const orphans = declaredNames(EXAMPLE).filter(
      (name) =>
        !(name in apiShape) &&
        !(name in workerShape) &&
        NOT_APPLICATION_CONFIG[name] === undefined &&
        RESERVED[name] === undefined,
    );
    expect(
      orphans,
      'printed in .env.example, validated by no schema: setting one changes nothing and says nothing',
    ).toEqual([]);
  });

  /**
   * The exemption list is itself a claim — that something outside the two
   * applications reads the name. A name listed here that appears nowhere in the
   * repository is the orphan the test above exists to catch, hidden behind an
   * allow-list.
   */
  it('exempts nothing the repository never mentions', () => {
    const unread = Object.keys(NOT_APPLICATION_CONFIG).filter((name) => !REPOSITORY.includes(name));
    expect(unread, 'exempted as read elsewhere, and read nowhere').toEqual([]);
  });

  /**
   * A reserved name is only honest if the person reading `.env.example` is told
   * it does nothing yet. Otherwise it is an orphan with a nicer label.
   */
  it('marks every reserved name as reserved, where an operator would read it', () => {
    for (const [name, document] of Object.entries(RESERVED)) {
      const line = EXAMPLE.split('\n').findIndex((text) => text.startsWith(`${name}=`));
      expect(line, `${name} is not in .env.example`).toBeGreaterThan(0);
      const preamble = EXAMPLE.split('\n')
        .slice(Math.max(0, line - 4), line)
        .join(' ');
      expect(preamble, `${name} is not marked as reserved`).toMatch(/reserved|nothing reads this/i);
      expect(preamble, `${name} does not say where to read more`).toContain(document);
      expect(
        readFileSync(join(ROOT, document), 'utf8'),
        `${document} never mentions ${name}`,
      ).toContain(name);
    }
  });

  it('gives every exemption a reason, not just a name', () => {
    for (const [name, reason] of Object.entries(NOT_APPLICATION_CONFIG)) {
      expect(reason.length, `${name} has no reason`).toBeGreaterThan(20);
    }
  });

  /**
   * The other direction, kept narrow on purpose: a schema variable missing from
   * `.env.example` is a knob nobody finds, which is a smaller problem than one
   * that does nothing. Only the ones without a default are checked, because
   * those are the ones a deployment cannot start without.
   */
  it('shows every variable the API cannot start without', () => {
    const required = Object.entries(apiShape)
      .filter(([, field]) => {
        const definition = field as { isOptional?: () => boolean };
        return typeof definition.isOptional === 'function' && !definition.isOptional();
      })
      .map(([name]) => name);
    expect(required.length).toBeGreaterThan(0);
    const missing = required.filter((name) => !declaredNames(EXAMPLE).includes(name));
    expect(missing, 'required, and a newcomer copying .env.example never learns of it').toEqual([]);
  });
});

/**
 * No setting in the example is present-but-blank.
 *
 * `KEY=` is not "unset". It is "set to the empty string", and the difference
 * reaches production: an empty value is past `.optional()`, past `?? null`, and
 * into whatever parses it. Four settings here were spelled that way — each with
 * a comment saying "leave unset" or "unset = none" directly above it — and
 * copying this file, which is the only thing this file is for, produced an API
 * that would not boot and a withdrawal path that threw on every request.
 *
 * `validateEnv` strips blanks now, so a deployment that leaves one blank
 * behaves as documented rather than breaking. This is the other half: the
 * example should not teach the spelling in the first place, because a reader
 * copies the shape of a line as readily as its value.
 */
describe('.env.example has no blank values', () => {
  const example = readFileSync(resolve(ROOT, '.env.example'), 'utf8');

  it('spells "unset" as a comment, not as an empty value', () => {
    const blank = example
      .split('\n')
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => /^[A-Z][A-Z0-9_]*=\s*$/.test(line))
      .map(({ line, number }) => `${String(number)}: ${line.trim()}`);
    expect(blank, 'write these as `# KEY=` — a blank value is a value').toEqual([]);
  });

  it('is reading the file it thinks it is', () => {
    // A path that resolved to nothing would pass the check above for ever.
    expect(example, '.env.example looks empty').toMatch(/^DATABASE_URL=/m);
    expect(example.split('\n').length).toBeGreaterThan(100);
  });
});
