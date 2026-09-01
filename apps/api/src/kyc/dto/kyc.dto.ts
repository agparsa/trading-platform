import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { KycDocumentKind } from '@tp/kyc-core';

export const documentKindSchema = z.nativeEnum(KycDocumentKind);

export const decideKycSchema = z
  .object({
    outcome: z.enum(['VERIFIED', 'REJECTED']),
    /**
     * Why. Required for both outcomes.
     *
     * For a rejection it is what the person is shown, so it has to say what to
     * fix: "the passport photo is too blurred to read the number" is a
     * rejection somebody can act on. For a verification it is what a later
     * reviewer reads: which document was checked, against what.
     */
    reason: z.string().trim().min(8).max(1000),
  })
  .strict();

export class DecideKycDto extends createZodDto(decideKycSchema) {}

export const revokeKycSchema = z
  .object({
    reason: z.string().trim().min(8).max(1000),
  })
  .strict();

export class RevokeKycDto extends createZodDto(revokeKycSchema) {}
