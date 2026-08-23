import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
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
  constructor(private readonly auth: AuthService) {}

  /**
   * Returns 202, not 201, and carries no body.
   *
   * The response is identical whether or not the address was already
   * registered — see AuthService.register. Returning the new user id here would
   * undo that, so nothing is returned at all.
   */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
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
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange credentials for an access and refresh token' })
  login(@Body() body: LoginDto, @Req() request: RequestWithContext) {
    return this.auth.login(body.email, body.password, contextOf(request));
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate a refresh token. Reusing one revokes the whole session family.',
  })
  refresh(@Body() body: RefreshDto, @Req() request: RequestWithContext) {
    return this.auth.refresh(body.refreshToken, contextOf(request));
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke a refresh token and its family' })
  async logout(@Body() body: RefreshDto, @Req() request: RequestWithContext): Promise<void> {
    await this.auth.logout(body.refreshToken, contextOf(request));
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
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('password-reset')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Request a password-reset link' })
  async requestPasswordReset(@Body() body: RequestPasswordResetDto): Promise<{ status: string }> {
    await this.auth.requestPasswordReset(body.email);
    return { status: 'if that address is registered, a reset link has been sent' };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('password-reset/confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Complete a password reset. Revokes every existing session.' })
  async resetPassword(@Body() body: ResetPasswordDto): Promise<void> {
    await this.auth.resetPassword(body.token, body.password);
  }

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
