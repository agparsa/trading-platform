import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  NOT_SECRET_BODY_FIELDS,
  SECRET_BODY_FIELDS,
  SECRET_NAME_PATTERN,
} from '../apps/api/src/common/logging';

/**
 * The list in `common/logging.ts` is a claim about the API's own schemas, so it
 * is checked against them rather than against itself.
 *
 * The same shape as `sealed-columns.ts` and its rotation test: one declaration,
 * and a check that points at something the declaration does not control. A
 * hand-written list of secret field names is correct on the day it is written
 * and silently wrong the first time a route gains one.
 */

const API_SRC = join(__dirname, '..', 'apps', 'api', 'src');

/**
 * Environment variables, not request fields. `JWT_ACCESS_SECRET` is a secret
 * and is never a body key; it is validated by a zod object like everything
 * else, and including it would mean listing it as a body field, which would be
 * a lie in the other direction.
 */
const NOT_A_REQUEST_SCHEMA: Readonly<Record<string, string>> = {
  'config/env.schema.ts': 'Process environment, validated at boot. No request ever carries these.',
};

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      found.push(...sourceFiles(path));
      continue;
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts') || entry.endsWith('.spec.ts'))
      continue;
    found.push(path);
  }
  return found;
}

const ZOD_OBJECT = /z\s*\.\s*object\s*\(\s*\{/g;

/**
 * Top-level keys of each `z.object({ … })` in a file.
 *
 * Brace- and quote-aware, and nested objects are skipped rather than flattened,
 * because a key at depth two belongs to a nested schema and would be reported
 * against the wrong owner. Written this way deliberately: the last static
 * survey in this repository scanned to the first delimiter it recognised and
 * was wrong by a factor of four.
 */
export function schemaKeys(source: string): string[] {
  const keys: string[] = [];
  for (const start of [...source.matchAll(ZOD_OBJECT)]) {
    let index = (start.index ?? 0) + start[0].length;
    let depth = 1;
    let expectKey = true;
    while (index < source.length && depth > 0) {
      const character = source[index];
      if (character === '/' && source[index + 1] === '/') {
        index = source.indexOf('\n', index);
        if (index === -1) break;
        continue;
      }
      if (character === '/' && source[index + 1] === '*') {
        const end = source.indexOf('*/', index + 2);
        index = end === -1 ? source.length : end + 2;
        continue;
      }
      if (character === "'" || character === '"' || character === '`') {
        index += 1;
        while (index < source.length && source[index] !== character) {
          index += source[index] === '\\' ? 2 : 1;
        }
        index += 1;
        expectKey = false;
        continue;
      }
      if (character === '{' || character === '(' || character === '[') {
        depth += 1;
        index += 1;
        continue;
      }
      if (character === '}' || character === ')' || character === ']') {
        depth -= 1;
        index += 1;
        if (depth === 1) expectKey = false;
        continue;
      }
      if (character === ',' && depth === 1) {
        expectKey = true;
        index += 1;
        continue;
      }
      if (depth === 1 && expectKey && /[A-Za-z_]/.test(character ?? '')) {
        const rest = source.slice(index);
        const key = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(rest);
        if (key !== null && key[1] !== undefined) {
          keys.push(key[1]);
          index += key[0].length;
          expectKey = false;
          continue;
        }
      }
      if (!/\s/.test(character ?? '')) expectKey = false;
      index += 1;
    }
  }
  return keys;
}

function declaredFields(): Map<string, string[]> {
  const byName = new Map<string, string[]>();
  for (const path of sourceFiles(API_SRC)) {
    const relative = path.slice(API_SRC.length + 1);
    if (NOT_A_REQUEST_SCHEMA[relative] !== undefined) continue;
    for (const key of schemaKeys(readFileSync(path, 'utf8'))) {
      byName.set(key, [...(byName.get(key) ?? []), relative]);
    }
  }
  return byName;
}

describe('the redaction list against the API it protects', () => {
  /**
   * A nested schema is scanned in its own right, so its keys are reported too —
   * a credential one level down is still a credential. What it must not do is
   * mistake `inner` for a key of the outer object and lose `code` behind it.
   */
  it('reads a nested schema as its own object and does not lose what follows it', () => {
    const keys = schemaKeys(
      'const s = z.object({ token: z.string(), nested: z.object({ inner: z.string() }), code: z.string() });',
    );
    expect(keys).toEqual(['token', 'nested', 'code', 'inner']);
  });

  it('is not fooled by a colon inside a string or an arrow', () => {
    const keys = schemaKeys(
      'const s = z.object({ note: z.string().refine((value) => value !== "a: b"), token: z.string() });',
    );
    expect(keys).toEqual(['note', 'token']);
  });

  it('redacts, or exempts by name, every secret-shaped field the API accepts', () => {
    const unlisted: string[] = [];
    for (const [field, files] of declaredFields()) {
      if (!SECRET_NAME_PATTERN.test(field)) continue;
      if ((SECRET_BODY_FIELDS as readonly string[]).includes(field)) continue;
      if (NOT_SECRET_BODY_FIELDS[field] !== undefined) continue;
      unlisted.push(`${field} (${[...new Set(files)].join(', ')})`);
    }
    expect(
      unlisted,
      'a request field looks like a credential and is neither redacted nor exempted with a reason',
    ).toEqual([]);
  });

  it('lists nothing the API no longer accepts', () => {
    const declared = declaredFields();
    const stale = [...SECRET_BODY_FIELDS, ...Object.keys(NOT_SECRET_BODY_FIELDS)].filter(
      (field) => !declared.has(field),
    );
    expect(stale, 'redacted or exempted, and no schema declares it any more').toEqual([]);
  });

  /**
   * Two lists answer the same question — which field names carry a credential —
   * and until now nothing reconciled them. The audit log's was the considered
   * one: nineteen keys, recursive, with its reasoning written down. The log's
   * had four.
   *
   * The audit list matches a bare key at any depth, so it cannot hold `code`
   * without blanking every symbol code in the platform. That is the only
   * permitted difference, and it is named here rather than left as a gap.
   */
  it('protects in the logs everything the audit log refuses to store', () => {
    const audit = readFileSync(join(API_SRC, 'common', 'audit', 'audit.service.ts'), 'utf8');
    const block = /const REDACTED_KEYS = new Set\(\[([\s\S]*?)\]\)/.exec(audit);
    expect(block, 'the audit redaction list has moved or changed shape').not.toBeNull();
    const auditKeys = [...(block?.[1] ?? '').matchAll(/'([a-z]+)'/g)]
      .map((match) => match[1])
      .filter((key): key is string => key !== undefined);
    expect(auditKeys.length).toBeGreaterThan(15);

    const declared = declaredFields();
    const loggedLower = SECRET_BODY_FIELDS.map((field) => field.toLowerCase());
    const missing = auditKeys.filter(
      (key) =>
        [...declared.keys()].some((field) => field.toLowerCase() === key) &&
        !loggedLower.includes(key),
    );
    expect(missing, 'the audit log refuses to store it and the logger would print it').toEqual([]);
  });

  /**
   * The worker carries no redaction list, and that is correct only for as long
   * as it serves no HTTP. Every path in the API's list is a `req.*` or `res.*`
   * one; a worker that started listening would have requests and no rules.
   */
  it('keeps the worker headless, which is the reason it needs no redaction', () => {
    const main = readFileSync(join(API_SRC, '..', '..', 'worker', 'src', 'main.ts'), 'utf8');
    expect(main).toContain('createApplicationContext');
    expect(main, 'the worker now serves HTTP and needs a redaction list').not.toMatch(
      /\.listen\s*\(/,
    );
  });

  /**
   * Nothing can redact a query string. `req.url` is logged whole, and logged
   * again by nginx and by anything else in front of it. The WebSocket gateway
   * already refuses to read its token from one; this holds the HTTP routes to
   * the same rule.
   */
  it('takes no credential as a query parameter, because a query string cannot be redacted', () => {
    const offenders: string[] = [];
    for (const path of sourceFiles(API_SRC)) {
      const relative = path.slice(API_SRC.length + 1);
      if (NOT_A_REQUEST_SCHEMA[relative] !== undefined) continue;
      const source = readFileSync(path, 'utf8');
      for (const match of source.matchAll(/@Query\(\s*'([A-Za-z0-9_]+)'/g)) {
        const name = match[1];
        if (name === undefined) continue;
        if (SECRET_NAME_PATTERN.test(name) && NOT_SECRET_BODY_FIELDS[name] === undefined) {
          offenders.push(`${relative}: @Query('${name}')`);
        }
      }
    }
    expect(offenders, 'a credential in a query string reaches every proxy log').toEqual([]);
  });
});
