import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DELIBERATELY_UNSCOPED_MODELS, TENANT_SCOPED_MODELS } from './tenant-scope';

/**
 * The scoped-model list is written by hand, and a hand-written list of things
 * that must be protected is a list that will one day be missing an entry.
 *
 * So it is checked against the schema. A model added with a `tenantId` and not
 * added here would be silently unprotected by the extension — the exact failure
 * this test exists to make loud.
 */
const schema = readFileSync('prisma/schema.prisma', 'utf8');

function modelsWithTenantId(): string[] {
  const found: string[] = [];
  for (const block of schema.split(/^model /m).slice(1)) {
    const name = block.slice(0, block.indexOf(' '));
    const body = block.slice(0, block.indexOf('\n}'));
    if (/^\s+tenantId\s/m.test(body)) found.push(name);
  }
  return found.sort();
}

describe('the tenant-scoped model list', () => {
  it('covers every model in the schema that carries a tenantId', () => {
    const inSchema = modelsWithTenantId();
    const accountedFor = new Set([...TENANT_SCOPED_MODELS, ...DELIBERATELY_UNSCOPED_MODELS]);

    const unprotected = inSchema.filter((model) => !accountedFor.has(model));
    expect(
      unprotected,
      'these models carry a tenantId and nothing scopes them: add them to TENANT_SCOPED_MODELS, ' +
        'or to DELIBERATELY_UNSCOPED_MODELS with a comment saying why',
    ).toEqual([]);
  });

  it('claims no model the schema does not have', () => {
    const inSchema = new Set(modelsWithTenantId());
    const phantom = [...TENANT_SCOPED_MODELS, ...DELIBERATELY_UNSCOPED_MODELS].filter(
      (model) => !inSchema.has(model),
    );
    expect(phantom, 'these are scoped but have no tenantId in the schema').toEqual([]);
  });

  it('leaves the instrument catalogue global, on purpose', () => {
    /**
     * An instrument is a fact about the world. XAUUSD has a contract size of
     * 100 whoever is trading it, its sessions are the market's, and its price
     * history is one history. Copying that per tenant would be N platforms
     * rather than one platform with N tenants.
     */
    for (const global of ['Symbol', 'SymbolSpec', 'MarketSession', 'Candle']) {
      expect(TENANT_SCOPED_MODELS.has(global), `${global} should be global`).toBe(false);
      expect(modelsWithTenantId()).not.toContain(global);
    }
  });

  it('leaves SystemSetting out, because null there means the platform', () => {
    // The kill switch has to see the platform-wide row as well as its own, so
    // "give me my tenant's rows" is the wrong query for this one model.
    expect(TENANT_SCOPED_MODELS.has('SystemSetting')).toBe(false);
    expect(DELIBERATELY_UNSCOPED_MODELS.has('SystemSetting')).toBe(true);
  });
});
