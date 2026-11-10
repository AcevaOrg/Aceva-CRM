import { describe, expect, it } from 'vitest';
import { generateSync } from 'otplib';
import { baseEnv } from '../../test/helpers/base-env';
import { CryptoService } from './crypto.service';
import { PasswordService } from './password.service';
import { TotpService } from './totp.service';

describe('CryptoService (AES-256-GCM)', () => {
  const crypto = new CryptoService(baseEnv());

  it('encrypts and decrypts, and never stores the plain text', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const encrypted = crypto.encrypt(secret);
    expect(encrypted).not.toContain(secret);
    expect(encrypted.startsWith('v1:')).toBe(true);
    expect(crypto.decrypt(encrypted)).toBe(secret);
  });

  it('uses a fresh random IV every time (same input, different output)', () => {
    expect(crypto.encrypt('same')).not.toBe(crypto.encrypt('same'));
  });

  it('detects tampering and refuses a different key', () => {
    const encrypted = crypto.encrypt('secret');
    const parts = encrypted.split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => crypto.decrypt(parts.join(':'))).toThrow();
    expect(() => new CryptoService(baseEnv()).decrypt(encrypted)).toThrow(); // a different random key
  });

  it('hashes tokens with SHA-256 and makes long random tokens', () => {
    expect(crypto.sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(crypto.randomToken().length).toBeGreaterThanOrEqual(43);
    expect(crypto.randomToken()).not.toBe(crypto.randomToken());
    expect(crypto.safeEqual('aa', 'aa')).toBe(true);
    expect(crypto.safeEqual('aa', 'ab')).toBe(false);
  });
});

describe('PasswordService (Argon2id)', () => {
  const passwords = new PasswordService(baseEnv());

  it('stores an Argon2id hash, never the password, and verifies it', async () => {
    const hash = await passwords.hash('correct horse battery');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).not.toContain('correct');
    expect(await passwords.verify(hash, 'correct horse battery')).toBe(true);
    expect(await passwords.verify(hash, 'wrong password!')).toBe(false);
    expect(await passwords.verify('not-a-hash', 'x')).toBe(false);
  });

  it('salts every hash (same password, different hash)', async () => {
    expect(await passwords.hash('same password 1')).not.toBe(await passwords.hash('same password 1'));
  });

  it('requires at least 10 characters', () => {
    expect(passwords.violations('123456789')).toHaveLength(1);
    expect(passwords.violations('1234567890')).toEqual([]);
    expect(passwords.violations('x'.repeat(129))).toHaveLength(1);
  });

  it('flags hashes made with weaker settings for an upgrade', async () => {
    const weak = new PasswordService(baseEnv({ ARGON2_MEMORY_KIB: '1024', ARGON2_TIME_COST: '1' }));
    const strong = new PasswordService(baseEnv({ ARGON2_MEMORY_KIB: '2048', ARGON2_TIME_COST: '2' }));
    expect(strong.needsRehash(await weak.hash('password-123456'))).toBe(true);
    expect(weak.needsRehash(await weak.hash('password-123456'))).toBe(false);
  });

  it('generates temporary passwords that meet the policy', () => {
    const a = passwords.generateTemporaryPassword();
    expect(passwords.violations(a)).toEqual([]);
    expect(a).not.toBe(passwords.generateTemporaryPassword());
  });
});

describe('TotpService', () => {
  const totp = new TotpService();
  const secret = totp.newSecret();
  const at = new Date('2026-11-10T10:00:10Z');
  const codeAt = (date: Date) => generateSync({ secret, epoch: date.getTime() / 1000 });

  it('accepts the current code and refuses wrong codes and bad formats', () => {
    expect(totp.verify(secret, codeAt(at), at).valid).toBe(true);
    expect(totp.verify(secret, '000000', at).valid).toBe(false);
    expect(totp.verify(secret, '12345', at).valid).toBe(false);
    expect(totp.verify(secret, 'abcdef', at).valid).toBe(false);
  });

  it('allows one step of clock drift but not more', () => {
    expect(totp.verify(secret, codeAt(new Date(at.getTime() - 30_000)), at).valid).toBe(true);
    expect(totp.verify(secret, codeAt(new Date(at.getTime() - 120_000)), at).valid).toBe(false);
  });

  it('refuses a code that was already used (replay)', () => {
    const first = totp.verify(secret, codeAt(at), at);
    expect(first.valid).toBe(true);
    expect(totp.verify(secret, codeAt(at), at, first.step).valid).toBe(false);
    const later = new Date(at.getTime() + 60_000);
    expect(totp.verify(secret, codeAt(later), later, first.step).valid).toBe(true);
  });

  it('builds an authenticator link for the Emp-ID', () => {
    expect(totp.otpauthUrl('ACV-0003', secret)).toMatch(/^otpauth:\/\/totp\/Aceva:ACV-0003\?secret=/);
  });
});
