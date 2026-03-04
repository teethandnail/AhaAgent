/**
 * MutationQueue — serial execution of async operations in FIFO order.
 *
 * Ensures that only one mutation runs at a time. If one operation fails,
 * subsequent operations are still executed.
 */
export class MutationQueue {
  private queue: Array<{
    fn: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  }> = [];
  private running = false;

  /** Number of operations waiting to execute (not including the currently running one). */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * Enqueue an async operation for serial execution.
   * Returns a promise that resolves/rejects with the operation's result.
   */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.flush();
    });
  }

  private flush(): void {
    if (this.running) return;
    const item = this.queue.shift();
    if (!item) return;

    this.running = true;
    item
      .fn()
      .then((value) => item.resolve(value))
      .catch((err: unknown) => item.reject(err))
      .finally(() => {
        this.running = false;
        this.flush();
      });
  }
}
