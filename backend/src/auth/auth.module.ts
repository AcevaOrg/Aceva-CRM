import { Global, Module } from '@nestjs/common';
import { IdentityProvider } from '../identity/identity.provider';
import { Mailer, SmtpMailer } from '../mail/mailer';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthStateService } from './auth-state.service';
import { LoginThrottleService } from './login-throttle.service';
import { PasswordService } from './password.service';
import { SessionIdentityProvider } from './session/session-identity.provider';
import { SessionService } from './session/session.service';
import { SessionStore, RedisSessionStore } from './session/session-store';
import { SessionSweeper } from './session/session-sweeper';
import { TotpService } from './totp.service';

/** Module 2: Emp-ID login, passwords, two-step login, sessions. */
@Global()
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthStateService,
    LoginThrottleService,
    PasswordService,
    TotpService,
    SessionService,
    SessionSweeper,
    SessionIdentityProvider,
    { provide: SessionStore, useClass: RedisSessionStore },
    { provide: Mailer, useClass: SmtpMailer },
    // The session cookie is the only way to be identified.
    { provide: IdentityProvider, useClass: SessionIdentityProvider },
  ],
  exports: [AuthService, SessionService, PasswordService, IdentityProvider, Mailer],
})
export class AuthModule {}
