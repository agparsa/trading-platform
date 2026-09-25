import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RETRY, nextDelayMs } from '../packages/webhooks-core/src/index';

/**
 * The retry schedule `docs/webhooks.md` promises a receiver, against the one
 * the worker runs.
 *
 * A receiver's operator reads that line to decide how long an outage they can
 * sit through without losing events. It is computed here from `DEFAULT_RETRY`
 * and the worker's own defaults, so the page cannot promise a sixth hour the
 * worker never waits for.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const doc = readFileSync(resolve(ROOT, 'docs/webhooks.md'), 'utf8');
const env = readFileSync(resolve(ROOT, 'apps/worker/src/env.ts'), 'utf8');

const workerDefault = (name: string): number => {
  const match = new RegExp(`${name}: z[^\\n]*\\.default\\((\\d+)\\)`).exec(env);
  if (match === null) throw new Error(`${name} has no default in apps/worker/src/env.ts`);
  return Number(match[1]);
};

/** 30 s, 2 min, 8 min, 32 min, ~2 h, 6 h — the page's own spellings. */
const spell = (ms: number): string => {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds} s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours} h` : `~${Math.round(hours)} h`;
};

const WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
];

describe('the retry schedule in docs/webhooks.md', () => {
  const attempts = workerDefault('WEBHOOK_MAX_ATTEMPTS');

  it('is the schedule the worker runs, delay by delay', () => {
    const delays: string[] = [];
    for (let failed = 1; ; failed += 1) {
      const delay = nextDelayMs(failed, { ...DEFAULT_RETRY, maxAttempts: attempts });
      if (delay === null) break;
      delays.push(spell(delay));
    }
    expect(doc.replace(/\s+/g, ' ')).toContain(
      `schedule: ${delays.join(', ')}; ${WORDS[attempts]} attempts in all`,
    );
  });

  it('names the defaults the worker has', () => {
    expect(attempts).toBe(DEFAULT_RETRY.maxAttempts);
    expect(doc).toContain(
      `\`WEBHOOK_DISABLE_AFTER_FAILURES\` (${workerDefault('WEBHOOK_DISABLE_AFTER_FAILURES')})`,
    );
  });
});
