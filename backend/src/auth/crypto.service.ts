import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';

/**
 * The small set of cryptographic helpers the app needs.
 *  - encrypt / decrypt: AES-256-GCM for secrets that must be read back later (2FA secrets, and later
 *    CNIC and bank numbers). The key comes from DATA_ENCRYPTION_KEY, never from the code or the database.
 *  - sha256 / randomToken: for tokens (session, CSRF, password reset). Only the hash of a token is ever stored.
 */
@Injectable()
export class CryptoService {
  private readonly key: Buffer;
  private readonly keyId: string;

  constructor(@Inject(ENV) env: Env) {
    this.key = Buffer.from(env.DATA_ENCRYPTION_KEY, 'base64');
    this.keyId = env.DATA_ENCRYPTION_KEY_ID;
  }

  /** Returns "keyId:iv:authTag:ciphertext" (each part base64). A new random IV is used every time. */
  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [this.keyId, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
  }

  /** Throws if the data was changed or the key is wrong. */
  decrypt(payload: string): string {
    const [keyId, iv, tag, ciphertext] = payload.split(':');
    if (!keyId || !iv || !tag || !ciphertext) throw new Error('Malformed encrypted value');
    if (keyId !== this.keyId) throw new Error(`Encrypted with key "${keyId}", which is not loaded`);
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
  }

  sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  /**
   * The CSRF token that belongs to a session: an HMAC of the session token with a key derived from the
   * encryption key. Stable across page reloads and tabs, impossible to guess without the session token, and only
   * its hash is stored.
   */
  csrfTokenFor(sessionToken: string): string {
    const csrfKey = createHmac('sha256', this.key).update('aceva-csrf-v1').digest();
    return createHmac('sha256', csrfKey).update(sessionToken).digest('base64url');
  }

  /** A random, URL-safe token (256 bits by default). */
  randomToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  /** Compares two hex hashes in constant time. */
  safeEqual(a: string, b: string): boolean {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  }
}
