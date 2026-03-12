import { describe, expect, it } from 'vitest';
import { validateMemoryStoreInput } from './validation.js';

describe('validateMemoryStoreInput', () => {
  it('accepts valid durable memory content', () => {
    const result = validateMemoryStoreInput({
      content: 'User prefers concise code review summaries.',
      category: 'preference',
      sensitivity: 'public',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe('User prefers concise code review summaries.');
    }
  });

  it('rejects invalid category', () => {
    const result = validateMemoryStoreInput({
      content: 'Project uses TypeScript strict mode.',
      category: 'invalid',
    });

    expect(result).toEqual({
      ok: false,
      error: 'Invalid memory category',
    });
  });

  it('rejects content that is too short', () => {
    const result = validateMemoryStoreInput({
      content: 'short',
      category: 'fact',
    });

    expect(result.ok).toBe(false);
  });

  it('rejects temporary details', () => {
    const result = validateMemoryStoreInput({
      content: 'Temporary debug note for current task only.',
      category: 'context',
    });

    expect(result).toEqual({
      ok: false,
      error: 'Temporary or one-off details should not be stored as long-term memory',
    });
  });

  it('rejects obvious secrets', () => {
    const result = validateMemoryStoreInput({
      content: 'API key: sk-abcdefghijklmnopqrstuvwxyz123456',
      category: 'fact',
      sensitivity: 'secret',
    });

    expect(result).toEqual({
      ok: false,
      error: 'Sensitive secrets or credentials must not be stored in memory',
    });
  });
});
