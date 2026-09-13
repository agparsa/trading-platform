import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Money must not touch a float, checked rather than asserted.
 *
 * ## The claim, and what it was worth
 *
 * `docs/TRADING_AUDIT.md`: "**No floating-point arithmetic touches money
 * anywhere.** … This satisfies the specification's rule without
 * qualification." `docs/DATABASE_AUDIT.md` says the same about columns and
 * names the script that checks them.
 *
 * The column half was true and enforced — `pnpm check:schema` asks
 * `information_schema` what the columns actually are, and CI runs it. The
 * *arithmetic* half was enforced by nothing at all, and it was false in four
 * places:
 *
 *   - `isTighter` compared risk ceilings with `Number()`. In
 *     `RiskHierarchyService.refuseLooser` a false `false` there is a layer
 *     raising a ceiling set above it, which is the thing the hierarchy exists
 *     to prevent.
 *   - `IntegrityService` computed gross notional as
 *     `Number(volume) * Number(contractSize) * Number(entryPrice)`, accumulated
 *     it with `+`, and wrote it back through `toFixed(2)` — feeding a detector
 *     whose own arithmetic is scrupulously decimal. 0.41 lots at 975.635 with
 *     contract size 100 is 40001.04; that path returned 40001.03.
 *   - the risk console sorted exposures on `Math.abs(Number(netVolume))`,
 *     three lines after computing `netVolume` with `toDecimal().minus()`.
 *   - two validations decided "greater than zero" in binary.
 *
 * None of them was catastrophic and one was only reachable at absurd
 * magnitudes. That is rather the point: a rule stated "without qualification"
 * decays in exactly this way — one convenient `Number()` at a time, each
 * defensible on its own, none of them noticed.
 *
 * ## The rule
 *
 * In the trees that handle money, `Number(x)` and `parseFloat(x)` are refused
 * when `x` names a monetary or quantitative value. Not every `Number()` — a
 * page size, a port, a timestamp and a retry count are all integers and all
 * fine. The vocabulary below is what money is called in this repository.
 *
 * ## What it does not catch
 *
 * Said plainly, because a check whose limits are unstated gets trusted past
 * them. It reads identifiers, so `Number(x)` where `x` was assigned from a
 * balance three lines earlier is invisible to it, and so is `+`/`*` between two
 * values that are already numbers. It is a tripwire on the commonest way in,
 * not a proof. The proof, where it matters, is a test that pins the arithmetic
 * — `integrity.test.ts` and `risk-limits.tightening.test.ts` both do.
 *
 * Concretely: `isTighter` still calls `Number(candidate)` for its
 * `maxOpenPositions` branch, and this check does not see it, because
 * `candidate` is not a money word. That one is a count of open positions and
 * exact as a double, and what actually holds it correct is
 * `risk-limits.tightening.test.ts`, which asserts both directions of every
 * branch. The tripwire and the test are different instruments; neither
 * replaces the other.
 */

const ROOT = join(import.meta.dirname, '..');

/** The trees where money lives. */
const SEARCHED = [
  'packages/financial-core/src',
  'packages/trading-core/src',
  'packages/risk-core/src',
  'packages/integrity-core/src',
  'packages/reconciliation-core/src',
  'apps/api/src',
  'apps/worker/src',
];

/** What money and quantities are called here. Matched case-insensitively. */
const MONEY_WORDS = [
  'amount', 'balance', 'equity', 'price', 'notional', 'volume', 'margin',
  'pnl', 'profit', 'loss', 'commission', 'swap', 'fee', 'exposure', 'credit',
  'debit', 'ledger', 'payout', 'deposit', 'withdrawal', 'rate', 'lot',
  'quantity', 'cost', 'value', 'total', 'sum', 'net', 'gross',
  'money', 'currency', 'threshold', 'ceiling',
];

/**
 * Two words that looked obvious and are not.
 *
 * `decimal` matches `toDecimalPlaces`, which is the *tool*, so every correct
 * use of it would be reported. `limit` is overwhelmingly a page size here —
 * `Number(query.limit)` — and a risk ceiling is called `ceiling` or named
 * outright. A vocabulary that cries wolf gets an allow-list entry per false
 * positive until the allow-list is the whole file, which is how a check like
 * this dies.
 */

/**
 * Float conversions that are correct, and why each is.
 *
 * Keyed `path:identifier`. Every entry is a value that is either an exact
 * integer as a double, or a figure whose use is explicitly display-only — and
 * in the latter case the source says so at the call site, not only here.
 */
const ALLOWED: Readonly<Record<string, string>> = {
  'apps/api/src/realtime/realtime.service.ts:marginLevel.toString':
    'classifyRiskState, which says at the call site why: these are threshold percentages ' +
    'compared for display and notification, never money, and the stop-out that actually ' +
    'closes a position is decided elsewhere in decimal.',
  'apps/api/src/realtime/realtime.service.ts:thresholds.stopOut': 'the same comparison.',
  'apps/api/src/realtime/realtime.service.ts:thresholds.marginCall': 'the same comparison.',
};

interface Offence {
  readonly file: string;
  readonly line: number;
  readonly identifier: string;
  readonly text: string;
}

function sourceFiles(dir: string): string[] {
  const absolute = join(ROOT, dir);
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.ts$/.test(entry) && !/\.(test|spec)\.ts$/.test(entry)) out.push(path);
    }
  };
  try {
    walk(absolute);
  } catch {
    // A tree that does not exist is not an offence; `searches trees that exist`
    // below is what catches a path going stale.
  }
  return out;
}

/** Every `Number(x)` / `parseFloat(x)` whose `x` reads like money. */
export function offencesIn(
  files: readonly { readonly path: string; readonly source: string }[],
  allowed: Readonly<Record<string, string>> = ALLOWED,
): { readonly offences: Offence[]; readonly used: Set<string> } {
  const offences: Offence[] = [];
  const used = new Set<string>();
  const call = /\b(?:Number|parseFloat)\(\s*([A-Za-z_$][A-Za-z0-9_$.?[\]']*)/g;

  for (const { path, source } of files) {
    const lines = source.split('\n');
    lines.forEach((text, index) => {
      const trimmed = text.trim();
      // Comments are prose. This file's own header would otherwise fail it.
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      for (const match of text.matchAll(call)) {
        const identifier = (match[1] as string).replace(/\?\.$/, '');
        const looksLikeMoney = MONEY_WORDS.some((word) =>
          identifier.toLowerCase().includes(word),
        );
        if (!looksLikeMoney) continue;
        const key = `${path}:${identifier}`;
        if (key in allowed) {
          used.add(key);
          continue;
        }
        offences.push({ file: path, line: index + 1, identifier, text: trimmed });
      }
    });
  }
  return { offences, used };
}

function realFiles(): { path: string; source: string }[] {
  return SEARCHED.flatMap((dir) =>
    sourceFiles(dir).map((absolute) => ({
      path: relative(ROOT, absolute),
      source: readFileSync(absolute, 'utf8'),
    })),
  );
}

describe('the rule, driven with source that is deliberately wrong', () => {
  const FIXTURE = [
    {
      path: 'fixture/bad.ts',
      source: [
        'const notional = Number(position.volume) * 100;',
        'const n = parseFloat(grossNotional);',
        'const ok = Number(pageSize) + 1;',
        'const alsoOk = Number(retryAttempts);',
        '// const commented = Number(balance);',
        ' * @example Number(amount)',
      ].join('\n'),
    },
  ];

  it('catches money and leaves counters alone', () => {
    const { offences } = offencesIn(FIXTURE, {});
    expect(offences.map((o) => o.identifier)).toEqual(['position.volume', 'grossNotional']);
  });

  it('does not read prose as code', () => {
    // The header of this very file names `Number(volume)` several times.
    const { offences } = offencesIn(FIXTURE, {});
    expect(offences.map((o) => o.line)).not.toContain(5);
    expect(offences.map((o) => o.line)).not.toContain(6);
  });

  it('excuses exactly what the allow-list names, and nothing else', () => {
    const { offences, used } = offencesIn(FIXTURE, {
      'fixture/bad.ts:position.volume': 'a reason',
    });
    expect(offences.map((o) => o.identifier)).toEqual(['grossNotional']);
    expect(used).toEqual(new Set(['fixture/bad.ts:position.volume']));
  });
});

describe('money never touches a float', () => {
  const files = realFiles();

  it('searches trees that exist and are not empty', () => {
    // The failure mode of every check that walks a directory list.
    expect(files.length).toBeGreaterThan(200);
    for (const dir of SEARCHED) {
      expect(sourceFiles(dir).length, `${dir} has no sources — has it moved?`).toBeGreaterThan(0);
    }
  });

  it('converts no monetary value with Number() or parseFloat()', () => {
    const { offences } = offencesIn(files);
    expect(
      offences.map((o) => `  ${o.file}:${o.line}  ${o.text}`),
      `Money compared or computed in binary floating point:\n\n` +
        offences.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join('\n') +
        `\n\nUse \`toDecimal(x)\` from @tp/financial-core — \`.lessThan\`, \`.comparedTo\`, ` +
        `\`.plus\`, \`.mul\`. If this genuinely is not money, or is an exact integer, add it ` +
        `to ALLOWED with the reason and say the same thing at the call site.`,
    ).toEqual([]);
  });

  it('keeps no allow-list entry that no longer applies', () => {
    const { used } = offencesIn(files, ALLOWED);
    const stale = Object.keys(ALLOWED).filter((key) => !used.has(key));
    expect(stale, `ALLOWED excuses these and they are gone. Remove them.`).toEqual([]);
  });
});
