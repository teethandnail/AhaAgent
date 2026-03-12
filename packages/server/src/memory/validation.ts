import type { MemoryEntry } from './memory-controller.js';

const VALID_CATEGORIES: MemoryEntry['category'][] = ['preference', 'fact', 'skill', 'context'];
const VALID_SENSITIVITIES: MemoryEntry['sensitivity'][] = ['public', 'restricted', 'secret'];
const SECRET_PATTERNS = [
  /-----begin [a-z ]*private key-----/i,
  /\bsk-[a-z0-9]{16,}\b/i,
  /\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|secret)\b\s*[:=]/i,
  /\bbearer\s+[a-z0-9._-]{16,}\b/i,
];
const TEMPORARY_PATTERNS = [
  /\btemporary\b/i,
  /\btemp\b/i,
  /\bone[- ]off\b/i,
  /\bdebug\b/i,
  /\bthis session only\b/i,
  /\bcurrent task\b/i,
  /\bscratch\b/i,
];

export interface MemoryStoreInput {
  content: string;
  category: string;
  sensitivity?: string;
}

export type MemoryStoreValidationResult =
  | {
      ok: true;
      value: {
        content: string;
        category: MemoryEntry['category'];
        sensitivity: MemoryEntry['sensitivity'];
      };
    }
  | {
      ok: false;
      error: string;
    };

export function validateMemoryStoreInput(
  input: MemoryStoreInput,
): MemoryStoreValidationResult {
  const content = input.content.trim();
  const lineCount = content.split(/\r?\n/).length;
  const sensitivity =
    typeof input.sensitivity === 'string' ? input.sensitivity : 'public';

  if (!VALID_CATEGORIES.includes(input.category as MemoryEntry['category'])) {
    return { ok: false, error: 'Invalid memory category' };
  }

  if (!VALID_SENSITIVITIES.includes(sensitivity as MemoryEntry['sensitivity'])) {
    return { ok: false, error: 'Invalid memory sensitivity' };
  }

  if (content.length < 8) {
    return { ok: false, error: 'Memory content is too short to be durable' };
  }

  if (content.length > 500) {
    return { ok: false, error: 'Memory content is too long; store a compact fact instead' };
  }

  if (lineCount > 8) {
    return { ok: false, error: 'Memory content has too many lines; summarize it first' };
  }

  if (TEMPORARY_PATTERNS.some((pattern) => pattern.test(content))) {
    return { ok: false, error: 'Temporary or one-off details should not be stored as long-term memory' };
  }

  if (SECRET_PATTERNS.some((pattern) => pattern.test(content))) {
    return { ok: false, error: 'Sensitive secrets or credentials must not be stored in memory' };
  }

  return {
    ok: true,
    value: {
      content,
      category: input.category as MemoryEntry['category'],
      sensitivity: sensitivity as MemoryEntry['sensitivity'],
    },
  };
}
