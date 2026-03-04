/**
 * FileLock — file-level locking with TTL and reentrant semantics.
 *
 * Each lock is held by a specific task and expires after a configurable TTL.
 * The same task can re-acquire a lock it already holds (reentrant).
 * A different task cannot acquire a lock that is currently held.
 */

import { createError } from '@aha-agent/shared';

interface LockEntry {
  taskId: string;
  expiresAt: number; // Date.now()-based timestamp
}

export class FileLock {
  private locks = new Map<string, LockEntry>();

  /**
   * Attempt to acquire a lock on the given file path for a task.
   * Returns true if the lock was acquired (or re-acquired by the same task).
   * Returns false if a different task holds a non-expired lock.
   */
  acquire(filePath: string, taskId: string, ttlMs: number): boolean {
    this.expireIfNeeded(filePath);

    const existing = this.locks.get(filePath);
    if (existing) {
      if (existing.taskId === taskId) {
        // Reentrant: same task re-acquires, refresh TTL
        existing.expiresAt = Date.now() + ttlMs;
        return true;
      }
      // Different task holds the lock
      return false;
    }

    this.locks.set(filePath, { taskId, expiresAt: Date.now() + ttlMs });
    return true;
  }

  /**
   * Release a lock held by the given task.
   * Returns true if the lock was released, false if the lock doesn't exist
   * or is held by a different task.
   */
  release(filePath: string, taskId: string): boolean {
    this.expireIfNeeded(filePath);

    const existing = this.locks.get(filePath);
    if (!existing) return false;
    if (existing.taskId !== taskId) return false;

    this.locks.delete(filePath);
    return true;
  }

  /**
   * Check whether a file is currently locked (by any task).
   */
  isLocked(filePath: string): boolean {
    this.expireIfNeeded(filePath);
    return this.locks.has(filePath);
  }

  /**
   * Remove all expired locks.
   */
  cleanup(): void {
    const now = Date.now();
    for (const [path, entry] of this.locks) {
      if (entry.expiresAt <= now) {
        this.locks.delete(path);
      }
    }
  }

  /**
   * Create a structured AhaError for a lock conflict.
   */
  createLockConflictError(filePath: string): ReturnType<typeof createError> {
    return createError('TASK_LOCK_CONFLICT', filePath);
  }

  // ---- internal helpers ----

  private expireIfNeeded(filePath: string): void {
    const entry = this.locks.get(filePath);
    if (entry && entry.expiresAt <= Date.now()) {
      this.locks.delete(filePath);
    }
  }
}
