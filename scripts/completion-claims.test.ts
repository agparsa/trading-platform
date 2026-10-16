import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * COMPLETION_STATUS's "Partial" and "Does not exist — zero code" tables,
 * checked against the code.
 *
 * On 16 October the "zero code" table still listed webhooks, KYC, the
 * Security Centre and wallets — each with its own model, controller, admin
 * screen and browser check, in production for weeks — and the admin panel was
 * "13 sections" with 21 deployed. The tables had been written on 3 September
 * and nothing compared them to anything since. The same thing had already
 * happened once to the broker panel's list (`panel-claims.test.ts`).
 *
 * So each claim the tables can make is paired with the code that decides it:
 * the "zero code" table must name exactly the absent ones — a built feature
 * listed as absent fails, and an absent one dropped from the list fails too —
 * and the admin panel's section count is the number of section pages.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(resolve(ROOT, relative), 'utf8');
const exists = (relative: string) => existsSync(resolve(ROOT, relative));

const STATUS = read('docs/COMPLETION_STATUS.md');
const SCHEMA = read('prisma/schema.prisma');
const model = (name: string) => new RegExp(`^model ${name} \\{`, 'm').test(SCHEMA);

/** The text of a `## ` section, up to the next one. */
export function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`## ${heading}\n`);
  if (start < 0) return '';
  const next = markdown.indexOf('\n## ', start + 1);
  return markdown.slice(start, next < 0 ? undefined : next);
}

/** The table rows of a section — not its prose, which may mention anything. */
export function tableRows(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('|') && !/^\|\s*-/.test(line))
    .slice(1);
}

interface Absence {
  readonly name: string;
  readonly pattern: RegExp;
  /** Read from the code: is it still missing? */
  readonly absent: () => boolean;
}

const ABSENCES: readonly Absence[] = [
  {
    name: 'Webhooks',
    pattern: /\bWebhooks?\b/,
    absent: () =>
      !model('WebhookEndpoint') || !exists('apps/api/src/webhooks/webhooks.controller.ts'),
  },
  {
    name: 'KYC',
    pattern: /\bKYC\b/,
    absent: () => !model('KycRecord') || !exists('apps/api/src/kyc'),
  },
  {
    name: 'Security Centre',
    pattern: /Security Centre/,
    absent: () => !exists('apps/web/src/app/admin/security/page.tsx'),
  },
  {
    name: 'Wallet / payments',
    pattern: /\bWallet\b/,
    absent: () => !model('Wallet') || !model('WalletTransaction'),
  },
  {
    name: 'AI context layer',
    pattern: /AI context layer/,
    absent: () => !exists('apps/api/src/ai') && !/^model Ai[A-Z]/m.test(SCHEMA),
  },
  {
    name: 'Real market data',
    pattern: /Real market data/,
    // The boundary refuses on boot for any provider but the simulator.
    absent: () => /has no adapter yet/.test(read('apps/api/src/market/market-feed.service.ts')),
  },
];

function adminSections(): string[] {
  const dir = resolve(ROOT, 'apps/web/src/app/admin');
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(resolve(dir, entry.name, 'page.tsx')))
    .map((entry) => entry.name)
    .sort();
}

describe('COMPLETION_STATUS against the code', () => {
  const zero = tableRows(section(STATUS, 'Does not exist — zero code')).join('\n');
  const partial = tableRows(section(STATUS, 'Partial'));

  it('finds both tables, so this test is checking something', () => {
    expect(zero).not.toBe('');
    expect(partial.length).toBeGreaterThan(0);
  });

  it('lists as "zero code" exactly what the code lacks', () => {
    const wrong = ABSENCES.flatMap((claim) => {
      const listed = claim.pattern.test(zero);
      const absent = claim.absent();
      if (listed && !absent) return [`${claim.name} is listed as zero code but is built`];
      if (!listed && absent) return [`${claim.name} is absent but not listed`];
      return [];
    });
    expect(wrong).toEqual([]);
  });

  it("counts and names the admin panel's sections as they are deployed", () => {
    const row = partial.find((line) => /Admin panel/.test(line)) ?? '';
    const sections = adminSections();
    expect(/(\d+) sections/.exec(row)?.[1]).toBe(String(sections.length));
    const missing = sections.filter((name) => !new RegExp(`\\b${name}\\b`, 'i').test(row));
    expect(missing).toEqual([]);
  });

  /**
   * §45's missing documents are missing because their features are. One that
   * has a feature and a document is not missing.
   */
  it('calls a document missing only while its feature is absent', () => {
    const line = /^Missing: .*$/m.exec(section(STATUS, 'Documentation (§45)'))?.[0] ?? '';
    expect(line).not.toBe('');
    const documented = {
      TOKEN_MANAGEMENT: exists('docs/api-keys.md') && model('ServiceToken'),
      AI_CONTEXT: exists('apps/api/src/ai'),
    };
    const wrong = Object.entries(documented)
      .filter(([name, built]) => built && line.includes(name))
      .map(([name]) => name);
    expect(wrong).toEqual([]);
  });

  it('reads table rows, not the prose around them', () => {
    const text = '## X\n\nWebhooks were absent once.\n\n| a | b |\n| - | - |\n| 1 | KYC |\n';
    expect(tableRows(section(text, 'X'))).toEqual(['| 1 | KYC |']);
  });
});
