import { Injectable } from '@nestjs/common';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { PrismaService } from '../prisma/prisma.service';

export interface UserProfile {
  id: string;
  email: string;
  displayName: string;
  role: string;
  emailVerified: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async profile(userId: string): Promise<UserProfile> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (user === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'User not found');
    }
    // Explicit field selection rather than spreading the row: a column added
    // later (a TOTP secret, a password hash) must not leak by default.
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt.toISOString(),
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    };
  }

  async updateDisplayName(userId: string, displayName: string): Promise<UserProfile> {
    await this.prisma.user.update({ where: { id: userId }, data: { displayName } });
    return this.profile(userId);
  }
}
