import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as shared from '@tp/shared-types';
import { CLIENT_APPS, ROOT } from './response-contracts';

/**
 * Every map a client keys by one of the platform's vocabularies — a status, a
 * kind, a category — names exactly that vocabulary.
 *
 * The trader's security feed words each event: `WORDING[row.kind] ?? row.kind`.
 * Five device events were added to the enum and not to the map, so the feed
 * showed `DEVICE_REGISTERED` — a WARNING, the event a person is meant to
 * recognise as not theirs — as its raw name. The phone's notification settings
 * did the same with `PRICE_ALERT`. A `Record<string, string>` compiles whatever
 * it holds, and the fallback hides the gap on screen.
 *
 * So each such map is found (keys in UPPER_SNAKE, two or more of them in one
 * vocabulary), must be named below with the vocabulary it words, and must
 * have exactly its values as keys — neither missing one nor wording one that
 * does not exist. A map found and not listed fails, so a new one is
 * classified when it is written.
 */
type Vocabulary = `prisma.${string}` | `shared.${string}`;

const MAPS: Readonly<Record<string, Vocabulary | { none: string }>> = {
  'apps/web/src/app/(app)/verification/page.tsx:KIND_LABELS': 'prisma.KycDocumentKind',
  'apps/web/src/app/(app)/verification/page.tsx:STATUS_TEXT': 'prisma.KycStatus',
  'apps/web/src/app/(app)/wallet/page.tsx:PAYMENT_STATUS_LABELS': 'prisma.PaymentStatus',
  'apps/web/src/app/(app)/wallet/page.tsx:WITHDRAWAL_STATUS_LABELS': 'prisma.WithdrawalStatus',
  'apps/web/src/components/api-keys-panel.tsx:STATUS_TONE': {
    none: "a key's status is derived (ACTIVE, REVOKED, EXPIRED) and typed as its row's union",
  },
  'apps/web/src/components/admin/credentials-panel.tsx:STATUS_TONE': {
    none: "the same derived key status as the trader's own panel",
  },
  'apps/web/src/components/security-events-panel.tsx:SEVERITY_TONE': 'prisma.SecuritySeverity',
  'apps/web/src/components/security-events-panel.tsx:WORDING': 'prisma.SecurityEventKind',
  'apps/web/src/components/admin/connections-panel.tsx:STATE_TONE': 'prisma.BrokerConnectionStatus',
  'apps/web/src/components/admin/connections-panel.tsx:STATE_WORDS':
    'prisma.BrokerConnectionStatus',
  'apps/web/src/components/admin/connections-panel.tsx:INBOX_TONE': 'prisma.InboundStatus',
  'apps/web/src/components/admin/kyc-panel.tsx:STATUS_TONE': 'prisma.KycStatus',
  'apps/web/src/components/admin/kyc-panel.tsx:KIND_LABELS': 'prisma.KycDocumentKind',
  'apps/web/src/components/admin/payments-panel.tsx:STATUS_TONE': 'prisma.PaymentStatus',
  'apps/web/src/components/admin/reconciliation-panel.tsx:STATUS_LABEL':
    'prisma.ReconciliationItemStatus',
  'apps/web/src/components/admin/reports-panel.tsx:STATUS_TEXT': 'prisma.ReportStatus',
  'apps/web/src/components/admin/reports-panel.tsx:STATUS_MEANS': 'prisma.ReportStatus',
  'apps/web/src/components/admin/webhooks-panel.tsx:STATUS_TONE': 'prisma.WebhookDeliveryStatus',
  'apps/web/src/components/admin/withdrawals-panel.tsx:STATUS_TONE': 'prisma.WithdrawalStatus',
  'apps/web/src/lib/market-state.ts:LABELS': 'shared.MARKET_STATES',
  'apps/mobile/src/app/(tabs)/history.tsx:REASON_LABEL': 'prisma.CloseReason',
  'apps/mobile/src/app/(tabs)/profile.tsx:KYC_LABELS': 'prisma.KycStatus',
  'apps/mobile/src/app/(tabs)/settings.tsx:LABELS': 'prisma.NotificationCategory',
};

function vocabularies(): Map<Vocabulary, Set<string>> {
  const found = new Map<Vocabulary, Set<string>>();
  const schema = readFileSync(`${ROOT}/prisma/schema.prisma`, 'utf8');
  for (const match of schema.matchAll(/^enum (\w+) \{([\s\S]*?)\n\}/gm)) {
    found.set(
      `prisma.${match[1]}`,
      new Set([...match[2]!.matchAll(/^\s+([A-Z][A-Z0-9_]*)\s*$/gm)].map((value) => value[1]!)),
    );
  }
  for (const [name, value] of Object.entries(shared)) {
    const values = Array.isArray(value)
      ? value
      : typeof value === 'object' && value !== null
        ? Object.values(value)
        : [];
    if (values.length > 0 && values.every((one) => typeof one === 'string')) {
      found.set(`shared.${name}`, new Set(values as string[]));
    }
  }
  return found;
}

interface KeyedMap {
  place: string;
  keys: string[];
}

function keyedMaps(known: Map<Vocabulary, Set<string>>): KeyedMap[] {
  const found: KeyedMap[] = [];
  for (const app of CLIENT_APPS) {
    for (const file of ts.sys
      .readDirectory(`${ROOT}/${app.sources}`, ['.ts', '.tsx'])
      .filter((path) => !/\.(test|spec)\.tsx?$/.test(path))) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node): void => {
        if (
          ts.isVariableDeclaration(node) &&
          node.initializer !== undefined &&
          ts.isObjectLiteralExpression(node.initializer)
        ) {
          const keys = node.initializer.properties.map((property) =>
            property.name !== undefined &&
            (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
              ? property.name.text
              : null,
          );
          if (
            keys.length >= 2 &&
            keys.every((key) => key !== null && /^[A-Z][A-Z0-9_]*$/.test(key))
          ) {
            const inOne = [...known.values()].some(
              (values) => keys.filter((key) => values.has(key!)).length >= 2,
            );
            if (inOne) {
              found.push({
                place: `${relative(ROOT, file)}:${node.name.getText(source)}`,
                keys: keys as string[],
              });
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return found;
}

describe("the clients' maps of the platform's vocabularies", () => {
  const known = vocabularies();
  const maps = keyedMaps(known);

  it('finds them (the probe that cannot fail is the one that never looked)', () => {
    expect(known.get('prisma.SecurityEventKind')?.has('DEVICE_REGISTERED')).toBe(true);
    expect(maps.length).toBeGreaterThan(15);
  });

  it('classifies every one', () => {
    expect(maps.filter((map) => MAPS[map.place] === undefined).map((map) => map.place)).toEqual([]);
  });

  it('lists nothing that is no longer there', () => {
    const places = new Set(maps.map((map) => map.place));
    expect(Object.keys(MAPS).filter((place) => !places.has(place))).toEqual([]);
  });

  it('words exactly the vocabulary it names', () => {
    const wrong: string[] = [];
    for (const map of maps) {
      const entry = MAPS[map.place];
      if (entry === undefined || typeof entry !== 'string') continue;
      const values = known.get(entry);
      if (values === undefined) {
        wrong.push(`${map.place}: no vocabulary called ${entry}`);
        continue;
      }
      const missing = [...values].filter((value) => !map.keys.includes(value));
      const extra = map.keys.filter((key) => !values.has(key));
      if (missing.length > 0) wrong.push(`${map.place}: does not word ${missing.join(', ')}`);
      if (extra.length > 0) wrong.push(`${map.place}: words ${extra.join(', ')}, not in ${entry}`);
    }
    expect(wrong).toEqual([]);
  });
});
