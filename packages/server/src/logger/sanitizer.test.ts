import { describe, it, expect } from 'vitest';
import { sanitize } from './sanitizer.js';

describe('sanitize', () => {
  it('should redact OpenAI-style API keys', () => {
    const input = 'key is sk-abc1234567890xyz';
    expect(sanitize(input)).toBe('key is [REDACTED]');
  });

  it('should redact Bearer JWT tokens', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0';
    expect(sanitize(input)).toBe('Authorization: Bearer [REDACTED]');
  });

  it('should preserve normal text unchanged', () => {
    const input = 'This is a perfectly normal log message with no secrets.';
    expect(sanitize(input)).toBe(input);
  });

  it('should redact password-like fields in JSON strings', () => {
    const input = '{"password": "hunter2", "username": "alice"}';
    expect(sanitize(input)).toBe('{"password": "[REDACTED]", "username": "alice"}');
  });

  it('should redact secret fields in JSON strings', () => {
    const input = '{"secret": "s3cr3t-value"}';
    expect(sanitize(input)).toBe('{"secret": "[REDACTED]"}');
  });

  it('should redact token fields in JSON strings', () => {
    const input = '{"token": "abc123"}';
    expect(sanitize(input)).toBe('{"token": "[REDACTED]"}');
  });

  it('should redact apiKey fields in JSON strings', () => {
    const input = '{"apiKey": "my-key-value"}';
    expect(sanitize(input)).toBe('{"apiKey": "[REDACTED]"}');
  });

  it('should redact api_key fields in JSON strings', () => {
    const input = '{"api_key": "my-key-value"}';
    expect(sanitize(input)).toBe('{"api_key": "[REDACTED]"}');
  });

  it('should redact PEM private keys', () => {
    const input =
      'cert: -----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJ...\n-----END RSA PRIVATE KEY-----';
    expect(sanitize(input)).toBe('cert: [REDACTED]');
  });

  it('should handle multiple sensitive patterns in one string', () => {
    const input = 'key=sk-abcdefghij1234 auth=Bearer eyJhbGciOiJIUzI1NiJ9.payload';
    const result = sanitize(input);
    expect(result).not.toContain('sk-');
    expect(result).not.toContain('eyJ');
    expect(result).toContain('[REDACTED]');
  });
});
