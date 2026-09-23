import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  API_VERSION,
  DomainError,
  TradingErrorCode,
  type AuthTokenResponse,
  type TwoFactorChallengeResponse,
} from '@tp/shared-types';
import { corsOrigins, rateLimits, RATE_LIMIT_WINDOW_MS, type Env } from '../config/env.schema';
import { parseDuration } from './token.service';
import {
  clearRefreshCookie,
  isAllowedOrigin,
  readRefreshCookie,
  refreshCookiePath,
  issuesBodyRefreshToken,
  setRefreshCookie,
  type CookieOptions,
} from './refresh-cookie';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { SelfService } from '../common/decorators/self-service.decorator';
import { clientAddress, RequestWithContext } from '../common/request-context';
import { AuthService, type AuthContext } from './auth.service';
import { TotpService, type TotpStatus } from './totp.service';
import { SessionsService, type AddressSummary, type SessionSummary } from './sessions.service';
import {
  ChangePasswordDto,
  LoginDto,
  RefreshDto,
  RegisterDto,
  RequestPasswordResetDto,
  ResetPasswordDto,
  TwoFactorActivateDto,
  TwoFactorDisableDto,
  TwoFactorLoginDto,
  VerifyEmailDto,
} from './dto/auth.dto';

function contextOf(request: RequestWithContext): AuthContext {
  return {
    requestId: request.requestId,
    ipAddress: clientAddress(request),
    userAgent: request.header('user-agent'),
  };
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly totp: TotpService,
    private readonly sessions: SessionsService,
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * How the refresh cookie is scoped, derived from the same configuration the
   * router uses. Hard-coding the path here would let a change to the global
   * prefix silently orphan every existing session's cookie.
   */
  private cookieOptions(): CookieOptions {
    return {
      path: refreshCookiePath(this.config.get('API_GLOBAL_PREFIX', { infer: true }), API_VERSION),
      secure: this.config.get('NODE_ENV', { infer: true }) === 'production',
      maxAgeSeconds: parseDuration(this.config.get('JWT_REFRESH_TTL', { infer: true })),
    };
  }

  /**
   * Reject a cookie-authenticated request from an origin we do not serve.
   *
   * `SameSite=Strict` already stops a cross-site page from sending the cookie at
   * all; this is the second line, for browsers that do not honour it. A request
   * with no `Origin` is not a cross-site form post and is allowed through — that
   * is how non-browser clients arrive.
   */
  private assertOriginAllowed(request: RequestWithContext): void {
    const allowed = corsOrigins(this.config.get('CORS_ORIGINS', { infer: true }));
    if (!isAllowedOrigin(request.header('origin'), allowed)) {
      throw new ForbiddenException('Origin not allowed');
    }
  }

  /**
   * Returns 202, not 201, and carries no body.
   *
   * The response is identical whether or not the address was already
   * registered — see AuthService.register. Returning the new user id here would
   * undo that, so nothing is returned at all.
   */
  @Public()
  @Throttle({ default: { limit: rateLimits.login, ttl: RATE_LIMIT_WINDOW_MS } })
  @Post('register')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Register and open a demo account' })
  async register(
    @Body() body: RegisterDto,
    @Req() request: RequestWithContext,
  ): Promise<{ status: string }> {
    await this.auth.register(body, contextOf(request));
    return { status: 'check your email to verify this address' };
  }

  @Public()
  @Throttle({ default: { limit: rateLimits.login, ttl: RATE_LIMIT_WINDOW_MS } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange credentials for an access token; the refresh token is set as a cookie',
  })
  async login(
    @Body() body: LoginDto,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.login(body.email, body.password, {
      ...contextOf(request),
      installationId: body.installationId ?? null,
    });
    if (result.kind === 'twoFactorRequired') {
      // No cookie is set and no access token is returned: nobody has signed in
      // yet. The challenge is the only thing that crosses, and on its own it
      // opens nothing.
      const challenge: TwoFactorChallengeResponse = {
        twoFactorRequired: true,
        challengeToken: result.challengeToken,
        expiresIn: result.expiresIn,
      };
      return challenge;
    }
    setRefreshCookie(response, result.pair.refreshToken, this.cookieOptions());
    // The refresh token is absent from the body for a browser: returning it
    // there would put it back within reach of any injected script. A native
    // client, which cannot be one, gets it — see `issuesBodyRefreshToken`.
    return tokenResponse(result.pair, issuesBodyRefreshToken(request, body));
  }

  /**
   * The second half of a two-factor sign-in.
   *
   * Rate-limited as tightly as the password endpoint. Six digits is a million
   * possibilities, which sounds ample and is not: with three steps live at once
   * and no limit, a determined attacker gets through in hours.
   */
  @Public()
  @Throttle({ default: { limit: rateLimits.login, ttl: RATE_LIMIT_WINDOW_MS } })
  @Post('login/2fa')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Complete a sign-in with a one-time or recovery code' })
  async loginTwoFactor(
    @Body() body: TwoFactorLoginDto,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    const pair = await this.auth.completeTwoFactor(body.challengeToken, body.code, {
      ...contextOf(request),
      installationId: body.installationId ?? null,
    });
    setRefreshCookie(response, pair.refreshToken, this.cookieOptions());
    return tokenResponse(pair, issuesBodyRefreshToken(request, body));
  }

  @SelfService()
  @Get('2fa')
  @ApiOperation({ summary: 'Whether two-factor authentication is on for the signed-in user' })
  async twoFactorStatus(@CurrentUser() user: AuthenticatedUser): Promise<TotpStatus> {
    return this.totp.status(user.id);
  }

  /**
   * Begins enrolment. Returns the secret **once**.
   *
   * Nothing is switched on by this call: the user has an unproved secret until
   * they come back with a code. Enrolling and enabling in one step is how people
   * lock themselves out at the exact moment they were trying to be careful.
   */
  @SelfService()
  @Throttle({ default: { limit: rateLimits.login, ttl: RATE_LIMIT_WINDOW_MS } })
  @Post('2fa/enrol')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Begin two-factor enrolment' })
  async beginTwoFactorEnrolment(@CurrentUser() user: AuthenticatedUser) {
    return this.totp.beginEnrolment(user.id);
  }

  /**
   * Proves the enrolment and returns the recovery codes.
   *
   * This is the only response in the system a user must write down: the codes
   * are stored as hashes and cannot be shown again.
   */
  @SelfService()
  @Throttle({ default: { limit: rateLimits.login, ttl: RATE_LIMIT_WINDOW_MS } })
  @Post('2fa/activate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm a code and switch two-factor authentication on' })
  async activateTwoFactor(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: TwoFactorActivateDto,
    @Req() request: RequestWithContext,
  ) {
    return this.totp.activate(user.id, body.code, request.requestId);
  }

  @SelfService()
  @Throttle({ default: { limit: rateLimits.login, ttl: RATE_LIMIT_WINDOW_MS } })
  @Post('2fa/disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Turn two-factor authentication off — password and a live code' })
  async disableTwoFactor(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: TwoFactorDisableDto,
    @Req() request: RequestWithContext,
  ): Promise<void> {
    await this.totp.disable(user.id, body.password, body.code, request.requestId);
  }

  /**
   * The user's live sessions, with their own marked.
   *
   * One row per sign-in, not per token: a token rotates every fifteen minutes,
   * and listing rows would show a user ninety-six sessions a day from one
   * laptop. A list that looks like noise is a list nobody reads, and the value
   * of this one is entirely that they do.
   */
  @SelfService()
  @Get('sessions')
  @ApiOperation({ summary: 'List the signed-in user’s active sessions' })
  async listSessions(@CurrentUser() user: AuthenticatedUser): Promise<SessionSummary[]> {
    return this.sessions.list(user.id, user.sessionId);
  }

  /**
   * Where this account has been signed in from — one row per address, with
   * the first and last time and what signed in from it. The list a person
   * reads when something in the security feed looked unfamiliar.
   */
  @SelfService()
  @Get('addresses')
  @ApiOperation({ summary: 'Where the signed-in user’s account has been signed in from' })
  async listAddresses(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: RequestWithContext,
  ): Promise<AddressSummary[]> {
    return this.sessions.addresses(user.id, clientAddress(request));
  }

  /**
   * Ends one session.
   *
   * A user who ends their own current session is signing out, which is a
   * reasonable thing to want from a list of sessions and is not treated as a
   * mistake. The cookie is left alone: the next refresh fails and the client
   * clears it, which is the same path an expired session takes.
   */
  @SelfService()
  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke one of the signed-in user’s sessions' })
  async revokeSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() request: RequestWithContext,
  ): Promise<void> {
    await this.sessions.revoke(user.id, id, {
      requestId: request.requestId,
      ipAddress: clientAddress(request),
      userAgent: request.header('user-agent'),
    });
  }

  @Public()
  @Throttle({ default: { limit: rateLimits.login * 6, ttl: RATE_LIMIT_WINDOW_MS } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate a refresh token. Reusing one revokes the whole session family.',
  })
  async refresh(
    @Body() body: RefreshDto,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.assertOriginAllowed(request);
    // The cookie is preferred. A body token remains accepted for non-browser
    // clients that hold the value themselves — that is not a weakness, because
    // the risk this change addresses is a *script reading* the token, and no
    // response ever hands one out.
    const fromCookie = readRefreshCookie(request);
    const presented = fromCookie ?? body.refreshToken ?? null;
    if (presented === null) {
      throw new DomainError(TradingErrorCode.UNAUTHENTICATED, 'No refresh token was presented');
    }
    const pair = await this.auth.refresh(presented, contextOf(request));
    setRefreshCookie(response, pair.refreshToken, this.cookieOptions());
    // A client that presented its token in the body holds it itself, and gets
    // the rotated one back the same way — or its next refresh would present a
    // token the server has already retired, which reads as replay.
    return tokenResponse(
      pair,
      issuesBodyRefreshToken(request, { presentedInBody: fromCookie === null }),
    );
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke a refresh token and its family' })
  async logout(
    @Body() body: RefreshDto,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const presented = readRefreshCookie(request) ?? body.refreshToken ?? null;
    // The cookie is cleared whether or not a token was presented. A logout that
    // leaves the cookie in place because the token had already expired is a
    // logout that did not happen.
    clearRefreshCookie(response, this.cookieOptions());
    if (presented !== null) await this.auth.logout(presented, contextOf(request));
  }

  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Confirm an email address' })
  async verifyEmail(@Body() body: VerifyEmailDto): Promise<void> {
    await this.auth.verifyEmail(body.token);
  }

  /** Always 202, registered or not — see AuthService.requestPasswordReset. */
  @Public()
  @Throttle({ default: { limit: rateLimits.login, ttl: RATE_LIMIT_WINDOW_MS } })
  @Post('password-reset')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Request a password-reset link' })
  async requestPasswordReset(@Body() body: RequestPasswordResetDto): Promise<{ status: string }> {
    await this.auth.requestPasswordReset(body.email);
    return { status: 'if that address is registered, a reset link has been sent' };
  }

  @Public()
  @Throttle({ default: { limit: rateLimits.login, ttl: RATE_LIMIT_WINDOW_MS } })
  @Post('password-reset/confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Complete a password reset. Revokes every existing session.' })
  async resetPassword(@Body() body: ResetPasswordDto): Promise<void> {
    await this.auth.resetPassword(body.token, body.password);
  }

  @SelfService()
  @Post('password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Change your password. Revokes every existing session.' })
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ChangePasswordDto,
  ): Promise<void> {
    await this.auth.changePassword(user.id, body.currentPassword, body.newPassword);
  }

  @Get('me')
  @ApiOperation({ summary: 'The authenticated user' })
  me(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }
}

/** The one shape every sign-in and refresh answers with. See `AuthTokenResponse`. */
function tokenResponse(
  pair: { accessToken: string; refreshToken: string; expiresIn: number },
  includeRefreshToken: boolean,
): AuthTokenResponse {
  return {
    accessToken: pair.accessToken,
    expiresIn: pair.expiresIn,
    ...(includeRefreshToken ? { refreshToken: pair.refreshToken } : {}),
  };
}
