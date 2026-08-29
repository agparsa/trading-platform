import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AccountsModule } from '../accounts/accounts.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { TotpService } from './totp.service';
import { SessionsService } from './sessions.service';

@Module({
  // Secrets are passed per sign/verify call rather than registered globally:
  // access and refresh tokens use different keys, and a single default would
  // make it easy to sign one with the other's secret by omission.
  imports: [JwtModule.register({}), AccountsModule],
  controllers: [AuthController],
  providers: [AuthService, PasswordService, TokenService, TotpService, SessionsService],
  exports: [TokenService, PasswordService, TotpService, SessionsService],
})
export class AuthModule {}
