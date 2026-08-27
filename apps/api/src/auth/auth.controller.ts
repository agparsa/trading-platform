import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { API_VERSION, DomainError, TradingErrorCode } from '@tp/shared-types';
import { corsOrigins, rateLimits, RATE_LIMIT_WINDOW_MS, type Env } from '../config/env.schema';
import { parseDuration } from './token.service';
import {
  clearRefreshCookie,
  isAllowedOrigin,
  readRefreshCookie,
  refreshCookiePath,
  setRefreshCookie,
  type CookieOptions,
} from './refresh-cookie';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { SelfService } from '../common/decorators/self-service.decorator';
import type { RequestWithContext } from '../common/request-context';
import { AuthService, type AuthContext } from './auth.service';
import {
  ChangePasswordDto,
  LoginDto,
  RefreshDto,
  RegisterDto,
  RequestPasswordResetDto,
  ResetPasswordDto,
  VerifyEmailDto,
} from './dto/auth.dto';

function contextOf(request: RequestWithContext): AuthContext {
  return {
    requestId: request.requestId,
    ipAddress: request.ip,
    userAgent: request.header('user-agent'),
  };
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
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
    const pair = await this.auth.login(body.email, body.password, contextOf(request));
    setRefreshCookie(response, pair.refreshToken, this.cookieOptions());
    // The refresh token is deliberately absent from the body. Returning it here
    // would put it back within reach of any injected script, which is the whole
    // thing this change exists to prevent.
    return { accessToken: pair.accessToken, expiresIn: pair.expiresIn };
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
    const presented = readRefreshCookie(request) ?? body.refreshToken ?? null;
    if (presented === null) {
      throw new DomainError(TradingErrorCode.UNAUTHENTICATED, 'No refresh token was presented');
    }
    const pair = await this.auth.refresh(presented, contextOf(request));
    setRefreshCookie(response, pair.refreshToken, this.cookieOptions());
    return { accessToken: pair.accessToken, expiresIn: pair.expiresIn };
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
