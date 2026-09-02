import { describe, expect, it } from 'vitest';
import {
  HANDLE_LENGTH,
  credentialMatches,
  hashCredentialSecret,
  looksLikeCredential,
  mintCredential,
  parseCredential,
} from './credential';

describe('a minted credential', () => {
  it('has the documented shape, and its parts agree with each other', () => {
    const key = mintCredential('api_key');
    expect(key.token).toMatch(/^tpk_[a-zA-Z0-9]{12}_[A-Za-z0-9_-]{43}$/);
    expect(key.fingerprint).toBe(`tpk_${key.handle}`);
    expect(key.token.startsWith(`${key.fingerprint}_`)).toBe(true);
    expect(key.handle).toHaveLength(HANDLE_LENGTH);

    const token = mintCredential('service_token');
    expect(token.token.startsWith('tps_')).toBe(true);
    expect(token.kind).toBe('service_token');
  });

  it('never carries the secret in what is stored', () => {
    const key = mintCredential('api_key');
    const secret = key.token.slice(key.fingerprint.length + 1);
    expect(key.secretHash).not.toContain(secret);
    expect(key.secretHash).toBe(hashCredentialSecret(secret));
    expect(key.secretHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is different every time', () => {
    const handles = new Set<string>();
    const hashes = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const key = mintCredential('api_key');
      handles.add(key.handle);
      hashes.add(key.secretHash);
    }
    expect(handles.size).toBe(200);
    expect(hashes.size).toBe(200);
  });

  it('uses no character that reads ambiguously in a handle', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(mintCredential('api_key').handle).not.toMatch(/[0O1lI]/);
    }
  });
});

describe('parsing', () => {
  it('round-trips what was minted', () => {
    const key = mintCredential('api_key');
    const parsed = parseCredential(key.token);
    expect(parsed).not.toBeNull();
    expect(parsed?.kind).toBe('api_key');
    expect(parsed?.handle).toBe(key.handle);
    expect(parsed?.fingerprint).toBe(key.fingerprint);
    expect(credentialMatches(key.secretHash, parsed?.secret ?? '')).toBe(true);
  });

  it('recognises the kind from the prefix and nothing else', () => {
    const key = mintCredential('api_key');
    expect(looksLikeCredential(key.token)).toBe(true);
    expect(looksLikeCredential('eyJhbGciOiJIUzI1NiJ9.e30.x')).toBe(false);
    expect(looksLikeCredential('')).toBe(false);
  });

  it('refuses anything that is not exactly the shape', () => {
    const key = mintCredential('api_key');
    expect(parseCredential(key.token.slice(0, -1))).toBeNull();
    expect(parseCredential(`${key.token}x`)).toBeNull();
    expect(parseCredential(key.token.replace('tpk_', 'tpx_'))).toBeNull();
    expect(parseCredential(key.token.replace('_', '-'))).toBeNull();
    expect(parseCredential('tpk_')).toBeNull();
    expect(parseCredential(`tpk_${'0'.repeat(12)}_${'a'.repeat(43)}`)).toBeNull();
  });
});

describe('matching', () => {
  it('accepts the secret and refuses one character off', () => {
    const key = mintCredential('api_key');
    const secret = key.token.slice(key.fingerprint.length + 1);
    expect(credentialMatches(key.secretHash, secret)).toBe(true);
    const flipped = (secret[0] === 'a' ? 'b' : 'a') + secret.slice(1);
    expect(credentialMatches(key.secretHash, flipped)).toBe(false);
  });

  it('refuses a stored hash that is empty or malformed rather than matching it', () => {
    expect(credentialMatches('', 'anything')).toBe(false);
    expect(credentialMatches('zz', 'anything')).toBe(false);
  });
});
