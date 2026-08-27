import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { DomainError, Permission, TradingErrorCode, UserRole } from '@tp/shared-types';
import { PermissionsGuard } from './permissions.guard';
import { RequirePermissions } from '../decorators/permissions.decorator';

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

function contextFor(method: keyof Routes, user?: { role: string }): ExecutionContext {
  const handler = Routes.prototype[method];
  return {
    getHandler: () => handler,
    getClass: () => Routes,
    switchToHttp: () => ({
      getRequest: () => ({
        user: user === undefined ? undefined : { ...user, id: 'u1', email: 'u@t' },
      }),
    }),
  } as unknown as ExecutionContext;
}

function guard(): PermissionsGuard {
  return new PermissionsGuard(new Reflector());
}

describe('PermissionsGuard', () => {
  it('refuses a role that does not carry the declared permission', () => {
    let thrown: unknown;
    try {
      guard().canActivate(contextFor('close', { role: UserRole.SUPPORT }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    expect((thrown as DomainError).code).toBe(TradingErrorCode.FORBIDDEN);
  });

  it('allows a role that carries it', () => {
    expect(guard().canActivate(contextFor('close', { role: UserRole.USER }))).toBe(true);
  });

  /**
   * ADMIN is the interesting case: it is the most powerful role in the system
   * and still must not be able to close somebody else's position. Trading on
   * another person's account is operator work granted per master-account link,
   * not something an administrator inherits by being an administrator.
   */
  it('refuses ADMIN a trading capability ADMIN does not hold', () => {
    expect(() => guard().canActivate(contextFor('close', { role: UserRole.ADMIN }))).toThrow(
      DomainError,
    );
  });

  /**
   * The declaration is `and`, not `or`. SUPPORT carries `positions.read` and
   * not `positions.close`, so a route needing both must refuse it — holding
   * half of what a route requires is not a partial permit to run it.
   */
  it('requires every declared permission, not just one of them', () => {
    expect(guard().canActivate(contextFor('readAndClose', { role: UserRole.OPERATOR }))).toBe(true);
    expect(() =>
      guard().canActivate(contextFor('readAndClose', { role: UserRole.SUPPORT })),
    ).toThrow(DomainError);
  });

  it('names only the permissions that are actually missing', () => {
    let thrown: DomainError | undefined;
    try {
      guard().canActivate(contextFor('close', { role: UserRole.SUPPORT }));
    } catch (error) {
      thrown = error as DomainError;
    }
    expect(thrown?.message).toContain(Permission.POSITIONS_CLOSE);
    // SUPPORT does hold positions.read; a refusal that listed it would send an
    // operator to ask for a capability they already have.
    expect(thrown?.message).not.toContain(Permission.POSITIONS_READ);
  });

  it('refuses an unauthenticated request before consulting the role', () => {
    let thrown: DomainError | undefined;
    try {
      guard().canActivate(contextFor('close', undefined));
    } catch (error) {
      thrown = error as DomainError;
    }
    expect(thrown?.code).toBe(TradingErrorCode.UNAUTHENTICATED);
  });

  /**
   * An unknown role must fail closed. A role string that reaches the guard
   * without a catalogue entry — a stale JWT after a role is renamed, say — is a
   * bug, and the safe reading of a bug is "holds nothing".
   */
  it('refuses a role that is not in the catalogue at all', () => {
    expect(() => guard().canActivate(contextFor('close', { role: 'GOD_MODE' }))).toThrow(
      DomainError,
    );
  });

  it('lets a route through when it declares nothing', () => {
    expect(guard().canActivate(contextFor('undeclared', { role: UserRole.USER }))).toBe(true);
    expect(guard().canActivate(contextFor('declaredEmpty', { role: UserRole.USER }))).toBe(true);
  });
});
