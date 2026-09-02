import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { DomainError, Permission, TradingErrorCode, UserRole } from '@tp/shared-types';
import { permissionsFor } from '@tp/shared-types';
import { PermissionsGuard } from './permissions.guard';
import { RequirePermissions } from '../decorators/permissions.decorator';
import type { RolesService } from '../../permissions/roles.service';
import type { CredentialsService } from '../../credentials/credentials.service';
import { withTenant } from '@tp/tenancy';

/** Refusals are counted against the request's tenant, which a real request always has. */
const inScope = <T>(fn: () => Promise<T>) =>
  withTenant({ tenantId: '00000000-0000-4000-8000-0000000000ff', slug: 'test' }, fn);

/**
 * The guard is the only thing standing between a declaration and an actual
 * refusal, and it is worth testing on its own for a specific reason: the
 * catalogue tests prove `roleHasPermissions` computes the right answer, and the
 * coverage test proves every mutating route declares something, but neither
 * notices if the guard stops consulting either one. Emptying the guard's check
 * left all 205 API tests passing until this file existed.
 *
 * These tests drive a real `Reflector` over a really-decorated class rather
 * than a stubbed one, so a decorator that wrote its metadata under a different
 * key than the guard reads would fail here rather than in production.
 */

class Routes {
  @RequirePermissions(Permission.POSITIONS_CLOSE)
  close(): void {}

  /** SUPPORT holds the first of these and not the second — a partial hold. */
  @RequirePermissions(Permission.POSITIONS_READ, Permission.POSITIONS_CLOSE)
  readAndClose(): void {}

  @RequirePermissions()
  declaredEmpty(): void {}

  undeclared(): void {}
}

function contextFor(
  method: keyof Routes,
  user?: {
    role: string;
    principal?: 'session' | 'api_key' | 'service_token';
    credentialId?: string;
    permissions?: ReadonlySet<string>;
  },
): ExecutionContext {
  const handler = Routes.prototype[method];
  return {
    getHandler: () => handler,
    getClass: () => Routes,
    switchToHttp: () => ({
      getRequest: () => ({
        user:
          user === undefined
            ? undefined
            : { principal: 'session', ...user, id: 'u1', email: 'u@t', sessionId: 's1' },
      }),
    }),
  } as unknown as ExecutionContext;
}

/**
 * Grants now come from `RolesService`, which reads rows. This stands in for it
 * with the compile-time defaults, which is exactly what a freshly seeded tenant
 * holds — so every expectation below still describes the shipped configuration,
 * and what is being tested is the guard rather than the database.
 *
 * `asked` records what the guard looked up. A guard that stopped consulting the
 * service at all would otherwise pass every one of these by returning true.
 */
function rolesStub(): RolesService & { asked: string[] } {
  const asked: string[] = [];
  const service = {
    asked,
    permissionsFor: (roleKey: string): Promise<ReadonlySet<Permission>> => {
      asked.push(roleKey);
      return Promise.resolve(new Set(permissionsFor(roleKey as UserRole)));
    },
  };
  return service as unknown as RolesService & { asked: string[] };
}

/** Counts refusals the way the real service does, so a test can see them. */
function credentialsStub(): CredentialsService & { refusals: string[] } {
  const refusals: string[] = [];
  const service = {
    refusals,
    noteRefusal: (kind: string, credentialId: string) => {
      refusals.push(`${kind}:${credentialId}`);
    },
  };
  return service as unknown as CredentialsService & { refusals: string[] };
}

function guard(
  roles: RolesService = rolesStub(),
  credentials: CredentialsService = credentialsStub(),
): PermissionsGuard {
  return new PermissionsGuard(new Reflector(), roles, credentials);
}

describe('PermissionsGuard', () => {
  it('refuses a role that does not carry the declared permission', async () => {
    await expect(
      guard().canActivate(contextFor('close', { role: UserRole.SUPPORT })),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it('allows a role that carries it', async () => {
    await expect(guard().canActivate(contextFor('close', { role: UserRole.USER }))).resolves.toBe(
      true,
    );
  });

  /**
   * The point of the phase: the answer comes from the grant service, not from a
   * constant the guard could read itself. A guard that stopped asking would
   * still pass every other test here, because the stub returns the same sets the
   * constants do.
   */
  it('asks the grant service which capabilities the role carries', async () => {
    const roles = rolesStub();
    await guard(roles).canActivate(contextFor('close', { role: UserRole.USER }));
    expect(roles.asked).toEqual([UserRole.USER]);
  });

  it('follows the grant service rather than the compile-time defaults', async () => {
    const narrowed = {
      permissionsFor: () => Promise.resolve(new Set<Permission>()),
    } as unknown as RolesService;
    await expect(
      guard(narrowed).canActivate(contextFor('close', { role: UserRole.USER })),
    ).rejects.toBeInstanceOf(DomainError);

    const widened = {
      permissionsFor: () => Promise.resolve(new Set([Permission.POSITIONS_CLOSE])),
    } as unknown as RolesService;
    await expect(
      guard(widened).canActivate(contextFor('close', { role: UserRole.ADMIN })),
    ).resolves.toBe(true);
  });

  /**
   * ADMIN is the interesting case: it is the most powerful role in the system
   * and still must not be able to close somebody else's position. Trading on
   * another person's account is operator work granted per master-account link,
   * not something an administrator inherits by being an administrator.
   */
  it('refuses ADMIN a trading capability ADMIN does not hold', async () => {
    await expect(
      guard().canActivate(contextFor('close', { role: UserRole.ADMIN })),
    ).rejects.toBeInstanceOf(DomainError);
  });

  /**
   * The declaration is `and`, not `or`. SUPPORT carries `positions.read` and
   * not `positions.close`, so a route needing both must refuse it — holding
   * half of what a route requires is not a partial permit to run it.
   */
  it('requires every declared permission, not just one of them', async () => {
    await expect(
      guard().canActivate(contextFor('readAndClose', { role: UserRole.OPERATOR })),
    ).resolves.toBe(true);
    await expect(
      guard().canActivate(contextFor('readAndClose', { role: UserRole.SUPPORT })),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it('names only the permissions that are actually missing', async () => {
    const thrown = await guard()
      .canActivate(contextFor('readAndClose', { role: UserRole.SUPPORT }))
      .then(
        () => undefined,
        (error: unknown) => error as DomainError,
      );
    expect(thrown?.code).toBe(TradingErrorCode.FORBIDDEN);
    expect(thrown?.message).toContain(Permission.POSITIONS_CLOSE);
    // SUPPORT does hold positions.read; a refusal that listed it would send an
    // operator to ask for a capability they already have.
    expect(thrown?.message).not.toContain(Permission.POSITIONS_READ);
  });

  it('refuses an unauthenticated request before consulting the role', async () => {
    const roles = rolesStub();
    const thrown = await guard(roles)
      .canActivate(contextFor('close', undefined))
      .then(
        () => undefined,
        (error: unknown) => error as DomainError,
      );
    expect(thrown?.code).toBe(TradingErrorCode.UNAUTHENTICATED);
    // And it did not reach the database to find that out.
    expect(roles.asked).toEqual([]);
  });

  /**
   * An unknown role must fail closed. A role string that reaches the guard
   * without a catalogue entry — a stale JWT after a role is renamed, say — is a
   * bug, and the safe reading of a bug is "holds nothing".
   */
  it('refuses a role that is not in the catalogue at all', async () => {
    await expect(
      guard().canActivate(contextFor('close', { role: 'GOD_MODE' })),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it('lets a route through when it declares nothing', async () => {
    const roles = rolesStub();
    await expect(
      guard(roles).canActivate(contextFor('undeclared', { role: UserRole.USER })),
    ).resolves.toBe(true);
    await expect(
      guard(roles).canActivate(contextFor('declaredEmpty', { role: UserRole.USER })),
    ).resolves.toBe(true);
    // A route that declares nothing must not cost a lookup on every request.
    expect(roles.asked).toEqual([]);
  });

  /**
   * A credential's capabilities are the set the auth guard attached, not the
   * role's. The role is still on the principal — it is the holder's — and a
   * guard that fell back to it would give every key everything its holder has,
   * which is exactly what "per-key permissions" exists to prevent.
   */
  describe('with an API key', () => {
    const key = (permissions: string[]) => ({
      role: UserRole.USER,
      principal: 'api_key' as const,
      credentialId: 'k1',
      permissions: new Set(permissions),
    });

    it('allows what the key carries', async () => {
      await expect(
        guard().canActivate(contextFor('close', key([Permission.POSITIONS_CLOSE]))),
      ).resolves.toBe(true);
    });

    it('refuses what the key does not carry, though the holder does, and counts it', async () => {
      const roles = rolesStub();
      const credentials = credentialsStub();
      const thrown = await inScope(() =>
        guard(roles, credentials).canActivate(
          contextFor('close', key([Permission.POSITIONS_READ])),
        ),
      ).then(
        () => undefined,
        (error: unknown) => error as DomainError,
      );
      expect(thrown?.code).toBe(TradingErrorCode.FORBIDDEN);
      expect(thrown?.message).toContain('this credential does not carry');
      expect(roles.asked).toEqual([]);
      expect(credentials.refusals).toEqual(['api_key:k1']);
    });

    it('refuses a route that declares nothing — those are a person’s', async () => {
      const credentials = credentialsStub();
      await expect(
        inScope(() =>
          guard(rolesStub(), credentials).canActivate(
            contextFor('undeclared', key([Permission.POSITIONS_CLOSE])),
          ),
        ),
      ).rejects.toBeInstanceOf(DomainError);
      await expect(
        inScope(() =>
          guard(rolesStub(), credentials).canActivate(
            contextFor('declaredEmpty', key([Permission.POSITIONS_CLOSE])),
          ),
        ),
      ).rejects.toBeInstanceOf(DomainError);
      expect(credentials.refusals).toHaveLength(2);
    });

    it('treats a principal with no permission set as holding nothing', async () => {
      await expect(
        guard().canActivate(
          contextFor('close', { role: UserRole.USER, principal: 'api_key', credentialId: 'k1' }),
        ),
      ).rejects.toBeInstanceOf(DomainError);
    });
  });

  describe('with a service token', () => {
    it('is bounded by the token’s set and never by a role', async () => {
      const roles = rolesStub();
      await expect(
        guard(roles).canActivate(
          contextFor('close', {
            role: 'SERVICE',
            principal: 'service_token',
            credentialId: 't1',
            permissions: new Set([Permission.POSITIONS_CLOSE]),
          }),
        ),
      ).resolves.toBe(true);
      await expect(
        guard(roles).canActivate(
          contextFor('close', {
            role: 'SERVICE',
            principal: 'service_token',
            credentialId: 't1',
            permissions: new Set([Permission.ACCOUNTS_READ_ANY]),
          }),
        ),
      ).rejects.toBeInstanceOf(DomainError);
      expect(roles.asked).toEqual([]);
    });
  });
});
