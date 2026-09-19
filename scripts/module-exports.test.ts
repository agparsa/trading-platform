import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every `@Module` exports something it can actually export.
 *
 * Nest resolves its graph at boot, not at compile time. A module that lists a
 * provider in `exports` without providing it — or without importing the module
 * that does — is a TypeScript-clean, fully-tested application that will not
 * start:
 *
 *   UnknownExportException: Nest cannot export a provider/module that is not a
 *   part of the currently processed module (ReconciliationModule).
 *
 * That is not hypothetical. Splitting `QueuePublisher` into a module of its own
 * left exactly that behind. Typecheck passed, 2,946 tests passed, and the API
 * answered nothing. Every integration test here builds its own small testing
 * module, so none of them ever assembles the real one, and `pnpm verify` does
 * not boot the application at all — it was found by `pnpm smoke`, which spawns
 * the built binary against a database and a Redis.
 *
 * **This is deliberately static.** Three runtime approaches were tried first
 * and each failed for a reason that had nothing to do with this application:
 * a testing module's `compile()` cannot supply `Reflector`, which the global
 * guard takes at index 0; Nest's preview mode does not instantiate the internal
 * core providers, so it cannot resolve `Reflector` either; and a real
 * application context needs Postgres and Redis, which is `pnpm smoke` again. A
 * check that cannot pass is not a check.
 *
 * So this reads the decorators. It catches one class of mistake — the one that
 * has actually happened — in milliseconds, with no services, inside the gate a
 * developer runs before committing. It does not claim to be the graph.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every `*.module.ts` under an application's source tree. */
const moduleFiles = (app: string): string[] => {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.module.ts')) found.push(path);
    }
  };
  walk(resolve(ROOT, app, 'src'));
  return found;
};

/**
 * The contents of one array in a `@Module({...})` decorator.
 *
 * Bracket-depth aware, because the first version was not and it was wrong in
 * the way these surveys are always wrong: it stopped at the first `]`, which in
 * `PushModule` is the one closing `inject: [ConfigService]` inside a
 * `useFactory` provider. It read that module as providing nothing and reported
 * two exports as unprovidable — a confident, plausible, false result about a
 * module that is correctly wired. The tell was that the two names it named were
 * plainly there in the file.
 */
const arrayField = (source: string, field: string): string[] => {
  const decorator = /@Module\(\{([\s\S]*)\}\)\s*export class/.exec(source);
  if (decorator === null) return [];
  const body = decorator[1]!;
  const start = new RegExp(`(^|[\\s,{])${field}:\\s*\\[`, 'm').exec(body);
  if (start === null) return [];
  let depth = 0;
  let end = -1;
  const from = start.index + start[0].length - 1;
  for (let i = from; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '[' || ch === '{' || ch === '(') depth += 1;
    else if (ch === ']' || ch === '}' || ch === ')') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return [];
  const inner = body.slice(from + 1, end);
  /**
   * Only the tokens that name a provider or module: a bare identifier, or the
   * `provide:` of an object-literal provider. `inject:`, `useFactory` bodies and
   * type annotations inside them name plenty of classes that the module is
   * *consuming*, and counting those would make this check pass by accident.
   */
  const names = new Set<string>();
  // Split on top-level commas rather than on newlines: `exports: [A, B]` fits
  // on one line and an object-literal provider spans a dozen.
  const items: string[] = [];
  let depth2 = 0;
  let current = '';
  for (const ch of inner) {
    if (ch === '[' || ch === '{' || ch === '(') depth2 += 1;
    if (ch === ']' || ch === '}' || ch === ')') depth2 -= 1;
    if (ch === ',' && depth2 === 0) {
      items.push(current);
      current = '';
    } else current += ch;
  }
  items.push(current);

  for (const item of items) {
    const provide = /\bprovide:\s*([A-Z][A-Za-z0-9_]*)/.exec(item);
    if (provide !== null) {
      names.add(provide[1]!);
      continue;
    }
    const bare = /^\s*([A-Z][A-Za-z0-9_]*)(?:\.\w+\([\s\S]*\))?\s*$/.exec(item);
    if (bare !== null) names.add(bare[1]!);
  }
  return [...names];
};

interface ApiModule {
  file: string;
  name: string;
  imports: string[];
  providers: string[];
  exports: string[];
  controllers: string[];
}

const parse = (file: string): ApiModule | null => {
  const source = readFileSync(file, 'utf8');
  const name = /export class (\w+Module)/.exec(source)?.[1];
  if (name === undefined) return null;
  return {
    file: file.slice(ROOT.length + 1),
    name,
    imports: arrayField(source, 'imports'),
    providers: arrayField(source, 'providers'),
    exports: arrayField(source, 'exports'),
    controllers: arrayField(source, 'controllers'),
  };
};

describe('every Nest module exports what it can export', () => {
  const modules = ['apps/api', 'apps/worker']
    .flatMap((app) => moduleFiles(app))
    .map(parse)
    .filter((module): module is ApiModule => module !== null);

  const byName = new Map(modules.map((module) => [module.name, module]));

  it('parses the decorators rather than merely finding the files', () => {
    // The first version of this parser stopped at the first `]` and read
    // PushModule as providing nothing. Counting files proves nothing; these are
    // the totals, and a parser that silently returned empty arrays would fail
    // here rather than reporting a perfectly wired application.
    const providers = modules.reduce((sum, m) => sum + m.providers.length, 0);
    const exported = modules.reduce((sum, m) => sum + m.exports.length, 0);
    const imported = modules.reduce((sum, m) => sum + m.imports.length, 0);
    expect(providers, 'providers parsed').toBeGreaterThan(60);
    expect(exported, 'exports parsed').toBeGreaterThan(30);
    expect(imported, 'imports parsed').toBeGreaterThan(40);

    // And one known module, read by eye: object-literal providers and a
    // single-line exports array, which are the two shapes that broke it.
    const push = byName.get('PushModule');
    expect(push?.providers).toEqual(
      expect.arrayContaining(['PrismaService', 'SecretBox', 'PushProvider', 'PushService']),
    );
    expect(push?.exports).toEqual(expect.arrayContaining(['PushService', 'PushProvider']));
  });

  it('found the modules it is checking', () => {
    // A walker that found nothing would make the check below vacuous, and the
    // application would look impeccably wired.
    expect(modules.length, 'no @Module decorators parsed').toBeGreaterThan(30);
    expect(modules.some((m) => m.exports.length > 0), 'nothing exports anything').toBe(true);
    expect(modules.some((m) => m.imports.length > 0), 'nothing imports anything').toBe(true);
  });

  it('provides, or imports the provider of, everything it exports', () => {
    const wrong: string[] = [];
    for (const module of modules) {
      for (const exported of module.exports) {
        // Re-exporting a module wholesale is legal, and so is exporting one it
        // imports.
        if (exported.endsWith('Module')) {
          if (!module.imports.includes(exported) && exported !== module.name) {
            wrong.push(`${module.name} exports ${exported}, which it does not import`);
          }
          continue;
        }
        if (module.providers.includes(exported)) continue;
        /**
         * And nothing else. Importing the module that provides something does
         * **not** let you re-export the provider — only the module.
         *
         * That is not a guess and it is the reason this test exists in this
         * shape. Its first version allowed it, on the reasoning that an
         * imported module's exports are in scope, and the mutation that
         * reproduces the regression this whole file was written for *survived*:
         * `ReconciliationModule` imported `JobsModule`, which exports
         * `QueuePublisher`, and re-exported `QueuePublisher` — which is exactly
         * the configuration Nest refused to start on, with the error quoted
         * above. The check has to be as strict as Nest, and Nest is stricter
         * than it looks.
         */
        wrong.push(
          `${module.name} (${module.file}) exports ${exported}, which it does not provide — ` +
            `importing the module that provides it is not enough; export that module instead`,
        );
      }
    }
    expect(wrong, 'Nest refuses to start on any of these').toEqual([]);
  });
});
