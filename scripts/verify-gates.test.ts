import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `pnpm verify` is what a person runs before pushing; CI is what runs after.
 * On 23 September CI checked formatting and `verify` did not, and 137 files in
 * the repository failed `pnpm format:check` — some since at least 12 September
 * — while every local run was green. A gate that only runs after the push is
 * a gate whose failure arrives as somebody else's red build, or, where nobody
 * reads the builds, not at all.
 *
 * So every static gate CI runs is required in `verify` too. The dynamic ones
 * (migrate, seed, smoke, pentest) need a database and a built API and are
 * documented separately; they are not what "verify before you push" means.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');

const STATIC = ['lint', 'format:check', 'typecheck', 'check:schema', 'build'];

describe('pnpm verify runs what CI runs, before the push', () => {
  const ci = [...read('.github/workflows/ci.yml').matchAll(/run: pnpm ([a-z:]+)/g)].map(
    (match) => match[1]!,
  );
  const verify = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts[
    'verify'
  ]!;
  const steps = [...verify.matchAll(/pnpm ([a-z:]+)/g)].map((match) => match[1]!);

  it('reads both (the probe that cannot fail is the one that never looked)', () => {
    expect(ci.length).toBeGreaterThan(8);
    expect(steps.length).toBeGreaterThan(4);
  });

  it.each(STATIC)('%s: if CI runs it, verify runs it', (gate) => {
    if (!ci.includes(gate)) return;
    expect(steps, `CI runs pnpm ${gate} and pnpm verify does not`).toContain(gate);
  });

  it('runs the tests, in one form or the other', () => {
    expect(steps.some((step) => step === 'test' || step === 'test:coverage')).toBe(true);
  });
});
