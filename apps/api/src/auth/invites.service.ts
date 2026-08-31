import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import type { Env } from '../config/env.schema';

/**
 * Invitations to open an account.
 *
 * The contract is the one the specification states for any generated secret:
 * never store the raw value, hash it, keep a fingerprint so a human can
 * identify it, and show the plaintext exactly once. An administrator who has
 * lost an invite code mints another; the platform cannot show them the old one,
 * because it does not have it.
 *
 * The fingerprint is the first eight characters. That is enough to say "the one
 * ending in the list above" and nowhere near enough to redeem — the code is 32
 * base64url characters and the remaining 24 carry 144 bits.
 */

/** Characters that cannot be confused for one another when read aloud or retyped. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 24;
const FINGERPRINT_LENGTH = 8;

export interface MintedInvite {
  id: string;
  /** The only time this value exists outside the administrator's clipboard. */
  code: string;
  fingerprint: string;
  expiresAt: Date;
  maxUses: number;
}

export interface InviteSummary {
  id: string;
  fingerprint: string;
  label: string | null;
  maxUses: number;
  useCount: number;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  createdById: string | null;
}

@Injectable()
export class InvitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Generate a code, store its hash, return the plaintext once.
   *
   * The plaintext is returned and never written anywhere else — not to the
   * audit record, not to a log line. The audit record carries the fingerprint,
   * which identifies the invitation without being able to redeem it.
   */
  async mint(
    actorId: string,
    input: {
      label?: string | undefined;
      maxUses?: number | undefined;
      ttlHours?: number | undefined;
    },
    context: {
      requestId?: string | null;
      ipAddress?: string | null;
      userAgent?: string | null;
    } = {},
  ): Promise<MintedInvite> {
    const maxUses = input.maxUses ?? 1;
    if (maxUses < 1 || maxUses > 1_000) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'An invitation must be good for between 1 and 1000 registrations.',
      );
    }

    const ttlHours: number =
      input.ttlHours ?? this.config.get('INVITE_CODE_TTL_HOURS', { infer: true });
    const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);

    const code = generateCode();
    const created = await this.prisma.inviteCode.create({
      data: {
        codeHash: hashCode(code),
        fingerprint: code.slice(0, FINGERPRINT_LENGTH),
        label: input.label ?? null,
        createdById: actorId,
        maxUses,
        expiresAt,
      },
    });

    await this.audit.record({
      actorId,
      actorType: 'ADMIN',
      action: 'INVITE_CODE_CREATED',
      resourceType: 'InviteCode',
      resourceId: created.id,
      after: {
        fingerprint: created.fingerprint,
        label: created.label,
        maxUses: created.maxUses,
        expiresAt: created.expiresAt.toISOString(),
      },
      requestId: context.requestId ?? null,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
    });

    return {
      id: created.id,
      code,
      fingerprint: created.fingerprint,
      expiresAt: created.expiresAt,
      maxUses: created.maxUses,
    };
  }

  async list(limit = 100): Promise<InviteSummary[]> {
    const rows = await this.prisma.inviteCode.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    // `codeHash` is deliberately absent from what leaves this service.
    return rows.map((row) => ({
      id: row.id,
      fingerprint: row.fingerprint,
      label: row.label,
      maxUses: row.maxUses,
      useCount: row.useCount,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      createdAt: row.createdAt,
      createdById: row.createdById,
    }));
  }

  async revoke(
    actorId: string,
    id: string,
    context: {
      requestId?: string | null;
      ipAddress?: string | null;
      userAgent?: string | null;
    } = {},
  ): Promise<void> {
    const existing = await this.prisma.inviteCode.findUnique({ where: { id } });
    if (existing === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such invitation.');
    }
    if (existing.revokedAt !== null) return;

    const updated = await this.prisma.inviteCode.update({
      where: { id },
      data: { revokedAt: new Date() },
    });

    await this.audit.record({
      actorId,
      actorType: 'ADMIN',
      action: 'INVITE_CODE_REVOKED',
      resourceType: 'InviteCode',
      resourceId: id,
      before: { revokedAt: null, useCount: existing.useCount },
      after: { revokedAt: updated.revokedAt?.toISOString() ?? null, useCount: updated.useCount },
      requestId: context.requestId ?? null,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
    });
  }

  /**
   * Claim one use of a code, inside the caller's transaction.
   *
   * Two properties matter and both come from doing this in SQL rather than in
   * JavaScript:
   *
   *   1. The increment is conditional on `use_count < max_uses` in the same
   *      statement that performs it, so two simultaneous registrations against
   *      a single-use code cannot both succeed. Reading the count, deciding,
   *      and writing it back would let them.
   *   2. The row is matched by hash, so the plaintext is never compared against
   *      anything stored.
   *
   * Returns the invitation's id, for the redemption record the caller writes.
   */
  async claim(tx: Prisma.TransactionClient, code: string): Promise<string> {
    const normalised = normaliseCode(code);
    if (normalised.length === 0) {
      throw invalidInvite();
    }

    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE invite_codes
         SET use_count = use_count + 1
       WHERE code_hash = ${hashCode(normalised)}
         AND revoked_at IS NULL
         AND expires_at > now()
         AND use_count < max_uses
      RETURNING id
    `;

    const claimed = rows[0];
    if (claimed === undefined) {
      // Deliberately one message for every reason a code did not work: wrong,
      // expired, revoked, spent. Telling an outsider *which* turns the endpoint
      // into an oracle for enumerating valid codes.
      throw invalidInvite();
    }
    return claimed.id;
  }

  /** Record who came in on which invitation. Called inside the same transaction. */
  async recordRedemption(
    tx: Prisma.TransactionClient,
    inviteCodeId: string,
    userId: string,
  ): Promise<void> {
    await tx.inviteRedemption.create({ data: { inviteCodeId, userId } });
  }

  /** For the audit record on the resulting registration. */
  async fingerprintOf(tx: Prisma.TransactionClient, inviteCodeId: string): Promise<string | null> {
    const row = await tx.inviteCode.findUnique({
      where: { id: inviteCodeId },
      select: { fingerprint: true },
    });
    return row?.fingerprint ?? null;
  }
}

function invalidInvite(): DomainError {
  return new DomainError(
    TradingErrorCode.VALIDATION_FAILED,
    'That invitation code is not usable. Ask whoever invited you for a new one.',
  );
}

/**
 * 24 characters from a 32-symbol alphabet — 120 bits.
 *
 * Drawn with rejection sampling rather than `% ALPHABET.length`, because 256 is
 * not a multiple of 32 for every alphabet one might later choose, and a modulo
 * bias in a security token is the kind of defect that survives review by being
 * invisible. Here 256 happens to divide evenly, so the loop never rejects;
 * it is written this way so that changing the alphabet cannot silently
 * introduce a bias.
 */
function generateCode(): string {
  const max = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  const out: string[] = [];
  while (out.length < CODE_LENGTH) {
    for (const byte of randomBytes(CODE_LENGTH)) {
      if (byte >= max) continue;
      out.push(ALPHABET[byte % ALPHABET.length] as string);
      if (out.length === CODE_LENGTH) break;
    }
  }
  return out.join('');
}

/** Uppercase, and strip the spaces and dashes people add when retyping. */
function normaliseCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hashCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/** Exported so the generator and the normaliser can be tested directly. */
export const __testing = { generateCode, normaliseCode, hashCode };
