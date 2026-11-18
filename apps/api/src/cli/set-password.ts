/**
 * A new password for an existing user, set from the host.
 *
 * For the day an owner cannot get in: the reset email does not arrive (Gmail
 * refuses this server's mail until SPF and DKIM exist), and no administrator
 * is left to help. The person must already exist — accounts are never created
 * from a shell.
 *
 * The password is **generated here**, never typed: a password typed at a host
 * is a password in a shell history. It is 20 characters from an alphabet
 * without look-alikes (no 0/O, 1/l/I), about 117 bits. It is hashed with
 * Argon2id at the deployment's own cost, exactly as `PasswordService` hashes,
 * and only the hash is stored. It is printed **once**, to the operator who ran
 * this, and appears in no log and no audit row. Every session of that person
 * ends, and any pending reset link stops working. The audit row (actor
 * SYSTEM) names the host, the user who ran it and the reason.
 *
 * The person should change it after signing in.
 *
 *   node apps/api/dist/cli/set-password.js --email you@firm.example --reason "<why>"
 *
 * `scripts/set-password.sh` runs it inside the migrate image on a host.
 */
import { randomInt } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { PrismaClient } from '@prisma/client';
import { Algorithm, hash } from '@node-rs/argon2';

/** No 0/O, 1/l/I: a password read off a screen must be typeable. */
export const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
export const LENGTH = 20;

export class SetPasswordRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetPasswordRefused';
  }
}

/** Uniform over the alphabet — `randomInt`, not `% length` on random bytes. */
export function generatePassword(length: number = LENGTH): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export function parseArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): { email: string; reason: string; tenantSlug: string } {
  let email: string | undefined;
  let reason: string | undefined;
  let tenantSlug = env['TENANT_DEFAULT_SLUG'] ?? 'default';
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (flag !== '--email' && flag !== '--reason' && flag !== '--tenant') {
      throw new SetPasswordRefused(`Unknown argument: ${flag}`);
    }
    if (value === undefined || value.startsWith('--')) {
      throw new SetPasswordRefused(`${flag} needs a value.`);
    }
    if (flag === '--email') email = value.trim().toLowerCase();
    if (flag === '--reason') reason = value.trim();
    if (flag === '--tenant') tenantSlug = value;
    i += 1;
  }
  if (email === undefined || !email.includes('@')) {
    throw new SetPasswordRefused('--email <address> is required.');
  }
  if (reason === undefined || reason.length < 8) {
    throw new SetPasswordRefused(
      '--reason of at least 8 characters is required; it is the audit line.',
    );
  }
  return { email, reason, tenantSlug };
}

export async function setPassword(
  prisma: PrismaClient,
  input: { email: string; reason: string; tenantSlug: string },
  password: string,
  cost: { memoryCost: number; timeCost: number },
  origin = { host: hostname(), user: userInfo().username },
): Promise<{ userId: string; sessionsEnded: number }> {
  const tenant = await prisma.tenant.findUnique({
    where: { slug: input.tenantSlug },
    select: { id: true },
  });
  if (tenant === null)
    throw new SetPasswordRefused(`No tenant has the slug "${input.tenantSlug}".`);
  const user = await prisma.user.findUnique({
    where: { tenantId_email: { tenantId: tenant.id, email: input.email } },
    select: { id: true, isActive: true },
  });
  if (user === null) {
    throw new SetPasswordRefused(
      `Nobody in "${input.tenantSlug}" is registered as ${input.email}. Accounts are never created from a host.`,
    );
  }
  if (!user.isActive) throw new SetPasswordRefused(`${input.email} is suspended.`);

  const passwordHash = await hash(password, {
    algorithm: Algorithm.Argon2id,
    memoryCost: cost.memoryCost,
    timeCost: cost.timeCost,
    parallelism: 1,
  });
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash, passwordResetTokenHash: null, passwordResetExpiresAt: null },
    });
    const revoked = await tx.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.auditLog.create({
      data: {
        tenantId: tenant.id,
        actorId: null,
        actorType: 'SYSTEM',
        action: 'user.password_set_from_host',
        resourceType: 'user',
        resourceId: user.id,
        after: {
          reason: input.reason,
          sessionsEnded: revoked.count,
          host: origin.host,
          hostUser: origin.user,
        },
        createdAt: now,
      },
    });
    return { userId: user.id, sessionsEnded: revoked.count };
  });
}

async function main(): Promise<number> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('usage: set-password --email <address> --reason "<why>" [--tenant <slug>]');
    return 2;
  }
  // Integers (KiB and iterations), never below the OWASP baseline the schema enforces.
  const cost = {
    memoryCost: Math.max(
      19_456,
      parseInt(process.env['PASSWORD_HASH_MEMORY_COST'] ?? '', 10) || 19_456,
    ),
    timeCost: Math.max(2, parseInt(process.env['PASSWORD_HASH_TIME_COST'] ?? '', 10) || 2),
  };
  const prisma = new PrismaClient();
  try {
    const password = generatePassword();
    const outcome = await setPassword(prisma, args, password, cost);
    console.log(
      `${args.email}: password set. ${outcome.sessionsEnded} session(s) ended. Recorded in the audit log (not the password).`,
    );
    console.log(
      `\nThe new password — shown once, stored nowhere but as a hash:\n\n  ${password}\n`,
    );
    console.log('Sign in with it and change it.');
    return 0;
  } catch (error) {
    if (error instanceof SetPasswordRefused) {
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
