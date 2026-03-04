/**
 * TTL-based idempotency store for deduplicating WebSocket messages.
 * Stores idempotency keys with automatic expiration.
 */
export class IdempotencyStore {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * @param ttlMs Time-to-live for idempotency keys in milliseconds. Default: 5 minutes.
   */
  constructor(ttlMs = 5 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  /**
   * Check if the given key is a duplicate.
   * Returns false the first time a key is seen, true for subsequent calls.
   */
  isDuplicate(key: string): boolean {
    const now = Date.now();
    this.cleanup(now);

    if (this.seen.has(key)) {
      return true;
    }

    this.seen.set(key, now);
    return false;
  }

  /**
   * Remove all expired entries.
   */
  private cleanup(now: number): void {
    for (const [key, timestamp] of this.seen) {
      if (now - timestamp > this.ttlMs) {
        this.seen.delete(key);
      }
    }
  }

  /**
   * Start a periodic cleanup interval.
   * @param intervalMs How often to run cleanup. Default: 60 seconds.
   */
  startAutoCleanup(intervalMs = 60_000): void {
    this.stopAutoCleanup();
    this.cleanupTimer = setInterval(() => {
      this.cleanup(Date.now());
    }, intervalMs);
    // Allow the process to exit without waiting for this timer
    this.cleanupTimer.unref();
  }

  /**
   * Stop the periodic cleanup interval.
   */
  stopAutoCleanup(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Return the number of currently stored keys.
   */
  get size(): number {
    return this.seen.size;
  }

  /**
   * Clear all stored keys and stop cleanup.
   */
  clear(): void {
    this.stopAutoCleanup();
    this.seen.clear();
  }
}
