import { Injectable } from '@nestjs/common';
import { generateSecret, generateURI, verifySync } from 'otplib';

export const TOTP_PERIOD_SECONDS = 30;

export interface TotpCheck {
  valid: boolean;
  /** The 30-second time step the code belongs to (used to refuse the same code twice). */
  step?: number;
}

/**
 * Two-step login with an authenticator app (Google or Microsoft Authenticator): 6-digit codes that change every
 * 30 seconds. The server verifies the code; the secret is stored encrypted (see CryptoService).
 */
@Injectable()
export class TotpService {
  newSecret(): string {
    return generateSecret();
  }

  /** The link an authenticator app understands (shown as a QR code by the screen). */
  otpauthUrl(empId: string, secret: string): string {
    return generateURI({ issuer: 'Aceva', label: empId, secret });
  }

  /**
   * Checks a code at the given moment, allowing one step either side (clock drift). A code from a step that
   * was already used (`lastUsedStep` or older) is refused, so a spied code cannot be replayed.
   */
  verify(secret: string, code: string, at: Date, lastUsedStep?: number | null): TotpCheck {
    if (!/^\d{6}$/.test(code)) return { valid: false };
    const result = verifySync({ secret, token: code, epoch: at.getTime() / 1000, epochTolerance: TOTP_PERIOD_SECONDS });
    if (!result.valid) return { valid: false };
    const step = (result as { timeStep: number }).timeStep;
    if (lastUsedStep !== null && lastUsedStep !== undefined && step <= lastUsedStep) return { valid: false };
    return { valid: true, step };
  }
}
