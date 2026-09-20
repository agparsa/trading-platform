import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Two assumptions the gates made about the world, found by running them in a
 * world that did not match: a fresh environment set up from the README, on a
 * Sunday.
 *
 * Neither is a defect in the platform. Both are a gate reporting a platform
 * defect that was not one — which teaches whoever reads the output to
 * disbelieve it, and a gate nobody believes is a gate nobody runs.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(resolve(ROOT, relative), 'utf8');

/** Source with comments removed, so prose about a thing is not mistaken for it. */
const code = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the smoke gate reads the boot log for a sentence the boot actually prints', () => {
  /**
   * `pnpm smoke` proves the buffered boot lines reach stdout by waiting for the
   * tenant-isolation announcement. It used to wait for the *enforced* sentence
   * alone, which only a two-role deployment prints; the single-role posture —
   * the one `.env.example` produces — prints a different sentence, and the
   * check failed on every developer machine with a diagnosis that was wrong:
   * "buffered logs are not being flushed".
   *
   * The sentinel is a list now, and this holds it to the source in both
   * directions: every sentinel is a sentence the service really logs, and every
   * branch of the announcement is covered by some sentinel.
   */
  const smoke = read('scripts/smoke-api.ts');
  const service = read('apps/api/src/prisma/prisma.service.ts');

  const sentinels = (): string[] => {
    const block = /const ISOLATION_ANNOUNCED = \[([\s\S]*?)\];/.exec(smoke);
    expect(block, 'ISOLATION_ANNOUNCED has moved or been removed').not.toBeNull();
    return [...block![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  };

  /**
   * One entry per logger call in the method, with its message resolved.
   *
   * Two parsers preceded this one and both were wrong in instructive ways. The
   * first read only literals written directly inside `this.logger.x('...')`
   * and missed the branch that assembles its sentence into `const message`
   * and logs the variable — then reported that smoke waits for a sentence the
   * service never logs, about the sentence it logs on every developer machine.
   * The second read every literal in the method and reported the *fragments*
   * of that one concatenated message as separate postures nothing covered.
   * A branch is a logger call; its message is whatever the call's argument
   * resolves to. This resolves one level of `const name = 'a' + 'b'`.
   */
  const announced = (): string[] => {
    const start = service.indexOf('private announceIsolation(): void {');
    expect(start, 'announceIsolation has moved').toBeGreaterThan(-1);
    const end = service.indexOf('\n  }\n', start);
    const body = code(service.slice(start, end));

    const literals = (text: string): string =>
      [...text.matchAll(/[`']([^`']*)[`']/g)].map((m) => m[1]!).join('');
    const variables = new Map<string, string>();
    for (const decl of body.matchAll(/const (\w+) =([\s\S]*?);/g)) {
      variables.set(decl[1]!, literals(decl[2]!));
    }

    const calls: string[] = [];
    for (const call of body.matchAll(/this\.logger\.\w+\(([\s\S]*?)\);/g)) {
      const argument = call[1]!.trim();
      calls.push(variables.get(argument) ?? literals(argument));
    }
    expect(calls.length, 'no logger calls parsed out of announceIsolation').toBeGreaterThanOrEqual(3);
    return calls;
  };

  it('every sentinel is a sentence the service logs', () => {
    const logged = announced().join('\n');
    for (const sentence of sentinels()) {
      expect(logged, `smoke waits for "${sentence}", which the service never logs`).toContain(
        sentence,
      );
    }
  });

  it('every posture the service can announce satisfies some sentinel', () => {
    const list = sentinels();
    expect(list.length, 'no sentinels parsed').toBeGreaterThanOrEqual(3);
    const uncovered = announced().filter((line) => !list.some((s) => line.includes(s)));
    expect(uncovered, 'a boot on this posture would fail the smoke gate for no reason').toEqual(
      [],
    );
  });

  it('is not the enforced-only sentinel again', () => {
    // The one that failed every developer machine. Kept as the named regression.
    expect(sentinels().some((s) => /NOT enforced/.test(s))).toBe(true);
  });
});

describe('no gate places an order on an instrument it assumed was open', () => {
  /**
   * `pnpm chaos` traded `'XAUUSD'`, written into the order body. Gold's session
   * closes for the weekend, so from Friday evening to Sunday night every order
   * in every scenario came back MARKET_CLOSED and the run reported three
   * scenarios in which "nothing fills after Redis came back" — the platform
   * correctly refusing a closed market, reported as the platform failing.
   *
   * `pnpm pentest` had written that lesson down in its own source and resolves
   * an open instrument from the platform — and two of its order-placing probes
   * still carried the literal, printing NOT RUN all weekend. A lesson recorded
   * in one file and not applied in the next is the reason this test reads the
   * files rather than trusting the comments.
   *
   * Only orders. A chart layout or a price alert named for a closed instrument
   * is a legitimate thing to have, so a literal symbol there is not a fault.
   */
  const ORDER_PLACING = ['scripts/failure-injection.ts', 'scripts/pentest.ts', 'scripts/smoke-api.ts'];

  it('resolves the instrument from what is quoting', () => {
    const offenders: string[] = [];
    for (const file of ORDER_PLACING) {
      const source = code(read(file));
      // An order body: `symbol:` inside an object that also carries `side:`
      // within a few lines. A literal there is the assumption.
      for (const match of source.matchAll(/symbol:\s*'([A-Z]{6,7})'[\s\S]{0,160}?side:/g)) {
        offenders.push(`${file}: symbol: '${match[1]!}' in an order`);
      }
    }
    expect(offenders, 'these orders will be refused whenever that market is shut').toEqual([]);
  });

  it('still finds an order body when one is there', () => {
    // The pattern above returning nothing must mean nothing, not a pattern that
    // matches nothing. It sees the real order bodies once the literal is gone.
    const chaos = code(read('scripts/failure-injection.ts'));
    expect(chaos).toMatch(/symbol:\s*tradeable[\s\S]{0,160}?side:/);
    const pentest = code(read('scripts/pentest.ts'));
    expect((pentest.match(/symbol:\s*world\.tradeable/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });
});
