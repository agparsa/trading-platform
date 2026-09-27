/**
 * Reverse ledger entries from the host, when the panel cannot be used.
 *
 * The platform never edits a ledger row: a wrong entry is answered with a
 * compensating one, and the panel's `POST /admin/accounts/:id/adjustments`
 * with `compensatesId` is how an administrator posts it — behind
 * `accounts.adjust`, a live two-factor code, and a reason. That is the path.
 *
 * This is the path for the day it cannot be taken: a deployment with no
 * administrator yet, or a correction of a bug's own doing that the operator
 * would rather make from the host, where the bug was diagnosed, than type
 * seventeen times into a form. It is the same act — `LedgerService.compensate`,
 * the same lock, the same row shape — minus the actor it cannot have, and it
 * says so in the audit log: actor SYSTEM, the host and its user, the reason
 * given, and every entry it answered.
 *
 * What it refuses, each a decision:
 *  - an entry named twice, or already answered by a compensating entry: money
 *    is never reversed twice;
 *  - entries on more than one account in one run: a correction is about one
 *    account's story, and a list that spans two is two corrections;
 *  - a reversal that would take the account below zero, as the panel does;
 *  - anything at all without `--apply`: it prints what it would post, entry
 *    by entry with the net effect, and stops.
 *
 *   node apps/api/dist/cli/compensate-ledger-entries.js \
 *     --entry <id> [--entry <id> …] --reason "<why>" [--apply]
 *
 * `scripts/compensate-ledger-entries.sh` runs it inside the migrate image on a
 * host. The entry ids come from the ledger — `SELECT id … FROM balance_ledger`
 * or the panel's ledger view — and are named one by one on purpose: a
 * selector ("every SWAP row on the 1st") would reverse whatever it matched,
 * and a list is read before it is run.
 */
import { hostname, userInfo } from 'node:os';
import { PrismaClient } from '@prisma/client';
import { Money } from '@tp/financial-core';
import { withTenant } from '@tp/tenancy';
import { LedgerService } from '../accounts/ledger.service';

export class CompensationRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompensationRefused';
  }
}

export interface Plan {
  readonly accountId: string;
  readonly accountNumber: string;
  readonly currency: string;
  readonly balance: string;
  readonly balanceAfter: string;
  readonly entries: ReadonlyArray<{
    readonly id: string;
    readonly type: string;
    readonly amount: string;
    readonly description: string | null;
    readonly createdAt: Date;
    readonly reversal: string;
  }>;
  readonly net: string;
}

/** What would be posted, checked against every refusal, and nothing written. */
export async function plan(prisma: PrismaClient, entryIds: readonly string[]): Promise<Plan> {
  if (entryIds.length === 0) throw new CompensationRefused('Name at least one --entry.');
  const distinct = new Set(entryIds);
  if (distinct.size !== entryIds.length) {
    throw new CompensationRefused(
      'An entry is named more than once. Money is never reversed twice.',
    );
  }

  const rows = await prisma.balanceLedger.findMany({
    where: { id: { in: [...distinct] } },
    include: { account: { select: { id: true, number: true, currency: true, balance: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const missing = [...distinct].filter((id) => !rows.some((row) => row.id === id));
  if (missing.length > 0) {
    throw new CompensationRefused(`No ledger entry has id ${missing.join(', ')}.`);
  }

  const accounts = new Set(rows.map((row) => row.accountId));
  if (accounts.size !== 1) {
    throw new CompensationRefused(
      `These entries are on ${accounts.size} accounts. A correction is one account's; run it once per account.`,
    );
  }

  const answered = await prisma.balanceLedger.findMany({
    where: { compensatesId: { in: [...distinct] } },
    select: { compensatesId: true, id: true },
  });
  if (answered.length > 0) {
    throw new CompensationRefused(
      'Already compensated, by ' +
        answered.map((a) => `${a.id} (for ${a.compensatesId ?? '?'})`).join(', ') +
        '. Money is never reversed twice.',
    );
  }

  const account = rows[0]!.account;
  const currency = account.currency;
  let net = Money.zero(currency);
  const entries = rows.map((row) => {
    const reversal = Money.of(row.amount.toString(), currency).negated().round();
    net = net.plus(reversal);
    return {
      id: row.id,
      type: row.type,
      amount: Money.of(row.amount.toString(), currency).toString(),
      description: row.description,
      createdAt: row.createdAt,
      reversal: reversal.toString(),
    };
  });
  const balance = Money.of(account.balance.toString(), currency);
  const after = balance.plus(net);
  if (after.isNegative()) {
    throw new CompensationRefused(
      `Reversing these would take ${account.number} below zero (balance ${balance.toString()}, net ${net.toString()}). ` +
        'A negative cash balance is not a state this platform has rules for.',
    );
  }
  return {
    accountId: account.id,
    accountNumber: account.number,
    currency,
    balance: balance.toString(),
    balanceAfter: after.toString(),
    entries,
    net: net.toString(),
  };
}

export interface ApplyInput {
  readonly reason: string;
  readonly origin?: { readonly host: string; readonly user: string };
}

/**
 * Post the compensating entries, one transaction for the lot: all of them or
 * none, under the account's lock, with the audit row in the same commit.
 */
export async function apply(
  prisma: PrismaClient,
  planned: Plan,
  input: ApplyInput,
): Promise<{ posted: number; balanceAfter: string }> {
  const reason = input.reason.trim();
  if (reason.length < 8) {
    throw new CompensationRefused(
      'A reason somebody can read back later — at least a short sentence.',
    );
  }
  const origin = input.origin ?? { host: hostname(), user: userInfo().username };
  const ledger = new LedgerService();

  const account = await prisma.account.findUniqueOrThrow({
    where: { id: planned.accountId },
    select: { tenantId: true, tenant: { select: { slug: true } } },
  });

  return withTenant({ tenantId: account.tenantId, slug: account.tenant.slug }, () =>
    prisma.$transaction(async (tx) => {
      await ledger.lockAccount(tx, planned.accountId);
      // Re-checked under the lock: the plan was read without it.
      const answered = await tx.balanceLedger.count({
        where: { compensatesId: { in: planned.entries.map((e) => e.id) } },
      });
      if (answered > 0) {
        throw new CompensationRefused(
          'An entry was compensated while this ran. Look, then run again.',
        );
      }
      let last = { balanceAfter: Money.of(planned.balance, planned.currency) };
      for (const entry of planned.entries) {
        last = await ledger.compensate(tx, entry.id, reason);
      }
      if (last.balanceAfter.amount.lt(0)) {
        throw new CompensationRefused('The account would end below zero; nothing was posted.');
      }
      await tx.auditLog.create({
        data: {
          tenantId: account.tenantId,
          actorId: null,
          actorType: 'SYSTEM',
          action: 'account.balance_adjusted',
          resourceType: 'account',
          resourceId: planned.accountId,
          before: { balance: planned.balance },
          after: {
            balance: last.balanceAfter.toString(),
            net: planned.net,
            compensated: planned.entries.map((e) => ({
              id: e.id,
              type: e.type,
              amount: e.amount,
              reversal: e.reversal,
            })),
            reason,
            postedFrom: 'host',
            host: origin.host,
            hostUser: origin.user,
          },
        },
      });
      return { posted: planned.entries.length, balanceAfter: last.balanceAfter.toString() };
    }),
  );
}

export interface ParsedArgs {
  readonly entries: readonly string[];
  readonly reason: string;
  readonly applyNow: boolean;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const entries: string[] = [];
  let reason: string | undefined;
  let applyNow = false;
  const take = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new CompensationRefused(`${flag} needs a value.`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    switch (arg) {
      case '--entry':
        entries.push(take(arg, index));
        index += 1;
        break;
      case '--reason':
        reason = take(arg, index);
        index += 1;
        break;
      case '--apply':
        applyNow = true;
        break;
      default:
        throw new CompensationRefused(`Unknown argument: ${arg}`);
    }
  }
  if (entries.length === 0) throw new CompensationRefused('--entry is required, once per entry.');
  if (reason === undefined) throw new CompensationRefused('--reason is required.');
  return { entries, reason, applyNow };
}

const USAGE = `usage: compensate-ledger-entries --entry <id> [--entry <id> …] --reason "<why>" [--apply]

Posts one compensating ADJUSTMENT per named entry, on one account, in one
transaction, with an audit row naming this host. Without --apply it prints the
plan and posts nothing. Refuses an entry already compensated.`;

function show(planned: Plan): void {
  console.log(`Account ${planned.accountNumber} (${planned.currency}), balance ${planned.balance}`);
  for (const entry of planned.entries) {
    console.log(
      `  ${entry.id}  ${entry.createdAt.toISOString()}  ${entry.type.padEnd(12)} ${entry.amount.padStart(14)}  → reversal ${entry.reversal.padStart(14)}  ${entry.description ?? ''}`,
    );
  }
  console.log(`Net ${planned.net}; balance after ${planned.balanceAfter}`);
}

async function main(): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 2;
  }
  const prisma = new PrismaClient();
  try {
    const planned = await plan(prisma, args.entries);
    show(planned);
    if (!args.applyNow) {
      console.log('Nothing posted. Run again with --apply to post exactly this.');
      return 0;
    }
    const result = await apply(prisma, planned, { reason: args.reason });
    console.log(
      `Posted ${result.posted} compensating entr${result.posted === 1 ? 'y' : 'ies'}; balance ${result.balanceAfter}. Recorded in the audit log.`,
    );
    return 0;
  } catch (error) {
    if (error instanceof CompensationRefused) {
      console.error(`Refused: ${error.message}`);
      return 1;
    }
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(70);
    },
  );
}
