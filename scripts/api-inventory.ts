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
 * Decorators sit above the method they belong to, so the parser accumulates them
 * as it walks, attaches them to the next HTTP decorator it meets, and discards
 * them at any line that is neither a decorator nor a comment — which is the end
 * of the block.
 *
 * It also reads the decorators *below* the HTTP decorator, down to the handler's
 * signature. Nest does not care about the order, so a real route whose
 * `@RequirePermissions` sat under its `@Put` was documented here as
 * "authenticated only" while being fully enforced. A generated document that is
 * wrong about working code is worse than no document, because the reader has no
 * reason to doubt it.
 */
/**
 * One section per `@Controller` in the file.
 *
 * The parser read the first `@Controller` and attributed every route in the
 * file to its base. `features.controller.ts` holds three controllers —
 * `features`, `admin/features`, `admin/brokers` — so this inventory listed
 * `GET /features` twice and `GET /features/:id/features`, and did not list
 * `GET /admin/features` or `GET /admin/brokers/:id/features` at all, both of
 * which the web calls. Found by checking every client call against this table
 * (`client-routes.test.ts`). Each section is now read with its own base and
 * its own class-level decorators — those between the previous class's closing
 * brace and this `@Controller`.
 */
function routesIn(file: string): Array<{ controller: string; base: string; routes: Route[] }> {
  const source = readFileSync(file, 'utf8');
  const starts = [...source.matchAll(/@Controller\(/g)].map((match) => match.index);
  if (starts.length <= 1) return [routesInSection(file, source)];
  return starts.map((start, index) => {
    const previousClassEnd = index === 0 ? 0 : source.lastIndexOf('\n}\n', start) + 3;
    const end = starts[index + 1] ?? source.length;
    // The class-level decorators sit between the previous class and this one;
    // the section runs to the next `@Controller`, whose own decorators are
    // not part of this class — they are cut at the last closing brace.
    const sectionEnd = index + 1 < starts.length ? source.lastIndexOf('\n}\n', end) + 3 : end;
    return routesInSection(file, source.slice(previousClassEnd, sectionEnd));
  });
}

function routesInSection(
  file: string,
  source: string,
): { controller: string; base: string; routes: Route[] } {
  const controllerMatch = /@Controller\(([^)]*)\)/.exec(source);
  const base = basePath(controllerMatch?.[1] ?? '');
  const classLevelPublic = source.slice(0, controllerMatch?.index ?? 0).includes('@Public()');
  // `@SessionOnly()` sits on the class for the credential controllers: a key
  // must not reach the place keys are made. Recorded per route so the
  // inventory says it where a reader looks.
  const classLevelSessionOnly = source
    .slice(0, (controllerMatch?.index ?? 0) + 200)
    .includes('@SessionOnly()');

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
      const trailing: string[] = [];
      for (let j = i + 1; j < Math.min(i + 10, lines.length); j += 1) {
        const candidate = lines[j]!;
        if (candidate.trim().startsWith('@')) {
          trailing.push(candidate.trim());
          continue;
        }
        const named = /^\s*(?:async\s+)?([A-Za-z_][\w]*)\s*\(/.exec(candidate);
        if (named !== null) {
          handler = named[1]!;
          break;
        }
      }

      const guards: string[] = [];
      if (classLevelPublic) guards.push('PUBLIC (class)');
      if (classLevelSessionOnly) guards.push('SESSION-ONLY (class)');
      for (const decorator of [...pending, ...trailing]) {
        if (decorator.startsWith('@RequirePermissions')) {
          guards.push(
            (/\((.*)\)/.exec(decorator)?.[1] ?? '')
              .replace(/Permission\./g, '')
              .replace(/\s+/g, ' '),
          );
        } else if (decorator.startsWith('@Public')) guards.push('PUBLIC');
        else if (decorator.startsWith('@SelfService')) guards.push('SELF-SERVICE');
        else if (decorator.startsWith('@SessionOnly')) guards.push('SESSION-ONLY');
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

  for (const { controller, base, routes } of controllerFiles(ROOT).flatMap(routesIn)) {
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

/** Every route, as data, for tests that check callers against it. */
export function allRoutes(): Array<{ verb: string; path: string }> {
  return controllerFiles(ROOT)
    .flatMap(routesIn)
    .flatMap((section) => section.routes.map((route) => ({ verb: route.verb, path: route.path })));
}

/**
 * Every route with the capabilities its `@RequirePermissions` names, as the
 * `Permission` enum's member names (`RISK_MANAGE`). Empty for a route that
 * names none — public, self-service, or authenticated only.
 */
export function routePermissions(): Array<{ verb: string; path: string; permissions: string[] }> {
  return controllerFiles(ROOT)
    .flatMap(routesIn)
    .flatMap((section) =>
      section.routes.map((route) => ({
        verb: route.verb,
        path: route.path,
        permissions: route.guard
          .split(',')
          .map((part) => part.trim())
          .filter((part) => /^[A-Z][A-Z0-9_]+$/.test(part)),
      })),
    );
}
