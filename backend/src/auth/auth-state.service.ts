import { Injectable } from '@nestjs/common';
import type { SessionStage } from '../identity/identity.provider';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type Db = PrismaService | Prisma.TransactionClient;

export interface AuthState {
  /** false when the person has left, the login is disabled, or there is no credential */
  canLogIn: boolean;
  locked: boolean;
  mustChangePassword: boolean;
  /** 2FA is mandatory for this person: levels 1 to 3, or a duty that requires it (Finance). */
  twoFactorRequired: boolean;
  /** An authenticator app is set up and confirmed. */
  twoFactorEnabled: boolean;
  hasFinanceDuty: boolean;
}

/**
 * What a person still has to do before they may use the app. Always read fresh from the database,
 * so a change (new duty, temporary password) applies on the very next request.
 */
@Injectable()
export class AuthStateService {
  constructor(private readonly prisma: PrismaService) {}

  async get(employeeId: string, db: Db = this.prisma): Promise<AuthState | null> {
    const e = await db.employee.findUnique({
      where: { id: employeeId },
      select: {
        status: true,
        level: { select: { number: true } },
        credential: { select: { mustChangePassword: true, loginDisabledAt: true, lockedAt: true } },
        totpSecret: { select: { confirmedAt: true } },
        duties: { where: { endedAt: null }, select: { duty: { select: { key: true, requiresTwoFactor: true } } } },
      },
    });
    if (!e) return null;
    const dutyNeeds2fa = e.duties.some((d) => d.duty.requiresTwoFactor);
    const enabled = !!e.totpSecret?.confirmedAt;
    return {
      canLogIn: !!e.credential && !e.credential.loginDisabledAt && e.status !== 'left',
      locked: !!e.credential?.lockedAt,
      mustChangePassword: e.credential?.mustChangePassword ?? false,
      // Plan section 6: mandatory for levels 1 to 3 and for anyone with Finance duty; optional for others.
      twoFactorRequired: e.level.number <= 3 || dutyNeeds2fa,
      twoFactorEnabled: enabled,
      hasFinanceDuty: e.duties.some((d) => d.duty.key === 'finance'),
    };
  }

  stage(state: AuthState, twoFactorVerified: boolean): SessionStage {
    if (state.mustChangePassword) return 'password_change_required';
    if ((state.twoFactorRequired || state.twoFactorEnabled) && !twoFactorVerified) {
      return state.twoFactorEnabled ? '2fa_required' : '2fa_setup_required';
    }
    return 'ok';
  }
}
