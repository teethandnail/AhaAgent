import { describe, it, expect } from 'vitest';
import { MutationQueue } from './mutation-queue.js';

describe('MutationQueue', () => {
  it('should execute a single operation and return its result', async () => {
    const queue = new MutationQueue();
    const result = await queue.enqueue(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it('should execute operations in FIFO order', async () => {
    const queue = new MutationQueue();
    const order: number[] = [];

    const p1 = queue.enqueue(async () => {
      order.push(1);
      return 'a';
    });
    const p2 = queue.enqueue(async () => {
      order.push(2);
      return 'b';
    });
    const p3 = queue.enqueue(async () => {
      order.push(3);
      return 'c';
    });

    const results = await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
    expect(results).toEqual(['a', 'b', 'c']);
  });

  it('should execute operations serially, not in parallel', async () => {
    const queue = new MutationQueue();
    let concurrency = 0;
    let maxConcurrency = 0;

    const createOp = () =>
      queue.enqueue(async () => {
        concurrency++;
        maxConcurrency = Math.max(maxConcurrency, concurrency);
        // Yield to allow other potential parallel executions to start
        await new Promise((r) => setTimeout(r, 10));
        concurrency--;
      });

    await Promise.all([createOp(), createOp(), createOp()]);
    expect(maxConcurrency).toBe(1);
  });

  it('should not block subsequent operations when one fails', async () => {
    const queue = new MutationQueue();

    const p1 = queue.enqueue(() => Promise.reject(new Error('boom')));
    const p2 = queue.enqueue(() => Promise.resolve('ok'));

    await expect(p1).rejects.toThrow('boom');
    const result = await p2;
    expect(result).toBe('ok');
  });

  it('should propagate rejection correctly', async () => {
    const queue = new MutationQueue();
    const p = queue.enqueue(() => Promise.reject(new Error('test error')));
    await expect(p).rejects.toThrow('test error');
  });

  it('should report pending count correctly', async () => {
    const queue = new MutationQueue();
    let resolveFirst!: () => void;

    const blocker = new Promise<void>((r) => {
      resolveFirst = r;
    });

    // First operation blocks
    const p1 = queue.enqueue(() => blocker);

    // Enqueue two more while first is running
    const p2 = queue.enqueue(() => Promise.resolve('two'));
    const p3 = queue.enqueue(() => Promise.resolve('three'));

    // The first is running, so 2 are pending
    expect(queue.pending).toBe(2);

    resolveFirst();
    await Promise.all([p1, p2, p3]);

    expect(queue.pending).toBe(0);
  });

  it('should handle operations that return different types', async () => {
    const queue = new MutationQueue();

    const num = await queue.enqueue(() => Promise.resolve(123));
    const str = await queue.enqueue(() => Promise.resolve('hello'));
    const obj = await queue.enqueue(() => Promise.resolve({ key: 'value' }));

    expect(num).toBe(123);
    expect(str).toBe('hello');
    expect(obj).toEqual({ key: 'value' });
  });

  it('should work correctly when queue drains and new items are added', async () => {
    const queue = new MutationQueue();

    // First batch
    const r1 = await queue.enqueue(() => Promise.resolve(1));
    expect(r1).toBe(1);
    expect(queue.pending).toBe(0);

    // Second batch after drain
    const r2 = await queue.enqueue(() => Promise.resolve(2));
    expect(r2).toBe(2);
    expect(queue.pending).toBe(0);
  });
});
