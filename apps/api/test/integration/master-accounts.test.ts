import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { DomainError, Permission, TradingErrorCode } from '@tp/shared-types';
import { AuditService } from '../../src/common/audit/audit.service';
import { MetricsService } from '../../src/metrics/metrics.service';
import { RealtimeGateway } from '../../src/realtime/realtime.gateway';
import { initialState, type TradingSocket } from '../../src/realtime/socket.types';
import { MasterAccountsService } from '../../src/master/master-accounts.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  createAccount,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
  seedTradingSymbols,
  DEFAULT_TENANT_ID,
} from './harness';
import { buildTradingStack, type TradingStack } from './trading-stack';

const suite = hasTestDatabase ? describe : describe.skip;

const BID = '4583.58';
const ASK = '4583.72';

/**
 * Master accounts, and the one rule they exist to respect.
 *
 * The specification states it as: no master account may reach another account
 * merely by knowing its id. That is not a property of the master-account
 * feature; it is a property of the resolver, and these tests attack it from the
 * outside — a real master, a real account, a real id, and no link.
 */
suite('Master accounts (integration)', () => {
  let prisma: PrismaClient;
  let stack: TradingStack;
  let masters: MasterAccountsService;

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
    masters = new MasterAccountsService(
      prisma as unknown as PrismaService,
      new AuditService(prisma as unknown as PrismaService),
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await prisma.marketSession.deleteMany();
    await prisma.symbolSpec.deleteMany();
    await prisma.symbol.deleteMany();
    await seedTradingSymbols(prisma);
    stack = await buildTradingStack(prisma);
    await stack.publishQuote('XAUUSD', BID, ASK);
  });

  /** An admin, an operator with a master account, and two unrelated traders. */
  async function world() {
    const admin = await createAccount(prisma, { email: `admin-${Date.now()}@test.local` });
    const operator = await createAccount(prisma, { email: `operator-${Date.now()}@test.local` });
    const alice = await createAccount(prisma, {
      balance: '100000',
      email: `alice-${Date.now()}@test.local`,
    });
    const bob = await createAccount(prisma, {
      balance: '100000',
      email: `bob-${Date.now()}@test.local`,
    });
    const master = await masters.create(admin.userId, {
      operatorUserId: operator.userId,
      name: 'Desk One',
    });
    return { admin, operator, alice, bob, master };
  }

  async function codeOf(action: () => Promise<unknown>): Promise<string> {
    try {
      await action();
    } catch (error) {
      if (error instanceof DomainError) return error.code;
      throw error;
    }
    throw new Error('the operation succeeded — it should have been refused');
  }

  /**
   * The headline constraint. The operator has a master account, the account
   * exists, and the operator holds its id — which is exactly the situation a
   * leaked id creates. Without a link that must be worth nothing.
   */
  it('a master account reaches nothing it has no link to', async () => {
    const { operator, alice, bob, master } = await world();
    await masters.grantLink(operator.userId, master.id, {
      accountId: alice.accountId,
      capabilities: [Permission.ACCOUNTS_READ, Permission.POSITIONS_READ],
    });

    // Linked: reachable.
    const granted = await stack.access.resolve(
      operator.userId,
      alice.accountId,
      Permission.POSITIONS_READ,
    );
    expect(granted.via).toBe('MASTER_LINK');

    // Not linked, same operator, same master account, real id: unreachable,
    // and indistinguishable from an account that does not exist.
    expect(
      await codeOf(() =>
        stack.access.resolve(operator.userId, bob.accountId, Permission.POSITIONS_READ),
      ),
    ).toBe(TradingErrorCode.RESOURCE_NOT_FOUND);
  });

  /**
   * A link belongs to one master account. Somebody else's delegation is not a
   * delegation to you, and operating a master account of your own does not make
   * you a party to anyone else's.
   */
  it("does not lend one master's link to another master, or to a stranger", async () => {
    const { operator, alice, master } = await world();
    await masters.grantLink(operator.userId, master.id, {
      accountId: alice.accountId,
      capabilities: [Permission.POSITIONS_READ],
    });

    const rival = await createAccount(prisma, { email: `rival-${Date.now()}@test.local` });
    await masters.create(operator.userId, {
      operatorUserId: rival.userId,
      name: 'Desk Two',
    });
    const stranger = await createAccount(prisma, { email: `stranger-${Date.now()}@test.local` });

    for (const outsider of [rival, stranger]) {
      expect(
        await codeOf(() =>
          stack.access.resolve(outsider.userId, alice.accountId, Permission.POSITIONS_READ),
        ),
      ).toBe(TradingErrorCode.RESOURCE_NOT_FOUND);
    }
  });

  /**
   * A link is a list of capabilities, not a role. This is the case that makes
   * the `needs` argument load-bearing: the operator is inside the account and
   * still cannot do the thing the link does not name.
   */
  it('grants exactly the capabilities the link lists, and no more', async () => {
    const { operator, alice, master } = await world();
    await masters.grantLink(operator.userId, master.id, {
      accountId: alice.accountId,
      capabilities: [Permission.POSITIONS_READ],
    });

    await expect(
      stack.access.resolve(operator.userId, alice.accountId, Permission.POSITIONS_READ),
    ).resolves.toBeDefined();

    // Reading is permitted, closing is not — and the refusal names why rather
    // than pretending the account is missing, because the operator can plainly
    // see that it is not.
    expect(
      await codeOf(() =>
        stack.access.resolve(operator.userId, alice.accountId, Permission.POSITIONS_CLOSE),
      ),
    ).toBe(TradingErrorCode.FORBIDDEN);
  });

  it('lets a link that grants trading actually trade, on the real path', async () => {
    const { operator, alice, master } = await world();
    await masters.grantLink(operator.userId, master.id, {
      accountId: alice.accountId,
      capabilities: [
        Permission.ORDERS_CREATE,
        Permission.POSITIONS_READ,
        Permission.POSITIONS_CLOSE,
      ],
    });

    const opened = await stack.orders.openPosition(operator.userId, {
      accountId: alice.accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '1',
    });
    expect(opened.positionId).not.toBeNull();

    // The position belongs to Alice's account, not to the operator.
    const stored = await prisma.position.findUniqueOrThrow({
      where: { id: opened.positionId as string },
    });
    expect(stored.accountId).toBe(alice.accountId);

    await expect(
      stack.positions.close(operator.userId, opened.positionId as string, null),
    ).resolves.toBeDefined();
  });

  it('stops the moment the link is revoked', async () => {
    const { operator, alice, master } = await world();
    await masters.grantLink(operator.userId, master.id, {
      accountId: alice.accountId,
      capabilities: [Permission.POSITIONS_READ],
    });
    await expect(
      stack.access.resolve(operator.userId, alice.accountId, Permission.POSITIONS_READ),
    ).resolves.toBeDefined();

    await masters.revokeLink(operator.userId, master.id, alice.accountId);

    expect(
      await codeOf(() =>
        stack.access.resolve(operator.userId, alice.accountId, Permission.POSITIONS_READ),
      ),
    ).toBe(TradingErrorCode.RESOURCE_NOT_FOUND);
  });

  /**
   * Suspending a master must stop every link it holds at once. An operator
   * whose access is being withdrawn in an incident cannot be switched off one
   * account at a time.
   */
  it('suspending the master stops all of its links together', async () => {
    const { operator, alice, bob, master } = await world();
    for (const account of [alice, bob]) {
      await masters.grantLink(operator.userId, master.id, {
        accountId: account.accountId,
        capabilities: [Permission.POSITIONS_READ],
      });
    }
    await prisma.masterAccount.update({ where: { id: master.id }, data: { status: 'SUSPENDED' } });

    for (const account of [alice, bob]) {
      expect(
        await codeOf(() =>
          stack.access.resolve(operator.userId, account.accountId, Permission.POSITIONS_READ),
        ),
      ).toBe(TradingErrorCode.RESOURCE_NOT_FOUND);
    }
  });

  it('refuses to delegate a capability no link may carry', async () => {
    const { operator, alice, master } = await world();

    expect(
      await codeOf(() =>
        masters.grantLink(operator.userId, master.id, {
          accountId: alice.accountId,
          capabilities: [Permission.POSITIONS_READ, Permission.SYSTEM_KILL_SWITCH],
        }),
      ),
    ).toBe(TradingErrorCode.VALIDATION_FAILED);

    // And refused entirely, not silently narrowed: a caller told the grant
    // succeeded would believe the operator had a capability they do not.
    expect(
      await codeOf(() =>
        stack.access.resolve(operator.userId, alice.accountId, Permission.POSITIONS_READ),
      ),
    ).toBe(TradingErrorCode.RESOURCE_NOT_FOUND);
  });

  /**
   * The ceiling is applied when the grant is read as well as when it is
   * written, so a row that reached the table some other way — a manual fix, a
   * restored backup, a migration written before the ceiling existed — cannot
   * confer what no request could have asked for.
   */
  it('ignores an un-delegatable capability already sitting in the table', async () => {
    const { operator, alice, master } = await world();
    await masters.grantLink(operator.userId, master.id, {
      accountId: alice.accountId,
      capabilities: [Permission.POSITIONS_READ],
    });
    await prisma.masterAccountLink.updateMany({
      where: { masterAccountId: master.id, accountId: alice.accountId },
      data: { capabilities: [Permission.POSITIONS_READ, Permission.SYSTEM_KILL_SWITCH] },
    });

    const grant = await stack.access.resolve(
      operator.userId,
      alice.accountId,
      Permission.POSITIONS_READ,
    );
    expect(grant.capabilities.has(Permission.SYSTEM_KILL_SWITCH)).toBe(false);
  });

  it('records who granted and who revoked, and keeps the revoked link', async () => {
    const { admin, operator, alice, master } = await world();
    await masters.grantLink(admin.userId, master.id, {
      accountId: alice.accountId,
      capabilities: [Permission.POSITIONS_READ],
    });
    await masters.revokeLink(operator.userId, master.id, alice.accountId);

    const links = await masters.links(master.id);
    expect(links).toHaveLength(1);
    expect(links[0]?.status).toBe('REVOKED');
    expect(links[0]?.grantedByUserId).toBe(admin.userId);
    expect(links[0]?.revokedAt).not.toBeNull();

    const actions = await prisma.auditLog.findMany({
      where: { resourceType: 'MasterAccountLink' },
      orderBy: { createdAt: 'asc' },
    });
    expect(actions.map((row) => row.action)).toEqual([
      'master_link.granted',
      'master_link.revoked',
    ]);
    expect(actions[1]?.actorId).toBe(operator.userId);
  });

  it('refuses to delegate an account to the operator who already owns it', async () => {
    const { operator, master } = await world();
    const own = await prisma.account.findFirstOrThrow({ where: { userId: operator.userId } });

    expect(
      await codeOf(() =>
        masters.grantLink(operator.userId, master.id, {
          accountId: own.id,
          capabilities: [Permission.POSITIONS_READ],
        }),
      ),
    ).toBe(TradingErrorCode.VALIDATION_FAILED);
  });

  /**
   * The socket's private-frame set has to agree with the resolver, or an
   * operator would be refused an account over REST while watching its fills
   * stream past — or, far worse, the other way round. It is built by separate
   * code in the gateway, so it gets its own case against a real database.
   */
  it('streams a linked account to the operator socket, and nothing else', async () => {
    const { operator, alice, bob, master } = await world();
    await masters.grantLink(operator.userId, master.id, {
      accountId: alice.accountId,
      capabilities: [Permission.POSITIONS_READ],
    });

    /**
     * Somebody else's delegation, present in the same table. Without it the
     * "not streamed" assertion below would hold for an account nobody had
     * linked at all, which proves nothing: a gateway that forgot to ask *whose*
     * link it was would still pass. This is the row that makes it fail.
     */
    const rival = await createAccount(prisma, { email: `rival-ws-${Date.now()}@test.local` });
    const rivalMaster = await masters.create(operator.userId, {
      operatorUserId: rival.userId,
      name: 'Desk Two',
    });
    await masters.grantLink(rival.userId, rivalMaster.id, {
      accountId: bob.accountId,
      capabilities: [Permission.POSITIONS_READ],
    });

    const gateway = new RealtimeGateway(
      {
        verifyAccessToken: async () => ({ sub: operator.userId, tid: DEFAULT_TENANT_ID }),
      } as never,
      prisma as unknown as PrismaService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      new MetricsService(),
      { forHost: async () => ({ tenantId: DEFAULT_TENANT_ID, slug: 'test-tenant' }) } as never,
    );
    const socket = {
      state: initialState(),
      handshake: { auth: { token: 'stand-in-for-a-real-token' }, headers: {} },
      emit: () => true,
    } as unknown as TradingSocket;

    await gateway.handleConnection(socket);

    const own = await prisma.account.findFirstOrThrow({ where: { userId: operator.userId } });
    expect(socket.state.accountIds.has(own.id)).toBe(true);
    expect(socket.state.accountIds.has(alice.accountId)).toBe(true);
    // Linked, but to somebody else's master: not streamed.
    expect(socket.state.accountIds.has(bob.accountId)).toBe(false);

    await masters.revokeLink(operator.userId, master.id, alice.accountId);
    const afterRevoke = {
      state: initialState(),
      handshake: { auth: { token: 'stand-in-for-a-real-token' }, headers: {} },
      emit: () => true,
    } as unknown as TradingSocket;
    await gateway.handleConnection(afterRevoke);
    expect(afterRevoke.state.accountIds.has(alice.accountId)).toBe(false);
  });

  /**
   * Ownership is not weakened by any of this. The owner keeps everything an
   * owner has, whether or not somebody else has been delegated part of it.
   */
  it('leaves the owner exactly as they were', async () => {
    const { operator, alice, master } = await world();
    await masters.grantLink(operator.userId, master.id, {
      accountId: alice.accountId,
      capabilities: [Permission.POSITIONS_READ],
    });

    const grant = await stack.access.resolve(
      alice.userId,
      alice.accountId,
      Permission.POSITIONS_CLOSE,
    );
    expect(grant.via).toBe('OWNER');
    expect(grant.linkId).toBeNull();
  });
});
