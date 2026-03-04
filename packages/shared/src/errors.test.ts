import { describe, it, expect } from 'vitest';
import { createError, ErrorCodes } from './errors.js';

describe('ErrorCodes', () => {
  it('should have correct format AHA-DOMAIN-NNN', () => {
    for (const [_key, value] of Object.entries(ErrorCodes)) {
      expect(value.code).toMatch(/^AHA-[A-Z]+-\d{3}$/);
    }
  });
});

describe('createError', () => {
  it('should create error with default message', () => {
    const err = createError('AUTH_TOKEN_INVALID');
    expect(err.code).toBe('AHA-AUTH-001');
    expect(err.retryable).toBe(false);
  });

  it('should append details to message', () => {
    const err = createError('TOOL_VERSION_CONFLICT', 'expected v3 got v2');
    expect(err.message).toContain('expected v3 got v2');
    expect(err.retryable).toBe(true);
  });
});
