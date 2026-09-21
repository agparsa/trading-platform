import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `verify:production` carries a hand-written list of the schedules a
 * deployment is supposed to have, and checks each has run at least once. The
 * list is the right idea — a job that never ran leaves no row, so only a list
 * written *outside* the platform can notice it — and a hand-written list is a
 * list that goes out of date in the direction nobody sees: a schedule added to
 * the worker and forgotten here is a schedule whose silence the verifier never
 * asks about. That is the same shape as the `api-ws` omission from the deploy
 * script, and this is the same remedy: read the list from the script and check
 * it against the two places schedules actually come from.
 *
 * Two sources, because the platform records two kinds of schedule in the same
 * table: the worker's `SCHEDULED` table in `queue-registry.ts` (BullMQ crons),
 * and the backup container, which is a shell script with its own cron and
 * writes its row by name in `backup.sh`.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(resolve(ROOT, relative), 'utf8');

/** `QueueName.X` → its wire name, from `queues.ts`. */
function queueNames(): Record<string, string> {
  const body = read('apps/worker/src/queues.ts');
  const block = /export const QueueName = \{([\s\S]*?)\n\} as const;/.exec(body)?.[1];
  expect(block, 'QueueName is where this test expects it').toBeDefined();
  const names: Record<string, string> = {};
  for (const match of (block ?? '').matchAll(/^\s+([A-Z_]+): '([a-z-]+)',/gm)) {
    names[match[1]!] = match[2]!;
  }
  return names;
}

/** The queues the worker schedules, by wire name. */
function workerSchedules(): string[] {
  const body = read('apps/worker/src/queue-registry.ts');
  const block = /const SCHEDULED: ReadonlyArray<[^\n]*> = \[([\s\S]*?)\n\];/.exec(body)?.[1];
  expect(block, 'SCHEDULED is where this test expects it').toBeDefined();
  const names = queueNames();
  return [...(block ?? '').matchAll(/\[QueueName\.([A-Z_]+),/g)].map((match) => {
    const name = names[match[1]!];
    expect(name, `QueueName.${match[1]!} resolves to a wire name`).toBeDefined();
    return name!;
  });
}

/** The row name the backup container writes. */
function backupSchedule(): string {
  const body = read('docker/backup/backup.sh');
  const name = /INSERT INTO scheduled_job_runs[\s\S]*?VALUES\s*\(\s*'([a-z-]+)',/.exec(body)?.[1];
  expect(name, 'backup.sh records its run under a literal name').toBeDefined();
  return name!;
}

/** What the verifier expects, read from its own text. */
function verifierExpects(): string[] {
  const body = read('scripts/verify-production.ts');
  const block = /const EXPECTED = \[([\s\S]*?)\];/.exec(body)?.[1];
  expect(block, 'EXPECTED is where this test expects it').toBeDefined();
  return [...(block ?? '').matchAll(/'([a-z-]+)'/g)].map((match) => match[1]!);
}

describe('the schedules verify:production expects', () => {
  it('found several of each, so an empty parse cannot pass', () => {
    expect(workerSchedules().length).toBeGreaterThanOrEqual(5);
    expect(verifierExpects().length).toBeGreaterThanOrEqual(5);
  });

  it('are exactly the ones the worker schedules plus the backup — no more, no fewer', () => {
    const fromSources = [...workerSchedules(), backupSchedule()].sort();
    expect([...verifierExpects()].sort()).toEqual(fromSources);
  });

  it('name real queues only', () => {
    // A misspelt entry in EXPECTED would be reported as "never run" for ever,
    // and the first person to see it would learn to ignore the check.
    const known = new Set([...Object.values(queueNames()), backupSchedule()]);
    for (const name of verifierExpects()) {
      expect(known.has(name), `${name} is a queue somebody declared`).toBe(true);
    }
  });
});
