import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The broker panel's "not built" list, checked against the code.
 *
 * Three documents carry that list — the plan's Phase 5, COMPLETION_STATUS's
 * Phase 5 and broker-panel.md §5 — and on 22 September two of the three still
 * said Reports had "no server-side export", that "no allow/deny concept exists
 * anywhere" for IP rules, and that webhooks and an admin device view were
 * absent, months after each shipped with its own document. broker-panel.md had
 * been corrected and says so in its own text: "this section had gone stale,
 * which is worse than being incomplete". The other two were not, because
 * nothing compared them to anything.
 *
 * So the truth is read from the code — a route, a guard, a model — and each
 * document's list is required to name exactly the features that are absent:
 * a built feature named as missing fails, and an absent feature dropped from
 * the list fails too. The list can change only when the code does.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(resolve(ROOT, relative), 'utf8');
const exists = (relative: string) => existsSync(resolve(ROOT, relative));

interface Feature {
  /** How the documents refer to it. */
  readonly name: string;
  readonly pattern: RegExp;
  /** Read from the code: is it there? */
  readonly built: () => boolean;
}

const FEATURES: readonly Feature[] = [
  {
    name: 'Reports',
    pattern: /\bReports\b/,
    built: () =>
      exists('apps/api/src/reports/reports.controller.ts') &&
      /@Get\(':id\/download'\)/.test(read('apps/api/src/reports/reports.controller.ts')),
  },
  {
    name: 'IP rules',
    pattern: /IP rules/,
    built: () =>
      exists('apps/api/src/security/ip-rules.guard.ts') &&
      exists('apps/api/src/security/ip-rules.controller.ts'),
  },
  {
    name: 'webhooks',
    pattern: /\b[Ww]ebhooks\b/,
    built: () => exists('apps/api/src/webhooks/webhooks.controller.ts'),
  },
  {
    name: 'admin device management',
    pattern: /device management|device view/,
    built: () => /devices\/:deviceId\/revoke/.test(read('apps/api/src/admin/admin.controller.ts')),
  },
  {
    name: 'Fees',
    pattern: /\bFees\b/,
    built: () => /model Fee(Schedule|Rule|Override)\b/.test(read('prisma/schema.prisma')),
  },
  {
    name: 'Alerts (admin threshold rules)',
    pattern: /\bAlerts\b/,
    built: () => /model (Threshold|Admin)Alert(Rule)?\b/.test(read('prisma/schema.prisma')),
  },
  {
    name: 'Branding',
    pattern: /\bBranding\b/,
    built: () => {
      const tenant = /model Tenant \{[\s\S]*?\n\}/.exec(read('prisma/schema.prisma'))?.[0] ?? '';
      return /logo|brand|theme|colour|color/i.test(tenant);
    },
  },
  {
    name: 'API documentation in production',
    pattern: /API documentation/,
    built: () => {
      const main = read('apps/api/src/main.ts');
      const setup = main.indexOf('SwaggerModule.setup(');
      // Mounted only outside production: the guard sits within a few lines above.
      return (
        setup !== -1 && !/if \(!isProduction\)/.test(main.slice(Math.max(0, setup - 200), setup))
      );
    },
  },
];

/** The "Not built" paragraph of a Phase 5 section: from its bold lead-in to the blank line. */
function notBuiltParagraph(document: string, heading: RegExp): string {
  const start = document.search(heading);
  expect(start, `${heading} is in the document`).toBeGreaterThan(-1);
  const section = document.slice(start);
  const lead = section.search(/\*\*Not built[^*]*\*\*/);
  expect(lead, 'the section has a "Not built" paragraph').toBeGreaterThan(-1);
  const rest = section.slice(lead);
  const end = rest.indexOf('\n\n');
  // Unwrapped: Prettier breaks a sentence wherever it likes, and "API
  // documentation" split across a line is still the phrase — the mistake the
  // figures test in this directory made once.
  return (end === -1 ? rest : rest.slice(0, end)).replace(/\s+/g, ' ');
}

describe('the broker panel\'s "not built" list, against the code', () => {
  it('reads the code as this test expects (the probe that cannot fail is the one that never checked)', () => {
    const built = FEATURES.filter((feature) => feature.built()).map((feature) => feature.name);
    const absent = FEATURES.filter((feature) => !feature.built()).map((feature) => feature.name);
    expect(built).toEqual(
      expect.arrayContaining(['Reports', 'IP rules', 'webhooks', 'admin device management']),
    );
    expect(absent.length).toBeGreaterThan(0);
  });

  const documents: Array<[string, RegExp]> = [
    ['docs/IMPLEMENTATION_PLAN.md', /^## Phase 5 — Broker management panel/m],
    ['docs/COMPLETION_STATUS.md', /^## New plan, Phase 5/m],
  ];

  describe.each(documents)('%s', (path, heading) => {
    const paragraph = notBuiltParagraph(read(path), heading);

    it('names no feature the code has', () => {
      const wrongly = FEATURES.filter(
        (feature) => feature.built() && feature.pattern.test(paragraph),
      );
      expect(
        wrongly.map((feature) => feature.name),
        `named as not built, but built: ${wrongly.map((feature) => feature.name).join(', ')}`,
      ).toEqual([]);
    });

    it('names every feature the code lacks', () => {
      const missing = FEATURES.filter(
        (feature) => !feature.built() && !feature.pattern.test(paragraph),
      );
      expect(
        missing.map((feature) => feature.name),
        `absent from the code and from the list: ${missing.map((feature) => feature.name).join(', ')}`,
      ).toEqual([]);
    });
  });

  it('broker-panel.md marks nothing the code has as not built', () => {
    const table = read('docs/broker-panel.md');
    const rows = table
      .split('\n')
      .filter((line) => /^\|/.test(line) && /not built|no section/i.test(line));
    for (const row of rows) {
      const claimed = FEATURES.filter((feature) => feature.pattern.test(row));
      for (const feature of claimed) {
        expect(
          feature.built(),
          `${feature.name} is marked not built in broker-panel.md but the code has it`,
        ).toBe(false);
      }
    }
  });
});
