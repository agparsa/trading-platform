import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RISK_RULES } from '../packages/risk-core/src/rules';

/**
 * The rule table in `docs/risk.md` against the rules the engine runs, and the
 * margin-call and stop-out defaults against the schema that sets them.
 *
 * The table is what an operator reads to learn which limits exist and which
 * error a trader sees for each. A rule added to `DEFAULT_RISK_RULES` without a
 * row is a limit nobody knows to configure; a row whose code has drifted is a
 * trader's error that support looks up and cannot find.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const doc = readFileSync(resolve(ROOT, 'docs/risk.md'), 'utf8');
const schema = readFileSync(resolve(ROOT, 'prisma/schema.prisma'), 'utf8');
const rulesSource = ['limits.ts', 'margin.ts']
  .map((file) => readFileSync(resolve(ROOT, 'packages/risk-core/src/rules', file), 'utf8'))
  .join('\n');

/** rule name → the error code its violation carries, read from the source. */
const codes = new Map(
  [...rulesSource.matchAll(/rule: '([a-z-]+)',\s*code: TradingErrorCode\.([A-Z_]+)/g)].map((m) => [
    m[1]!,
    m[2]!,
  ]),
);

const table = (): Map<string, string> => {
  const start = doc.indexOf('| Rule');
  const rows = doc.slice(start, doc.indexOf('\n\n', start)).split('\n').slice(2);
  return new Map(
    rows.map((row) => {
      const [rule = '', code = ''] = row
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim().replace(/`/g, ''));
      return [rule, code];
    }),
  );
};

describe('docs/risk.md', () => {
  it('reads the rules (the probe that cannot fail is the one that never looked)', () => {
    expect(DEFAULT_RISK_RULES.length).toBeGreaterThan(3);
    expect(codes.get('sufficient-margin')).toBe('INSUFFICIENT_MARGIN');
  });

  it('lists every default rule, with the code its violation carries, and no other', () => {
    const inCode = new Map(DEFAULT_RISK_RULES.map((rule) => [rule.name, codes.get(rule.name)]));
    expect(Object.fromEntries(table())).toEqual(Object.fromEntries(inCode));
  });

  it('states the margin-call and stop-out defaults the schema gives', () => {
    const marginCall = /marginCallLevelPercent\s+Decimal\s+@default\((\d+)\)/.exec(schema)?.[1];
    const stopOut = /stopOutLevelPercent\s+Decimal\s+@default\((\d+)\)/.exec(schema)?.[1];
    expect(marginCall).toBeDefined();
    expect(doc).toContain(`margin call ${marginCall}%, stop-out ${stopOut}%`);
  });
});
