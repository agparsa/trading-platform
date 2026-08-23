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
  })
  .strict();

export const loginSchema = z.object({ email, password: z.string().min(1).max(256) }).strict();

export const refreshSchema = z.object({ refreshToken: z.string().min(1).max(4096) }).strict();

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
