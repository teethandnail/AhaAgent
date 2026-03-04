import { describe, it, expect } from 'vitest';

import { parseEnvelope, validateEnvelope } from './envelope.js';

const validEnvelope = {
  protocolVersion: '1.0' as const,
  sessionId: 'abcdefgh12345678',
  requestId: 'req-12345678',
  idempotencyKey: 'idem-12345678',
  timestamp: '2026-01-01T00:00:00.000Z',
  type: 'send_message',
  payload: { text: 'hello' },
};

describe('validateEnvelope', () => {
  it('should accept a valid envelope', () => {
    expect(validateEnvelope(validEnvelope)).toBe(true);
  });

  it('should reject null', () => {
    expect(validateEnvelope(null)).toBe(false);
  });

  it('should reject non-object', () => {
    expect(validateEnvelope('string')).toBe(false);
  });

  it('should reject wrong protocolVersion', () => {
    expect(validateEnvelope({ ...validEnvelope, protocolVersion: '2.0' })).toBe(false);
  });

  it('should reject missing protocolVersion', () => {
    const { protocolVersion: _, ...rest } = validEnvelope;
    expect(validateEnvelope(rest)).toBe(false);
  });

  it('should reject short sessionId', () => {
    expect(validateEnvelope({ ...validEnvelope, sessionId: 'short' })).toBe(false);
  });

  it('should reject missing sessionId', () => {
    const { sessionId: _, ...rest } = validEnvelope;
    expect(validateEnvelope(rest)).toBe(false);
  });

  it('should reject short requestId', () => {
    expect(validateEnvelope({ ...validEnvelope, requestId: 'abc' })).toBe(false);
  });

  it('should reject short idempotencyKey', () => {
    expect(validateEnvelope({ ...validEnvelope, idempotencyKey: '1234567' })).toBe(false);
  });

  it('should accept exactly 8-char idempotencyKey', () => {
    expect(validateEnvelope({ ...validEnvelope, idempotencyKey: '12345678' })).toBe(true);
  });

  it('should reject empty type', () => {
    expect(validateEnvelope({ ...validEnvelope, type: '' })).toBe(false);
  });

  it('should reject missing type', () => {
    const { type: _, ...rest } = validEnvelope;
    expect(validateEnvelope(rest)).toBe(false);
  });

  it('should reject null payload', () => {
    expect(validateEnvelope({ ...validEnvelope, payload: null })).toBe(false);
  });

  it('should reject non-object payload', () => {
    expect(validateEnvelope({ ...validEnvelope, payload: 'string' })).toBe(false);
  });

  it('should reject missing payload', () => {
    const { payload: _, ...rest } = validEnvelope;
    expect(validateEnvelope(rest)).toBe(false);
  });

  it('should reject missing timestamp', () => {
    const { timestamp: _, ...rest } = validEnvelope;
    expect(validateEnvelope(rest)).toBe(false);
  });

  it('should reject empty timestamp', () => {
    expect(validateEnvelope({ ...validEnvelope, timestamp: '' })).toBe(false);
  });
});

describe('parseEnvelope', () => {
  it('should parse valid JSON envelope', () => {
    const raw = JSON.stringify(validEnvelope);
    const result = parseEnvelope(raw);
    expect(result).toEqual(validEnvelope);
  });

  it('should throw on invalid JSON', () => {
    expect(() => parseEnvelope('not json')).toThrow('Invalid JSON');
  });

  it('should throw on valid JSON but invalid envelope', () => {
    expect(() => parseEnvelope(JSON.stringify({ foo: 'bar' }))).toThrow('Invalid envelope');
  });

  it('should throw on empty string', () => {
    expect(() => parseEnvelope('')).toThrow('Invalid JSON');
  });
});
