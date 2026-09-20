import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateEnv } from '../apps/api/src/config/env.schema';

/**
 * The README's quick start, run.
 *
 * Step 2 creates `.env` and generates secrets, and says "the API refuses to
 * start on a secret shorter than 32 characters, so this step is not optional."
 * True — and for a long time it generated two secrets out of three.
 * `SECRET_ENCRYPTION_KEYS` stayed at its placeholder, `replace_me_run_pnpm_keygen_1`,
 * and the API refused to start with an error about a setting the README never
 * mentioned. At step 5, after step 4's `pnpm verify` had gone green and told the
 * newcomer that everything worked.
 *
 * The same shape as the blank `KEY=` values one phase earlier, one line above
 * them in the same file, and found the same way: by following the documented
 * path rather than reading it.
 *
 * So this follows it. The bash blocks of step 2 are extracted from the README
 * and executed against a copy of `.env.example` in a temporary directory, and
 * the result is handed to the API's own `validateEnv`. Not a regex for the
 * presence of a line — the block as written, run, and the environment it
 * produces judged by the code that will judge it in production. A required
 * setting added to the schema without a line in the README fails here rather
 * than on somebody's first `pnpm dev`.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf8');

/** The fenced bash blocks between the step-2 heading and step 3. */
const stepTwo = (): string[] => {
  const start = readme.indexOf('**2. Create `.env`');
  const end = readme.indexOf('**3. ', start);
  expect(start, 'step 2 of the quick start has moved').toBeGreaterThan(-1);
  expect(end, 'step 3 of the quick start has moved').toBeGreaterThan(start);
  return [...readme.slice(start, end).matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]!);
};

/** `KEY=value` lines of a `.env`, the way the API's loader will read them. */
const parseEnvFile = (path: string): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match !== null) env[match[1]!] = match[2]!;
  }
  return env;
};

describe('the README quick start', () => {
  it('step 2 produces an environment the API will start on', () => {
    const blocks = stepTwo();
    expect(blocks.length, 'no bash block found in step 2').toBeGreaterThan(0);

    const dir = mkdtempSync(resolve(tmpdir(), 'quick-start-'));
    try {
      copyFileSync(resolve(ROOT, '.env.example'), resolve(dir, '.env.example'));
      const script = blocks
        .join('\n')
        // The README is written for macOS `sed -i ''`; the note beneath it says
        // to drop the `''` on Linux, which is what this runner does.
        .replace(/sed -i ''/g, 'sed -i')
        // And the `cd` into a checkout, which here is the temporary directory.
        .replace(/^cd .*$/gm, '');
      execFileSync('bash', ['-euo', 'pipefail', '-c', script], { cwd: dir, stdio: 'pipe' });

      const env = parseEnvFile(resolve(dir, '.env'));
      /**
       * Placeholders are how this went wrong: a value that says "replace me"
       * is a value nothing replaced.
       *
       * `change_me_locally` is not one. It is the development database
       * password, and `docker-compose.yml` uses the same default when it
       * creates the container, so step 3 works because both sides agree on it;
       * it never leaves the machine and `.env.production.example` leaves it
       * blank for the bootstrap script to fill. The first version of this
       * check flagged it, which would have had the README generating a random
       * password that the compose file then did not know.
       */
      const placeholders = Object.entries(env)
        .filter(([, value]) => /replace_me/i.test(value))
        .map(([key]) => key);
      expect(placeholders, 'step 2 leaves these at their placeholder').toEqual([]);

      // The judgement that matters: the API's own validator, on the result.
      expect(() => validateEnv(env)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is not passing because the example already satisfies the schema', () => {
    // If `.env.example` alone validated, the test above would prove nothing
    // about step 2. It must not: the example ships placeholders on purpose.
    expect(() => validateEnv(parseEnvFile(resolve(ROOT, '.env.example')))).toThrow(
      /SECRET_ENCRYPTION_KEYS|JWT/,
    );
  });
});
