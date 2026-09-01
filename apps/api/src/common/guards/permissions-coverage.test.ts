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

/** Where a method's own body starts: the signature line under its decorators. */
const SIGNATURE = /^\s*(?:public |private |protected )?(?:async )?[A-Za-z_$][\w$]*\s*\(/;

/**
 * Reads the whole decorator block a route belongs to, and only that block.
 *
 * Both directions, because decorator order does not matter to Nest and a check
 * that only looked upward enforced an ordering nobody had written down. It
 * reported `@Put('roles/:key')` as undeclared while `@RequirePermissions` sat on
 * the very next line, enforcing perfectly at runtime. A build check that is
 * wrong about working code is a check people learn to argue with.
 *
 * Widening it exposed the more serious bug, in the direction that was already
 * there. The upward scan used to stop only at a bare `}`, so a member whose body
 * closes on its own signature line — `first(): void {}` — did not stop it, and
 * the next route inherited the previous one's `@RequirePermissions`. An
 * undeclared route reported as declared is the failure this whole file exists to
 * prevent, and it was reachable. Both scans now stop at a member's signature as
 * well as at a closing brace.
 */
function undeclaredMutations(source: string, file: string): Undeclared[] {
  const lines = source.split('\n');
  const found: Undeclared[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (!MUTATION.test(lines[i]!)) continue;

    let declared = false;
    for (let j = i; j >= 0 && !declared; j -= 1) {
      const line = lines[j]!;
      if (EXEMPT.test(line)) declared = true;
      // The previous member: nothing above this belongs to us.
      else if (j < i && (SIGNATURE.test(line) || /^\s*[}]/.test(line))) break;
    }
    for (let j = i + 1; j < lines.length && !declared; j += 1) {
      const line = lines[j]!;
      if (EXEMPT.test(line)) declared = true;
      // The method's own signature: past here is its body, not its decorators.
      else if (SIGNATURE.test(line)) break;
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

  /**
   * The scanner is the thing being trusted here, so it is tested on sources it
   * can see whole rather than only on the repository. A scanner that returned
   * nothing would pass the repository check forever.
   */
  describe('the scanner itself', () => {
    const bodied = (decorators: string): string =>
      `class C {\n${decorators}\n  handle(): void {}\n}\n`;

    it('accepts a declaration above the route', () => {
      expect(undeclaredMutations(bodied("  @RequirePermissions(X)\n  @Post('a')"), 'f')).toEqual(
        [],
      );
    });

    it('accepts a declaration below the route, which Nest treats identically', () => {
      expect(undeclaredMutations(bodied("  @Post('a')\n  @RequirePermissions(X)"), 'f')).toEqual(
        [],
      );
    });

    it('still catches a route with no declaration at all', () => {
      expect(undeclaredMutations(bodied("  @Post('a')"), 'f')).toHaveLength(1);
    });

    /**
     * The reason the downward scan stops at the signature: a `@RequirePermissions`
     * belonging to the *next* method must not cover this one.
     */
    it('does not borrow the next method\u2019s declaration', () => {
      const source = [
        'class C {',
        "  @Post('a')",
        '  first(): void {}',
        '',
        '  @RequirePermissions(X)',
        "  @Post('b')",
        '  second(): void {}',
        '}',
      ].join('\n');
      const undeclared = undeclaredMutations(source, 'f');
      expect(undeclared).toHaveLength(1);
      expect(undeclared[0]?.route).toBe("@Post('a')");
    });

    it('does not borrow a declaration from inside the previous method body', () => {
      const source = [
        'class C {',
        '  @RequirePermissions(X)',
        "  @Post('a')",
        '  first(): void {}',
        '',
        "  @Post('b')",
        '  second(): void {}',
        '}',
      ].join('\n');
      expect(undeclaredMutations(source, 'f').map((u) => u.route)).toEqual(["@Post('b')"]);
    });
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
