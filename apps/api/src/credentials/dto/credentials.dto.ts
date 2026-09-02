import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const name = z.string().trim().min(1).max(100);
/** Capability names; what they may be is decided by the service, with reasons. */
const permissions = z.array(z.string().trim().min(3).max(64)).min(1).max(64);
const expiresInDays = z.number().int().min(1).max(3650).optional();
const rateLimitPerMinute = z.number().int().min(1).max(100000).optional();

export const mintApiKeySchema = z
  .object({
    name,
    permissions,
    expiresInDays,
    rateLimitPerMinute,
    /** Asked for again, as for changing it: a session must not mint a secret that outlives it unchallenged. */
    password: z.string().min(1).max(512),
  })
  .strict();

export class MintApiKeyDto extends createZodDto(mintApiKeySchema) {}

export const revokeOwnKeySchema = z
  .object({ reason: z.string().trim().min(1).max(500).optional() })
  .strict();

export class RevokeOwnKeyDto extends createZodDto(revokeOwnKeySchema) {}

export const revokeCredentialSchema = z
  .object({ reason: z.string().trim().min(8).max(500) })
  .strict();

export class RevokeCredentialDto extends createZodDto(revokeCredentialSchema) {}

export const mintServiceTokenSchema = z
  .object({
    name,
    description: z.string().trim().max(500).optional(),
    permissions,
    expiresInDays,
    rateLimitPerMinute,
  })
  .strict();

export class MintServiceTokenDto extends createZodDto(mintServiceTokenSchema) {}
