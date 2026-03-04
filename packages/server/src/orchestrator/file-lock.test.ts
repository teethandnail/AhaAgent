import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FileLock } from './file-lock.js';

describe('FileLock', () => {
  let lock: FileLock;

  beforeEach(() => {
    lock = new FileLock();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should acquire a lock on an unlocked file', () => {
    const result = lock.acquire('/src/foo.ts', 'task-1', 5000);
    expect(result).toBe(true);
    expect(lock.isLocked('/src/foo.ts')).toBe(true);
  });

  it('should allow same task to re-acquire (reentrant)', () => {
    lock.acquire('/src/foo.ts', 'task-1', 5000);
    const result = lock.acquire('/src/foo.ts', 'task-1', 5000);
    expect(result).toBe(true);
    expect(lock.isLocked('/src/foo.ts')).toBe(true);
  });

  it('should reject acquisition by a different task', () => {
    lock.acquire('/src/foo.ts', 'task-1', 5000);
    const result = lock.acquire('/src/foo.ts', 'task-2', 5000);
    expect(result).toBe(false);
  });

  it('should release a lock held by the owning task', () => {
    lock.acquire('/src/foo.ts', 'task-1', 5000);
    const result = lock.release('/src/foo.ts', 'task-1');
    expect(result).toBe(true);
    expect(lock.isLocked('/src/foo.ts')).toBe(false);
  });

  it('should refuse to release a lock held by a different task', () => {
    lock.acquire('/src/foo.ts', 'task-1', 5000);
    const result = lock.release('/src/foo.ts', 'task-2');
    expect(result).toBe(false);
    expect(lock.isLocked('/src/foo.ts')).toBe(true);
  });

  it('should return false when releasing a non-existent lock', () => {
    const result = lock.release('/src/nonexistent.ts', 'task-1');
    expect(result).toBe(false);
  });

  it('should report unlocked file as not locked', () => {
    expect(lock.isLocked('/src/foo.ts')).toBe(false);
  });

  it('should auto-expire a lock after TTL', () => {
    lock.acquire('/src/foo.ts', 'task-1', 5000);
    expect(lock.isLocked('/src/foo.ts')).toBe(true);

    // Advance time past TTL
    vi.advanceTimersByTime(5001);

    expect(lock.isLocked('/src/foo.ts')).toBe(false);
  });

  it('should allow a different task to acquire after TTL expiration', () => {
    lock.acquire('/src/foo.ts', 'task-1', 5000);
    vi.advanceTimersByTime(5001);

    const result = lock.acquire('/src/foo.ts', 'task-2', 5000);
    expect(result).toBe(true);
  });

  it('should clean up all expired locks', () => {
    lock.acquire('/a.ts', 'task-1', 1000);
    lock.acquire('/b.ts', 'task-2', 2000);
    lock.acquire('/c.ts', 'task-3', 5000);

    vi.advanceTimersByTime(2001);
    lock.cleanup();

    expect(lock.isLocked('/a.ts')).toBe(false);
    expect(lock.isLocked('/b.ts')).toBe(false);
    expect(lock.isLocked('/c.ts')).toBe(true); // TTL not expired yet
  });

  it('should refresh TTL on reentrant acquire', () => {
    lock.acquire('/src/foo.ts', 'task-1', 3000);
    vi.advanceTimersByTime(2000);

    // Re-acquire with fresh TTL
    lock.acquire('/src/foo.ts', 'task-1', 3000);
    vi.advanceTimersByTime(2000);

    // Should still be locked (2000ms into the refreshed 3000ms TTL)
    expect(lock.isLocked('/src/foo.ts')).toBe(true);

    // Advance past the refreshed TTL
    vi.advanceTimersByTime(1001);
    expect(lock.isLocked('/src/foo.ts')).toBe(false);
  });

  it('should create a structured lock-conflict error', () => {
    const err = lock.createLockConflictError('/src/foo.ts');
    expect(err.code).toBe('AHA-TASK-002');
    expect(err.message).toContain('/src/foo.ts');
    expect(err.retryable).toBe(true);
  });
});
