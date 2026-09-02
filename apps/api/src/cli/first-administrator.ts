/**
 * The first administrator.
 *
 * Every role change on the platform goes through `POST /admin/users/:id/role`,
 * which needs `roles.assign`, which only an administrator holds. A fresh
 * deployment has none: the seed creates no users, registration makes traders,
 * and no endpoint mints an administrator — correctly, because an endpoint that
 * did would be the first thing an intruder looked for. So the first one has to
 * come from outside the API, from the person who already holds everything: the
 * operator at the host, with the database in front of them.
 *
 * This is that act, made correct rather than merely possible. A raw UPDATE would
 * change the role and nothing else: the person's sessions would keep the old
 * capabilities until they expired, and the audit log — the first thing an
 * auditor reads — would show an administrator who was never appointed by
 * anyone. This does what the endpoint does, minus the actor it cannot have:
 *
 *   - the person must already exist, with a verified address, because the
 *     platform never creates an account from a shell — a password typed at a
 *     host is a password in a shell history;
 *   - the role changes and every session ends, in one transaction with
 *   - an audit row, actor SYSTEM, that names the host and the reason.
 *
 * It refuses when the tenant already has an active administrator: from then on
 * the record of who appointed whom belongs to the administrators, not to the
 * host. `--even-if-one-exists` is the break-glass for the day the only
 * administrator has left the company, and it is recorded as such.
 *
 *   node apps/api/dist/cli/first-administrator.js \
 *     --email you@firm.example --reason "first administrator after deployment"
 *
 * `scripts/first-administrator.sh` runs it inside the migrate image on a host.
 */
import { hostname, userInfo } from 'node:os';
import { PrismaClient } from '@prisma/client';

export interface AppointmentInput {
  readonly email: string;
  readonly reason: string;
  readonly tenantSlug: string;
  readonly evenIfOneExists: boolean;
  /** Where the act is recorded as coming from. Defaults to this host. */
  readonly origin?: { readonly host: string; readonly user: string };
}

export type AppointmentOutcome =
  | { readonly kind: 'appointed'; readonly userId: string; readonly sessionsEnded: number }
  | { readonly kind: 'already'; readonly userId: string };

export class AppointmentRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppointmentRefused';
  }
}

const MIN_REASON = 8;

export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Appoint an administrator, the way the endpoint would if it could.
 *
 * Takes a plain client on purpose: this runs where the API does not, with the
 * owner connection the migration uses, so every query names its tenant itself
 * rather than relying on a scope nothing here has opened.
 */
export async function appointAdministrator(
  prisma: PrismaClient,
  input: AppointmentInput,
): Promise<AppointmentOutcome> {
  const reason = input.reason.trim();
  if (reason.length < MIN_REASON) {
    throw new AppointmentRefused(
      `A reason of at least ${MIN_REASON} characters is required; it is the audit line.`,
    );
  }
  const email = normaliseEmail(input.email);
  if (!email.includes('@')) {
    throw new AppointmentRefused(`"${input.email}" is not an email address.`);
  }

  const tenant = await prisma.tenant.findUnique({
    where: { slug: input.tenantSlug },
    select: { id: true, status: true },
  });
  if (tenant === null) {
    throw new AppointmentRefused(`No tenant has the slug "${input.tenantSlug}".`);
  }
  if (tenant.status !== 'ACTIVE') {
    throw new AppointmentRefused(`Tenant "${input.tenantSlug}" is ${tenant.status}, not ACTIVE.`);
  }

  const user = await prisma.user.findUnique({
    where: { tenantId_email: { tenantId: tenant.id, email } },
    select: { id: true, role: true, emailVerified: true, isActive: true },
  });
  if (user === null) {
    throw new AppointmentRefused(
      `Nobody in "${input.tenantSlug}" is registered as ${email}. ` +
        'Register through the platform first; accounts are never created from a host.',
    );
  }
  if (!user.emailVerified) {
    throw new AppointmentRefused(
      `${email} has not verified their address. An administrator whose address was never ` +
        'confirmed is one nobody can be sure of reaching.',
    );
  }
  if (!user.isActive) {
    throw new AppointmentRefused(`${email} is suspended. Reinstate them first, and say why.`);
  }
  if (user.role === 'ADMIN') {
    return { kind: 'already', userId: user.id };
  }

  const existing = await prisma.user.count({
    where: { tenantId: tenant.id, role: 'ADMIN', isActive: true },
  });
  if (existing > 0 && !input.evenIfOneExists) {
    throw new AppointmentRefused(
      `"${input.tenantSlug}" already has ${existing === 1 ? 'an administrator' : `${existing} administrators`}. ` +
        'They appoint the next one from the People screen (POST /admin/users/:id/role), so the ' +
        'record names who did it. If none of them can — the last one has left — pass ' +
        '--even-if-one-exists, and that will be recorded too.',
    );
  }

  const origin = input.origin ?? { host: hostname(), user: userInfo().username };
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    // Guarded on the role read above, so two operators at two terminals cannot
    // both be "the first".
    const changed = await tx.user.updateMany({
      where: { id: user.id, tenantId: tenant.id, role: user.role },
      data: { role: 'ADMIN' },
    });
    if (changed.count !== 1) {
      throw new AppointmentRefused(`${email}'s role changed while this ran. Look, then run again.`);
    }
    const revoked = await tx.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.auditLog.create({
      data: {
        tenantId: tenant.id,
        actorId: null,
        actorType: 'SYSTEM',
        action: 'user.role_assigned',
        resourceType: 'user',
        resourceId: user.id,
        before: { role: user.role },
        after: {
          role: 'ADMIN',
          reason,
          sessionsEnded: revoked.count,
          appointedFrom: 'host',
          host: origin.host,
          hostUser: origin.user,
          administratorsBefore: existing,
          evenIfOneExists: input.evenIfOneExists,
        },
        createdAt: now,
      },
    });
    return { kind: 'appointed', userId: user.id, sessionsEnded: revoked.count };
  });
}

export interface ParsedArgs {
  readonly email: string;
  readonly reason: string;
  readonly tenantSlug: string;
  readonly evenIfOneExists: boolean;
}

export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv): ParsedArgs {
  let email: string | undefined;
  let reason: string | undefined;
  let tenantSlug = env['TENANT_DEFAULT_SLUG'] ?? 'default';
  let evenIfOneExists = false;

  const take = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new AppointmentRefused(`${flag} needs a value.`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    switch (arg) {
      case '--email':
        email = take(arg, index);
        index += 1;
        break;
      case '--reason':
        reason = take(arg, index);
        index += 1;
        break;
      case '--tenant':
        tenantSlug = take(arg, index);
        index += 1;
        break;
      case '--even-if-one-exists':
        evenIfOneExists = true;
        break;
      default:
        throw new AppointmentRefused(`Unknown argument: ${arg}`);
    }
  }
  if (email === undefined) throw new AppointmentRefused('--email is required.');
  if (reason === undefined) throw new AppointmentRefused('--reason is required.');
  return { email, reason, tenantSlug, evenIfOneExists };
}

const USAGE = `usage: first-administrator --email <address> --reason "<why>" [--tenant <slug>] [--even-if-one-exists]

Appoints an existing, verified, active user as ADMIN. Ends their sessions and
writes the audit row. Refuses if the tenant already has an active administrator,
unless --even-if-one-exists.`;

async function main(): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 2;
  }

  const prisma = new PrismaClient();
  try {
    const outcome = await appointAdministrator(prisma, args);
    if (outcome.kind === 'already') {
      console.log(`${normaliseEmail(args.email)} is already an administrator. Nothing changed.`);
      return 0;
    }
    console.log(
      `${normaliseEmail(args.email)} is now an administrator of "${args.tenantSlug}". ` +
        `${outcome.sessionsEnded} session${outcome.sessionsEnded === 1 ? '' : 's'} ended; ` +
        'they sign in again and the role is in the token. Recorded in the audit log.',
    );
    return 0;
  } catch (error) {
    if (error instanceof AppointmentRefused) {
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
