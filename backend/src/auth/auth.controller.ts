import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  adminActionRequestSchema,
  changePasswordRequestSchema,
  disableTwoFactorRequestSchema,
  resetTwoFactorRequestSchema,
  forgotPasswordRequestSchema,
  loginRequestSchema,
  resetPasswordRequestSchema,
  stepUpRequestSchema,
  verifyTwoFactorRequestSchema,
} from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AllowIncomplete, Authenticated, ClientInfo, CurrentActor, CurrentSessionId, Public, RequestInfo, RequirePermission } from '../access/decorators';
import { Clock } from '../common/clock';
import { createZodDto } from '../common/zod-validation.pipe';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { AuthService, type IssuedSession } from './auth.service';
import { SessionIdentityProvider } from './session/session-identity.provider';
import { clearCookieOptions, SESSION_COOKIE, sessionCookieOptions } from './session/session-cookie';

class LoginDto extends createZodDto(loginRequestSchema) {}
class StepUpDto extends createZodDto(stepUpRequestSchema) {}
class VerifyDto extends createZodDto(verifyTwoFactorRequestSchema) {}
class DisableDto extends createZodDto(disableTwoFactorRequestSchema) {}
class ChangePasswordDto extends createZodDto(changePasswordRequestSchema) {}
class ForgotDto extends createZodDto(forgotPasswordRequestSchema) {}
class ResetDto extends createZodDto(resetPasswordRequestSchema) {}
class AdminActionDto extends createZodDto(adminActionRequestSchema) {}
class ResetTwoFactorDto extends createZodDto(resetTwoFactorRequestSchema) {}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly identity: SessionIdentityProvider,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private setCookie(res: Response, session: IssuedSession): void {
    res.cookie(SESSION_COOKIE, session.token, sessionCookieOptions(this.env, session.rememberMe, session.absoluteExpiresAt, this.clock.now().getTime()));
  }

  // ----------------------------------------------------------------- login and logout

  @Post('login')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Log in with Emp-ID and password. Sets the session cookie. The answer says what is still to do (2FA, new password).' })
  async login(@Body() body: LoginDto, @ClientInfo() client: RequestInfo, @Res({ passthrough: true }) res: Response) {
    const { result, session } = await this.auth.login(body, client);
    if (session) this.setCookie(res, session);
    return { ...result, csrfToken: session?.csrfToken };
  }

  @Post('logout')
  @Authenticated()
  @AllowIncomplete()
  @HttpCode(200)
  @ApiOperation({ summary: 'Log out this device now' })
  async logout(@CurrentSessionId() sessionId: string | null, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(sessionId);
    res.clearCookie(SESSION_COOKIE, clearCookieOptions(this.env));
    return { ok: true };
  }

  @Get('me')
  @Authenticated()
  @AllowIncomplete()
  @ApiOperation({ summary: 'Who am I, how far has my login got, and what may I do? Also returns the CSRF token for change requests.' })
  async me(@CurrentActor() actor: Actor, @Req() req: Request) {
    const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE] ?? null;
    const identity = await this.identity.resolve(req, { financeScreen: false });
    return this.auth.me(actor, token, identity?.stage ?? 'ok');
  }

  // ----------------------------------------------------------------- two-step login

  @Post('2fa/setup')
  @Authenticated()
  @AllowIncomplete()
  @HttpCode(200)
  @ApiOperation({ summary: 'Start setting up the authenticator app. The secret is shown once.' })
  twoFactorSetup(@CurrentActor() actor: Actor) {
    return this.auth.twoFactorSetup(actor);
  }

  @Post('2fa/verify')
  @Authenticated()
  @AllowIncomplete()
  @HttpCode(200)
  @ApiOperation({ summary: 'Check the 6-digit code on the server. The first correct code also confirms the set-up.' })
  twoFactorVerify(@CurrentActor() actor: Actor, @CurrentSessionId() sessionId: string | null, @Body() body: VerifyDto, @ClientInfo() client: RequestInfo) {
    return this.auth.twoFactorVerify(actor, sessionId ?? '', body.code, client);
  }

  @Post('step-up')
  @Authenticated()
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirm again: password (and authenticator code) checked on the server; risky actions then work for 5 minutes' })
  stepUp(@CurrentActor() actor: Actor, @CurrentSessionId() sessionId: string | null, @Body() body: StepUpDto, @ClientInfo() client: RequestInfo) {
    return this.auth.stepUp(actor, sessionId ?? '', body, client);
  }

  @Post('2fa/disable')
  @Authenticated()
  @HttpCode(200)
  @ApiOperation({ summary: 'Switch two-step login off (only where it is optional)' })
  async twoFactorDisable(@CurrentActor() actor: Actor, @Body() body: DisableDto, @ClientInfo() client: RequestInfo) {
    await this.auth.twoFactorDisable(actor, body, client);
    return { ok: true };
  }

  @Get('2fa')
  @Authenticated()
  @ApiOperation({ summary: 'Is two-step login required for me, and is it on?' })
  twoFactorStatus(@CurrentActor() actor: Actor) {
    return this.auth.twoFactorStatus(actor);
  }

  // ----------------------------------------------------------------- passwords

  @Post('password/change')
  @Authenticated()
  @AllowIncomplete()
  @HttpCode(200)
  @ApiOperation({ summary: 'Change my password. Ends my sessions on every device and starts a fresh one here.' })
  async changePassword(
    @CurrentActor() actor: Actor,
    @CurrentSessionId() sessionId: string | null,
    @Body() body: ChangePasswordDto,
    @ClientInfo() client: RequestInfo,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { session, stage } = await this.auth.changePassword(actor, sessionId ?? '', body, client);
    this.setCookie(res, session);
    return { ok: true, stage, csrfToken: session.csrfToken };
  }

  @Post('password/forgot')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Email a one-time reset link (valid 15 minutes) to the official acevatech.com address. Always answers the same way.' })
  async forgotPassword(@Body() body: ForgotDto, @ClientInfo() client: RequestInfo) {
    await this.auth.forgotPassword(body, client);
    return { sent: true };
  }

  @Post('password/reset')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Choose a new password with a reset link (works once)' })
  async resetPassword(@Body() body: ResetDto, @ClientInfo() client: RequestInfo) {
    await this.auth.resetPassword(body, client);
    return { ok: true };
  }

  // ----------------------------------------------------------------- My devices

  @Get('sessions')
  @Authenticated()
  @ApiOperation({ summary: 'My devices: where I am logged in' })
  sessions(@CurrentActor() actor: Actor, @CurrentSessionId() sessionId: string | null) {
    return this.auth.listSessions(actor, sessionId);
  }

  @Delete('sessions/:id')
  @Authenticated()
  @ApiOperation({ summary: 'Log out one of MY other devices' })
  async endSession(@CurrentActor() actor: Actor, @CurrentSessionId() current: string | null, @Param('id', new ParseUUIDPipe()) id: string, @ClientInfo() client: RequestInfo) {
    await this.auth.endSession(actor, id, current, client);
    return { ok: true };
  }

  @Delete('sessions')
  @Authenticated()
  @ApiOperation({ summary: 'Log out all my other devices' })
  endOthers(@CurrentActor() actor: Actor, @CurrentSessionId() current: string | null) {
    return this.auth.endOtherSessions(actor, current);
  }

  @Get('login-history')
  @Authenticated()
  @ApiOperation({ summary: 'My recent logins and failed attempts' })
  loginHistory(@CurrentActor() actor: Actor) {
    return this.auth.loginHistory(actor);
  }

  // ----------------------------------------------------------------- administration

  @Post('employees/:empId/unlock')
  @RequirePermission('auth.unlock_account')
  @HttpCode(200)
  @ApiOperation({ summary: 'Unlock a locked account (someone above them in the reporting line, or HR)' })
  async unlock(@CurrentActor() actor: Actor, @Param('empId') empId: string, @Body() body: AdminActionDto, @ClientInfo() client: RequestInfo) {
    await this.auth.unlock(actor, empId, body.reason, client);
    return { ok: true };
  }

  @Post('employees/:empId/force-logout')
  @RequirePermission('session.force_logout')
  @HttpCode(200)
  @ApiOperation({ summary: 'Log someone below me out on every device, at once' })
  forceLogout(@CurrentActor() actor: Actor, @Param('empId') empId: string, @Body() body: AdminActionDto, @ClientInfo() client: RequestInfo) {
    return this.auth.forceLogout(actor, empId, body.reason, client);
  }

  @Post('employees/:empId/reset-2fa')
  @RequirePermission('auth.reset_two_factor')
  @HttpCode(200)
  @ApiOperation({ summary: 'Lost authenticator phone: reset two-step login for someone of lower rank (reason required)' })
  resetTwoFactor(@CurrentActor() actor: Actor, @Param('empId') empId: string, @Body() body: ResetTwoFactorDto, @ClientInfo() client: RequestInfo) {
    return this.auth.resetTwoFactor(actor, empId, body.reason, client);
  }

  @Post('employees/:empId/temporary-password')
  @RequirePermission('auth.set_temporary_password')
  @HttpCode(200)
  @ApiOperation({ summary: 'Director or HR: set a temporary password for someone with no official email (shown once)' })
  setTemporaryPassword(@CurrentActor() actor: Actor, @Param('empId') empId: string, @Body() body: AdminActionDto, @ClientInfo() client: RequestInfo) {
    return this.auth.setTemporaryPassword(actor, empId, body.reason, client);
  }
}
