import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { IdempotencyStore } from './idempotency.js';

describe('IdempotencyStore', () => {
  let store: IdempotencyStore;

  beforeEach(() => {
    store = new IdempotencyStore(1000); // 1 second TTL for tests
  });

  afterEach(() => {
    store.clear();
  });

  it('should return false for a new key', () => {
    expect(store.isDuplicate('key-1')).toBe(false);
  });

  it('should return true for a duplicate key', () => {
    store.isDuplicate('key-1');
    expect(store.isDuplicate('key-1')).toBe(true);
  });

  it('should track different keys independently', () => {
    expect(store.isDuplicate('key-a')).toBe(false);
    expect(store.isDuplicate('key-b')).toBe(false);
    expect(store.isDuplicate('key-a')).toBe(true);
    expect(store.isDuplicate('key-b')).toBe(true);
  });

  it('should expire keys after TTL', () => {
    vi.useFakeTimers();
    try {
      const timedStore = new IdempotencyStore(500);
      expect(timedStore.isDuplicate('expire-key')).toBe(false);
      expect(timedStore.isDuplicate('expire-key')).toBe(true);

      // Advance time past TTL
      vi.advanceTimersByTime(600);

      // After TTL, key should no longer be considered duplicate
      expect(timedStore.isDuplicate('expire-key')).toBe(false);
      timedStore.clear();
    } finally {
      vi.useRealTimers();
    }
  });

  it('should track store size', () => {
    expect(store.size).toBe(0);
    store.isDuplicate('key-1');
    expect(store.size).toBe(1);
    store.isDuplicate('key-2');
    expect(store.size).toBe(2);
    // Duplicate should not increase size
    store.isDuplicate('key-1');
    expect(store.size).toBe(2);
  });

  it('should clear all keys', () => {
    store.isDuplicate('key-1');
    store.isDuplicate('key-2');
    expect(store.size).toBe(2);
    store.clear();
    expect(store.size).toBe(0);
    // After clear, keys should be treated as new
    expect(store.isDuplicate('key-1')).toBe(false);
  });
});
