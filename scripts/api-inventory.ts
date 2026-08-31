/**
 * Regenerates the route table in docs/API_INVENTORY.md from the controllers.
 *
 * The document claims to be generated from source. A document that claims that
 * and then drifts is worse than one that never claimed it, because a reader
 * checks it less. So the table lives between two markers, this script writes
 * what goes between them, and `scripts/api-inventory.test.ts` fails the build
 * when the file on disk and the controllers disagree.
 *
 *   pnpm inventory          write the table
 *   pnpm inventory --check  exit non-zero if it would change
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DOC = 'docs/API_INVENTORY.md';
const BEGIN = '<!-- BEGIN GENERATED ROUTES -->';
const END = '<!-- END GENERATED ROUTES -->';
const ROOT = 'apps/api/src';

interface Route {
  verb: string;
  path: string;
  handler: string;
  guard: string;
}

function controllerFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...controllerFiles(path));
    else if (entry.name.endsWith('.controller.ts')) found.push(path);
  }
  return found.sort();
}

/** The `@Controller(...)` argument, reduced to a path prefix. */
function basePath(argument: string): string {
  const trimmed = argument.trim();
  if (trimmed.includes('path:')) return /path:\s*'([^']*)'/.exec(trimmed)?.[1] ?? '';
  if (trimmed.includes('version')) return '';
  return trimmed.replace(/^['"]|['"]$/g, '');
}

/**
 * Decorators sit above the method they belong to, and a route's authorization
 * decorators sit above its HTTP decorator. So the parser accumulates decorators
 * as it walks, attaches them to the next HTTP decorator it meets, and discards
 * them at any line that is neither a decorator nor a comment — which is the end
 * of the block.
 */
function routesIn(file: string): { controller: string; base: string; routes: Route[] } {
  const source = readFileSync(file, 'utf8');
  const controllerMatch = /@Controller\(([^)]*)\)/.exec(source);
  const base = basePath(controllerMatch?.[1] ?? '');
  const classLevelPublic = source.slice(0, controllerMatch?.index ?? 0).includes('@Public()');

  const lines = source.slice((controllerMatch?.index ?? 0) + 1).split('\n');
  const routes: Route[] = [];
  let pending: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();

    if (/^@[A-Za-z]+\(/.test(line) && !/^@(Get|Post|Put|Patch|Delete)\(/.test(line)) {
      pending.push(line);
      continue;
    }

    const http = /^@(Get|Post|Put|Patch|Delete)\(\s*'?([^')]*)'?\s*\)/.exec(line);
    if (http !== null) {
      const [, verb, routePath] = http as unknown as [string, string, string];
      let handler = '?';
      for (let j = i + 1; j < Math.min(i + 10, lines.length); j += 1) {
        const candidate = lines[j]!;
        if (candidate.trim().startsWith('@')) continue;
        const named = /^\s*(?:async\s+)?([A-Za-z_][\w]*)\s*\(/.exec(candidate);
        if (named !== null) {
          handler = named[1]!;
          break;
        }
      }

      const guards: string[] = [];
      if (classLevelPublic) guards.push('PUBLIC (class)');
      for (const decorator of pending) {
        if (decorator.startsWith('@RequirePermissions')) {
          guards.push(
            (/\((.*)\)/.exec(decorator)?.[1] ?? '')
              .replace(/Permission\./g, '')
              .replace(/\s+/g, ' '),
          );
        } else if (decorator.startsWith('@Public')) guards.push('PUBLIC');
        else if (decorator.startsWith('@SelfService')) guards.push('SELF-SERVICE');
        else if (decorator.startsWith('@Roles')) {
          guards.push(`roles: ${/\((.*)\)/.exec(decorator)?.[1] ?? ''}`);
        } else if (decorator.startsWith('@Throttle')) guards.push('throttled');
      }

      routes.push({
        verb: verb.toUpperCase(),
        path: `/${base}/${routePath}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/',
        handler,
        guard: guards.length > 0 ? guards.join(', ') : '_authenticated only_',
      });
      pending = [];
      continue;
    }

    if (
      line.length > 0 &&
      !line.startsWith('*') &&
      !line.startsWith('//') &&
      !line.startsWith('/*')
    ) {
      pending = [];
    }
  }

  return { controller: file.replace(`${ROOT}/`, ''), base, routes };
}

function render(): string {
  const parts: string[] = [];
  let total = 0;
  const byVerb = new Map<string, number>();

  for (const file of controllerFiles(ROOT)) {
    const { controller, base, routes } = routesIn(file);
    if (routes.length === 0) continue;
    parts.push(`### \`${controller}\` — base \`/${base}\``, '');
    parts.push('| Verb | Path | Handler | Requires |', '| --- | --- | --- | --- |');
    for (const route of routes) {
      parts.push(
        `| \`${route.verb}\` | \`${route.path}\` | \`${route.handler}\` | ${route.guard} |`,
      );
      total += 1;
      byVerb.set(route.verb, (byVerb.get(route.verb) ?? 0) + 1);
    }
    parts.push('');
  }

  const summary = [...byVerb.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([verb, count]) => `${count} \`${verb}\``)
    .join(', ');
  parts.push(`**${total} routes:** ${summary}.`, '');
  return parts.join('\n');
}

/**
 * Whitespace-insensitive form, for comparison only.
 *
 * Prettier reformats Markdown tables — it pads every cell to the column width —
 * so the bytes this script writes are not the bytes that end up on disk. What
 * matters is that the same routes with the same guards are listed, so both
 * sides are collapsed before they are compared. Separator rows are dropped
 * entirely: their width is exactly what Prettier changes.
 */
export function normalise(table: string): string {
  return table
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter((line) => line.length > 0 && !/^\|[\s|:-]+\|$/.test(line))
    .join('\n');
}

export function generatedTable(): string {
  return render();
}

export function documentTable(): string {
  const doc = readFileSync(DOC, 'utf8');
  const begin = doc.indexOf(BEGIN);
  const end = doc.indexOf(END);
  if (begin < 0 || end < 0) throw new Error(`${DOC} is missing its generated-section markers`);
  return doc.slice(begin + BEGIN.length, end).trim();
}

function main(): void {
  const table = render().trim();
  if (process.argv.includes('--check')) {
    if (normalise(documentTable()) !== normalise(table)) {
      console.error(`${DOC} does not match the controllers. Run: pnpm inventory`);
      process.exit(1);
    }
    console.log(`${DOC} matches the controllers.`);
    return;
  }

  const doc = readFileSync(DOC, 'utf8');
  const begin = doc.indexOf(BEGIN);
  const end = doc.indexOf(END);
  if (begin < 0 || end < 0) throw new Error(`${DOC} is missing its generated-section markers`);
  writeFileSync(DOC, `${doc.slice(0, begin + BEGIN.length)}\n\n${table}\n\n${doc.slice(end)}`);
  console.log(`Wrote the route table into ${DOC}.`);
}

if (process.argv[1]?.endsWith('api-inventory.ts')) main();
