/**
 * The repository, counted.
 *
 * `docs/COMPLETION_STATUS.md` opens with a warning about itself:
 *
 *   This document went stale once, silently. Three rounds of edits to it were
 *   string replacements that stopped matching after Prettier reformatted the
 *   tables, so the file kept saying "there is no mobile app" while the mobile
 *   app was being committed around it. It is now regenerated from measurement
 *   rather than patched.
 *
 * Nothing regenerated it. It went stale again, in the way it warns about, and
 * every figure in its "evidence baseline" was roughly half of reality:
 *
 *   | figure              | document | measured |
 *   | ------------------- | -------- | -------- |
 *   | test files          |      141 |      226 |
 *   | tests               |    1,903 |    2,970 |
 *   | workspace packages  |       16 |       20 |
 *   | Prisma models       |       52 |       70 |
 *   | API routes          |      161 |      237 |
 *   | lines of TypeScript |  ~78,000 | ~151,000 |
 *
 * A status document read by whoever asks "is this done?" that under-reports by
 * half is worse than no document: the numbers look specific, and specificity
 * reads as currency.
 *
 * So the block is generated now. `pnpm measure` prints it; `pnpm measure --write`
 * replaces what sits between the markers in that file, and
 * `scripts/repository-figures.test.ts` fails the build when the structural
 * counts drift from what is on disk.
 *
 * **Two kinds of number, treated differently, and that is the point.** Apps,
 * packages, models, migrations and routes change rarely and deliberately, so a
 * mismatch is real drift and the test is exact. Test and line counts change on
 * almost every commit; pinning them would produce a test that fails for
 * everybody and gets deleted within a week, which is how a repository ends up
 * with no check at all. Those carry the commit and date they were measured at
 * instead, so a reader can see how old they are rather than assume they are now.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = resolve(ROOT, 'docs/COMPLETION_STATUS.md');
export const BEGIN = '<!-- measured:begin -->';
export const END = '<!-- measured:end -->';

const directories = (relative: string): string[] =>
  readdirSync(resolve(ROOT, relative), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

/** Every TypeScript file this repository owns: no dependencies, no build output. */
const sourceFiles = (): string[] => {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', '.next', 'coverage', '.git'].includes(entry.name)) continue;
        walk(resolve(dir, entry.name));
      } else if (/\.tsx?$/.test(entry.name)) found.push(resolve(dir, entry.name));
    }
  };
  for (const top of ['apps', 'packages', 'scripts']) walk(resolve(ROOT, top));
  return found;
};

export interface Figures {
  readonly apps: number;
  readonly packages: number;
  readonly models: number;
  readonly migrations: number;
  readonly routes: number;
  readonly sourceFiles: number;
  readonly lines: number;
}

/** The counts that change rarely, plus the two that do not. */
export function measure(): Figures {
  const schema = readFileSync(resolve(ROOT, 'prisma/schema.prisma'), 'utf8');
  const inventory = readFileSync(resolve(ROOT, 'docs/API_INVENTORY.md'), 'utf8');
  const files = sourceFiles();
  return {
    apps: directories('apps').length,
    packages: directories('packages').length,
    models: (schema.match(/^model /gm) ?? []).length,
    migrations: readdirSync(resolve(ROOT, 'prisma/migrations')).filter(
      (name) =>
        /^\d/.test(name) && statSync(resolve(ROOT, 'prisma/migrations', name)).isDirectory(),
    ).length,
    // From the generated table in API_INVENTORY.md, which `pnpm inventory
    // --check` already holds to the controllers. Counting the decorators here
    // would be a second implementation of the same question.
    routes: (inventory.match(/^\| `(?:GET|POST|PATCH|PUT|DELETE)`/gm) ?? []).length,
    sourceFiles: files.length,
    lines: files.reduce((sum, file) => sum + readFileSync(file, 'utf8').split('\n').length, 0),
  };
}

function head(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

export function render(figures: Figures, at = new Date()): string {
  const thousands = (value: number): string => value.toLocaleString('en-GB');
  return [
    BEGIN,
    '',
    `**${figures.apps} applications** (\`api\`, \`web\`, \`worker\`, \`mobile\`) and`,
    `**${figures.packages} workspace packages**, on **${figures.models} Prisma models**`,
    `with **${figures.migrations} migrations** applied, serving **${figures.routes} API routes**.`,
    '',
    `Roughly **${thousands(Math.round(figures.lines / 1000))},000 lines** of TypeScript across`,
    `${thousands(figures.sourceFiles)} files.`,
    '',
    `Counted at \`${head()}\` on ${at.toISOString().slice(0, 10)} by \`pnpm measure\`. The`,
    'structural counts above are checked against the working tree on every build;',
    'the line and file counts move with every commit and are as old as the date',
    'beside them.',
    '',
    END,
  ].join('\n');
}

function main(): void {
  const figures = measure();
  const block = render(figures);
  if (!process.argv.includes('--write')) {
    console.log(block);
    return;
  }
  const doc = readFileSync(DOC, 'utf8');
  const start = doc.indexOf(BEGIN);
  const end = doc.indexOf(END);
  if (start === -1 || end === -1) {
    console.error(`${DOC} has no ${BEGIN} / ${END} markers to write between.`);
    process.exit(1);
  }
  writeFileSync(DOC, doc.slice(0, start) + block + doc.slice(end + END.length));
  console.log(`Updated ${DOC}.`);
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  main();
}
