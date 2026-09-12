import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Email is lower-cased and trimmed at the boundary so that
 * `Trader@Example.com` and `trader@example.com` cannot become two accounts.
 */
const email = z.string().trim().toLowerCase().email().max(254);

/**
 * Length is the only rule enforced here. Composition rules ("one uppercase, one
 * symbol") measurably push people toward `Password1!` — NIST SP 800-63B advises
 * against them. Minimum length is checked again in PasswordService, which is the
 * layer that must not be bypassable.
 */
const password = z.string().min(12).max(256);

export const registerSchema = z
  .object({
    email,
    password,
    displayName: z.string().trim().min(1).max(120),
    /**
     * Required only when the platform is running in invite mode, which the
     * schema cannot see — so it is optional here and the service refuses a
     * missing one. Bounded because it is unauthenticated input, and normalised
     * downstream so a code retyped with spaces or dashes still works.
     */
    inviteCode: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

/**
 * Which installation is signing in, when the client knows its own.
 *
 * Optional, because a browser has no such thing and must keep working exactly
 * as it does. Bounded for the same reason the device registration bounds it:
 * it is a client-supplied string that lands in an indexed column, and an
 * unbounded one there is an invitation to fill the index.
 */
const installationId = z.string().min(8).max(200);

export const loginSchema = z
  .object({
    email,
    password: z.string().min(1).max(256),
    installationId: installationId.nullish(),
  })
  .strict();

/**
 * The token is optional in the body because the browser sends it as a cookie.
 * It remains accepted here for non-browser clients that hold the value
 * themselves; the controller rejects a request that presents neither.
 */
export const refreshSchema = z
  .object({ refreshToken: z.string().min(1).max(4096).optional() })
  .strict();

export const verifyEmailSchema = z.object({ token: z.string().min(1).max(512) }).strict();

export const requestPasswordResetSchema = z.object({ email }).strict();

export const resetPasswordSchema = z
  .object({ token: z.string().min(1).max(512), password })
  .strict();

export const changePasswordSchema = z
  .object({ currentPassword: z.string().min(1).max(256), newPassword: password })
  .strict();

export class RegisterDto extends createZodDto(registerSchema) {}
export class LoginDto extends createZodDto(loginSchema) {}
export class RefreshDto extends createZodDto(refreshSchema) {}
export class VerifyEmailDto extends createZodDto(verifyEmailSchema) {}
export class RequestPasswordResetDto extends createZodDto(requestPasswordResetSchema) {}
export class ResetPasswordDto extends createZodDto(resetPasswordSchema) {}
export class ChangePasswordDto extends createZodDto(changePasswordSchema) {}

/**
 * A second factor: either six digits or a recovery code.
 *
 * One field rather than two, because a user pasting the code they have should
 * not first have to classify it, and the server can tell the shapes apart with
 * certainty. The bound is generous enough for a spaced-out recovery code and
 * far too small for anything else.
 */
const secondFactor = z.string().min(6).max(32);

export const twoFactorLoginSchema = z
  .object({
    challengeToken: z.string().min(1).max(4096),
    code: secondFactor,
    // The second half of the same sign-in, so it carries the same fact. A
    // phone with two-factor on must not end up with a session that belongs to
    // no device — it would survive the revocation of the handset it is on.
    installationId: installationId.nullish(),
  })
  .strict();

export const twoFactorActivateSchema = z.object({ code: z.string().regex(/^[0-9]{6}$/) }).strict();

export const twoFactorDisableSchema = z
  .object({ password: z.string().min(1).max(256), code: secondFactor })
  .strict();

export class TwoFactorLoginDto extends createZodDto(twoFactorLoginSchema) {}
export class TwoFactorActivateDto extends createZodDto(twoFactorActivateSchema) {}
export class TwoFactorDisableDto extends createZodDto(twoFactorDisableSchema) {}
