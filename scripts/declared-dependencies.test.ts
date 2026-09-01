import { readFileSync, readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every package an application imports must be one it declares.
 *
 * ## Why a test, when the code runs
 *
 * It runs *here*. The workspace hoists, so `import { raw } from 'express'`
 * resolves in `apps/api` even though express is only a transitive dependency
 * of `@nestjs/platform-express`. The production image does not hoist: pnpm's
 * strict layout gives each application exactly what its own `package.json`
 * names, and nothing else.
 *
 * So the phase 6 build passed every test, every typecheck and every smoke
 * check, was deployed, and the API crash-looped on
 * `Cannot find module 'express'` — with the web container healthy, the
 * migration applied, and every trader locked out until the next image built.
 *
 * This is the check that would have failed on the developer's machine instead.
 * It reads the source rather than trying to resolve anything, because the
 * question is not "can this be found" but "is this *ours* to depend on".
 */

const ROOT = join(__dirname, '..');

/** Applications whose images carry only their own declared dependencies. */
const APPLICATIONS = ['apps/api', 'apps/worker'] as const;

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

/** Bare specifiers that resolve to something other than a package, and why. */
const EXEMPT: Readonly<Record<string, string>> = {
  'reflect-metadata': 'a side-effect import Nest itself requires; carried by @nestjs/core',
};

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules' && entry !== 'dist') walk(full, found);
      continue;
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts') || entry.endsWith('.d.ts')) continue;
    found.push(full);
  }
  return found;
}

/** The package a specifier names: `@scope/name` or `name`, never a deep path. */
function packageOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

const IMPORT =
  /(?:^|\n)\s*(?:import|export)\s[^'"]*?\sfrom\s+['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

function bareImportsIn(source: string): Set<string> {
  const found = new Set<string>();
  for (const match of source.matchAll(IMPORT)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier === undefined) continue;
    if (specifier.startsWith('.') || specifier.startsWith('/')) continue;
    if (BUILTINS.has(specifier)) continue;
    found.add(packageOf(specifier));
  }
  return found;
}

describe.each(APPLICATIONS)('%s declares every package it imports', (application) => {
  const manifest = JSON.parse(readFileSync(join(ROOT, application, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]);

  const used = new Map<string, string[]>();
  for (const file of walk(join(ROOT, application, 'src'))) {
    for (const name of bareImportsIn(readFileSync(file, 'utf8'))) {
      const list = used.get(name) ?? [];
      list.push(file.slice(ROOT.length + 1));
      used.set(name, list);
    }
  }

  it('imports something at all, so the scan is not passing on an empty set', () => {
    expect(used.size).toBeGreaterThan(5);
  });

  it('has no import that resolves only by hoisting', () => {
    const undeclared = [...used]
      .filter(([name]) => !declared.has(name) && !(name in EXEMPT))
      .map(([name, files]) => `${name} (in ${files.slice(0, 3).join(', ')})`);
    expect(
      undeclared,
      `these are imported but not in ${application}/package.json — they resolve here by hoisting ` +
        'and will not resolve in the production image. Declare them, or add to EXEMPT with a reason.',
    ).toEqual([]);
  });
});
