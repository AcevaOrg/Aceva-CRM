import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { RefusalCounter, TokenBucket, clientAddress, originAllowed, readCookie } from './socket-rules';

const req = (headers: Record<string, string>, remoteAddress = '10.0.0.9') => ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage;

describe('Module 14 socket rules', () => {
  it('reads one cookie from a Cookie header, URL-decoded', () => {
    expect(readCookie('a=1; aceva_session=abc%2Bdef; b=2', 'aceva_session')).toBe('abc+def');
    expect(readCookie('aceva_session_x=1', 'aceva_session')).toBeNull();
    expect(readCookie('', 'aceva_session')).toBeNull();
    expect(readCookie(undefined, 'aceva_session')).toBeNull();
    expect(readCookie('aceva_session=%E0%A4%A', 'aceva_session')).toBeNull(); // malformed encoding
    expect(readCookie('aceva_session=', 'aceva_session')).toBeNull();
  });

  it('accepts only the exact website origin, never a missing one or a look-alike', () => {
    expect(originAllowed('https://app.acevatech.com', 'https://app.acevatech.com')).toBe(true);
    expect(originAllowed(undefined, 'https://app.acevatech.com')).toBe(false);
    expect(originAllowed('', 'https://app.acevatech.com')).toBe(false);
    expect(originAllowed('null', 'https://app.acevatech.com')).toBe(false);
    expect(originAllowed('https://app.acevatech.com.evil.example', 'https://app.acevatech.com')).toBe(false);
    expect(originAllowed('https://evil.acevatech.com', 'https://app.acevatech.com')).toBe(false); // same site, other subdomain
    expect(originAllowed('http://app.acevatech.com', 'https://app.acevatech.com')).toBe(false);
  });

  it('works out the client address like Express with "trust proxy" set to a number of proxies', () => {
    expect(clientAddress(req({ 'x-forwarded-for': '1.1.1.1' }), 0)).toBe('10.0.0.9'); // no proxy trusted: the header is ignored
    expect(clientAddress(req({ 'x-forwarded-for': '1.1.1.1' }), 1)).toBe('1.1.1.1');
    expect(clientAddress(req({ 'x-forwarded-for': 'spoofed, 2.2.2.2' }), 1)).toBe('2.2.2.2'); // the client cannot choose
    expect(clientAddress(req({ 'x-forwarded-for': 'spoofed, 3.3.3.3, 4.4.4.4' }), 2)).toBe('3.3.3.3');
    expect(clientAddress(req({}), 1)).toBe('10.0.0.9');
  });

  it('a token bucket allows a burst of `capacity`, then refills at the given rate', () => {
    const bucket = new TokenBucket(20, 20, 0);
    for (let i = 0; i < 20; i++) expect(bucket.take(0)).toBe(true);
    expect(bucket.take(0)).toBe(false);
    expect(bucket.take(49)).toBe(false); // 0.98 of a token
    expect(bucket.take(50)).toBe(true); // one token after 50 ms
    expect(bucket.take(50)).toBe(false);
    expect(bucket.take(10_050)).toBe(true); // never more than the capacity
    for (let i = 0; i < 19; i++) expect(bucket.take(10_050)).toBe(true);
    expect(bucket.take(10_050)).toBe(false);
  });

  it('counts refusals in a sliding second', () => {
    const counter = new RefusalCounter(3);
    expect([counter.hit(0), counter.hit(100), counter.hit(200)]).toEqual([false, false, false]);
    expect(counter.hit(300)).toBe(true);
    const fresh = new RefusalCounter(3);
    for (const t of [0, 400, 800]) fresh.hit(t);
    expect(fresh.hit(1_200)).toBe(false); // the first one is more than a second old
  });
});
