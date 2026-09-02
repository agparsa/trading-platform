import { describe, expect, it } from 'vitest';
import {
  currentScope,
  currentTenant,
  enterTenantScope,
  outsideAnyScope,
  requireTenantId,
  withTenant,
  withoutTenantScope,
} from './context';

const FIRM = { tenantId: '00000000-0000-4000-8000-000000000001', slug: 'firm' };

describe('outsideAnyScope', () => {
  it('drops a scope entered with withTenant, and gives it back afterwards', async () => {
    await withTenant(FIRM, async () => {
      expect(currentTenant()).toEqual(FIRM);
      const inside = await outsideAnyScope(() => currentScope());
      expect(inside).toBeUndefined();
      expect(currentTenant()).toEqual(FIRM);
    });
  });

  it('drops a scope entered for the rest of the context, which is what a test harness uses', async () => {
    await withTenant(FIRM, async () => {
      // A nested `enterWith` so the outer test's own context is not polluted.
      enterTenantScope({ tenantId: FIRM.tenantId, slug: 'entered' });
      expect(currentTenant()?.slug).toBe('entered');
      await outsideAnyScope(async () => {
        expect(() => requireTenantId()).toThrow(/No tenant in scope/);
      });
      expect(currentTenant()?.slug).toBe('entered');
    });
  });

  it('drops a cross-tenant marker too: outside is outside', async () => {
    await withoutTenantScope('a test', async () => {
      expect(currentScope()).toMatchObject({ crossTenant: true });
      expect(await outsideAnyScope(() => currentScope())).toBeUndefined();
    });
  });

  it('starts a scope opened inside it, and only inside it', async () => {
    await withTenant(FIRM, async () => {
      const seen = await outsideAnyScope(() =>
        withTenant({ tenantId: FIRM.tenantId, slug: 'own' }, () => currentTenant()?.slug),
      );
      expect(seen).toBe('own');
      expect(currentTenant()).toEqual(FIRM);
    });
  });
});
