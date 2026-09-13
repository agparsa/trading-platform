import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The rehearsal has to actually rehearse.
 *
 * ## What went wrong, and why nothing noticed
 *
 * `migration-rehearsal.ts` answers one question that no other gate does: *does
 * the migration chain apply to a database that is behind?* Production is
 * always behind — that is what a deploy is — so this is the question that
 * matters on the day.
 *
 * It built the "behind" state by pointing `prisma migrate deploy` at a
 * truncated copy of the migrations directory via `PRISMA_MIGRATIONS_PATH`.
 * **That is not a Prisma environment variable.** Prisma ignored it, applied the
 * repository's whole migrations directory, and *succeeded* — so the `.catch()`
 * fallback beside it never ran either. Proven rather than assumed: a directory
 * holding one migration produced a database with fifty-one rows in
 * `_prisma_migrations`.
 *
 * Every "a database N migration(s) behind" line it printed was a fresh full
 * install wearing a label. The report agreed because the report was arithmetic:
 * it printed `all.length - cut`, a computed figure, never an observed one. So
 * it read "1 applied" whether one migration had been applied or fifty-one.
 *
 * Two failures compounding. A setup step that quietly did something else, and
 * a report that could not tell. Either alone is survivable; together they
 * produce four confident green lines per run, for weeks.
 *
 * ## What this file pins
 *
 * The script now counts `_prisma_migrations` before and after and fails if the
 * numbers disagree with the claim, so the same mistake cannot be silent twice
 * — reverting to `PRISMA_MIGRATIONS_PATH` now fails with "setup was asked for
 * 49 migration(s) and produced 51". That is checked by running it, not from
 * here.
 *
 * What is checked *here* is the part a run cannot check about itself: that the
 * script still reads the counters at all, still refuses a mismatch, and no
 * longer samples a fixed number of positions. The last one is the failure this
 * file exists for — the sample was three, production was eight behind, and the
 * reasoning that justified three was written when it was true.
 */

const SOURCE = readFileSync(
  join(import.meta.dirname, 'migration-rehearsal.ts'),
  'utf8',
);

describe('the migration rehearsal', () => {
  it('does not use an environment variable Prisma has never had', () => {
    // Kept as a named check rather than folded into the one below, because the
    // next person reaching for a way to point Prisma at another migrations
    // directory will reach for exactly this.
    const uses = SOURCE.split('\n').filter(
      (line) => line.includes('PRISMA_MIGRATIONS_PATH') && !line.trimStart().startsWith('*'),
    );
    expect(
      uses,
      'PRISMA_MIGRATIONS_PATH is ignored by Prisma. Point `--schema` at a schema ' +
        'copied beside the migrations you want applied; that is the documented ' +
        'resolution rule and the only lever there is.',
    ).toEqual([]);
  });

  it('measures what the deploy applied rather than computing it', () => {
    expect(SOURCE).toContain('appliedCount');
    // Before and after, or the difference means nothing.
    expect(SOURCE).toMatch(/const before = await appliedCount/);
    expect(SOURCE).toMatch(/const after = await appliedCount/);
    expect(SOURCE).toMatch(/const applied = after - before/);
  });

  it('refuses a rehearsal whose setup did not produce the state it asked for', () => {
    expect(
      SOURCE,
      'the staged count must be compared against the cut, or a setup step that ' +
        'quietly does something else takes the whole report down with it',
    ).toMatch(/if \(staged !== cut\)/);
    expect(SOURCE).toMatch(/if \(applied !== all\.length - cut\)/);
  });

  /**
   * The one that would have caught the staleness rather than the bug.
   *
   * A literal default here is a number that has to be revisited every time the
   * repository's deploy cadence changes, and revisiting it is precisely what
   * did not happen. Unbounded by default has nothing to go stale.
   */
  it('rehearses every position by default, with no sample size to go stale', () => {
    expect(SOURCE).toMatch(/MIGRATION_REHEARSAL_CUTS.*undefined[\s\S]{0,120}POSITIVE_INFINITY/);
    expect(
      SOURCE,
      'a fixed default sample is an assumption with an expiry date on it',
    ).not.toMatch(/MIGRATION_REHEARSAL_CUTS'\] \?\? '\d+'/);
  });

  it('says so when a run is partial, rather than letting it read as a full sweep', () => {
    expect(SOURCE).toContain('Do not deploy on this alone');
  });
});
