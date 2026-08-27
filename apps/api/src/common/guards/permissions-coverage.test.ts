import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every mutating route must say what it requires.
 *
 * The permission guard allows a route that declares nothing, which is right for
 * reads and dangerous for writes: a new `@Post` added in six months would be
 * open to any authenticated user, and nothing would say so. Rather than making
 * the guard fail closed at runtime — where a mistake takes trading down — this
 * fails closed at build time, by reading the controllers.
 *
 * A route may opt out with `@Public()` (registration, login), `@SelfService()`
 * (changing your own password), or a `@Roles(...)` restriction — each an
 * explicit decision a reader can see, rather than an omission.
 */
// Resolved from the working directory rather than the module's own path: this
// file is compiled to CommonJS for the API build, where `import.meta` is not
// available. Vitest runs from the workspace root.
const CONTROLLER_ROOT = existsSync('apps/api/src') ? 'apps/api/src' : 'src';
const MUTATION = /^\s*@(Post|Patch|Put|Delete)\(/;
const EXEMPT = /@RequirePermissions\(|@Public\(\)|@Roles\(|@SelfService\(\)/;

function controllerFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...controllerFiles(path));
    else if (entry.name.endsWith('.controller.ts')) found.push(path);
  }
  return found;
}

interface Undeclared {
  file: string;
  line: number;
  route: string;
}

/**
 * Decorators stack above the method, so the check walks backwards from the HTTP
 * decorator through the contiguous block of decorators and comments that belong
 * to it, stopping at the previous method's closing brace.
 */
function undeclaredMutations(source: string, file: string): Undeclared[] {
  const lines = source.split('\n');
  const found: Undeclared[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (!MUTATION.test(lines[i]!)) continue;

    let declared = false;
    for (let j = i; j >= 0; j -= 1) {
      const line = lines[j]!;
      if (EXEMPT.test(line)) {
        declared = true;
        break;
      }
      // The end of the previous member: nothing above this belongs to us.
      if (j < i && /^\s*[}]\s*$/.test(line)) break;
    }

    if (!declared) {
      found.push({ file, line: i + 1, route: lines[i]!.trim() });
    }
  }
  return found;
}

describe('permission coverage', () => {
  const files = controllerFiles(CONTROLLER_ROOT);

  it('finds the controllers to check', () => {
    // A scan that silently found nothing would pass forever.
    expect(files.length).toBeGreaterThan(4);
  });

  /**
   * A guard that is written, tested and never registered enforces nothing.
   * Deleting the `APP_GUARD` line in `app.module.ts` leaves every unit test in
   * this repository passing, so the registration is asserted directly. It is
   * checked as text because importing the module pulls in the whole Nest
   * container, and this needs to fail in milliseconds without a database.
   */
  it('registers the guard globally', () => {
    const moduleSource = readFileSync(join(CONTROLLER_ROOT, 'app.module.ts'), 'utf8');
    expect(moduleSource).toMatch(/useClass:\s*PermissionsGuard/);
    expect(moduleSource).toMatch(/provide:\s*APP_GUARD/);
  });

  it('declares a permission on every mutating route', () => {
    const undeclared = files.flatMap((file) =>
      undeclaredMutations(readFileSync(file, 'utf8'), file.replace(CONTROLLER_ROOT, '')),
    );

    expect(
      undeclared,
      undeclared.length === 0
        ? ''
        : `These routes change state but declare no permission:\n${undeclared
            .map((u) => `  ${u.file}:${u.line}  ${u.route}`)
            .join(
              '\n',
            )}\nAdd @RequirePermissions(...), or @Public()/@SelfService() if that is the intent.`,
    ).toEqual([]);
  });
});
