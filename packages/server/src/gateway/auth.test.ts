import { describe, it, expect } from 'vitest';

import { generateSessionToken, validateOrigin, validateSessionToken } from './auth.js';

describe('generateSessionToken', () => {
  it('should return a 64-char hex string', () => {
    const token = generateSessionToken();
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should generate unique tokens on each call', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateSessionToken()));
    expect(tokens.size).toBe(100);
  });
});

describe('validateSessionToken', () => {
  it('should return true for matching tokens', () => {
    const token = generateSessionToken();
    expect(validateSessionToken(token, token)).toBe(true);
  });

  it('should return false for mismatched tokens', () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(validateSessionToken(a, b)).toBe(false);
  });

  it('should return false when expected is empty', () => {
    expect(validateSessionToken('', 'sometoken')).toBe(false);
  });

  it('should return false when actual is empty', () => {
    expect(validateSessionToken('sometoken', '')).toBe(false);
  });

  it('should return false when both are empty', () => {
    expect(validateSessionToken('', '')).toBe(false);
  });

  it('should return false for different-length tokens', () => {
    expect(validateSessionToken('short', 'muchlongertoken')).toBe(false);
  });
});

describe('validateOrigin', () => {
  const port = 3000;

  it('should accept http://localhost:<port>', () => {
    expect(validateOrigin(`http://localhost:${String(port)}`, port)).toBe(true);
  });

  it('should accept http://127.0.0.1:<port>', () => {
    expect(validateOrigin(`http://127.0.0.1:${String(port)}`, port)).toBe(true);
  });

  it('should reject https origin', () => {
    expect(validateOrigin(`https://localhost:${String(port)}`, port)).toBe(false);
  });

  it('should reject wrong port', () => {
    expect(validateOrigin('http://localhost:9999', port)).toBe(false);
  });

  it('should reject external origin', () => {
    expect(validateOrigin('http://evil.com:3000', port)).toBe(false);
  });

  it('should reject undefined origin', () => {
    expect(validateOrigin(undefined, port)).toBe(false);
  });

  it('should reject empty string origin', () => {
    expect(validateOrigin('', port)).toBe(false);
  });
});
