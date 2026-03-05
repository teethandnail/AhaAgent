import { describe, it, expect, afterAll } from 'vitest';
import { ContextManager } from './context-manager.js';
import type { ChatMessage } from '../llm/router.js';

describe('ContextManager', () => {
  // Reuse a single instance where config does not matter to avoid repeated init cost
  const cm = new ContextManager({ contextWindow: 128000 });

  afterAll(() => {
    // ContextManager holds a tiktoken encoder; no explicit free needed for tests
  });

  // --- Task B1: estimateTokens ---

  it('estimateTokens returns positive count for messages', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello, how are you?' },
    ];
    const tokens = cm.estimateTokens(messages);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(100);
  });

  it('estimateTokens scales with content length', () => {
    const short: ChatMessage[] = [{ role: 'user', content: 'Hi' }];
    const long: ChatMessage[] = [{ role: 'user', content: 'Hello '.repeat(1000) }];
    expect(cm.estimateTokens(long)).toBeGreaterThan(cm.estimateTokens(short));
  });

  // --- Task B1: needsFlush ---

  it('needsFlush returns false when under threshold', () => {
    const cmSmall = new ContextManager({ contextWindow: 1000, flushThreshold: 0.75 });
    const messages: ChatMessage[] = [{ role: 'user', content: 'short' }];
    expect(cmSmall.needsFlush(messages)).toBe(false);
  });

  // --- Task B1: needsCompaction ---

  it('needsCompaction returns false when under threshold', () => {
    const cmSmall = new ContextManager({
      contextWindow: 1000,
      compactionThreshold: 0.8,
    });
    const messages: ChatMessage[] = [{ role: 'user', content: 'short' }];
    expect(cmSmall.needsCompaction(messages)).toBe(false);
  });

  // --- Task B2: splitForCompaction ---

  it('splitForCompaction separates system, old, and recent', () => {
    const cmSplit = new ContextManager({ contextWindow: 128000, keepRecentRounds: 2 });
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
      { role: 'assistant', content: 'a3' },
    ];
    const { system, old, recent } = cmSplit.splitForCompaction(messages);
    expect(system.content).toBe('sys');
    expect(old.length).toBeGreaterThan(0);
    expect(recent.some((m) => m.content === 'u3')).toBe(true);
  });

  // --- Task B2: markFlushed prevents double flush ---

  it('markFlushed prevents double flush', () => {
    const cmFlush = new ContextManager({ contextWindow: 100, flushThreshold: 0.01 });
    const messages: ChatMessage[] = [{ role: 'user', content: 'x'.repeat(200) }];
    expect(cmFlush.needsFlush(messages)).toBe(true);
    cmFlush.markFlushed();
    expect(cmFlush.needsFlush(messages)).toBe(false);
    cmFlush.resetFlushFlag();
    expect(cmFlush.needsFlush(messages)).toBe(true);
  });

  // --- Task B2: buildCompactedMessages ---

  it('buildCompactedMessages produces correct structure', () => {
    const system: ChatMessage = { role: 'system', content: 'sys' };
    const recent: ChatMessage[] = [
      { role: 'user', content: 'u3' },
      { role: 'assistant', content: 'a3' },
    ];
    const result = cm.buildCompactedMessages(system, 'summary text', recent);
    expect(result[0]!.content).toBe('sys');
    expect(result[1]!.role).toBe('assistant');
    expect(result[1]!.content).toContain('summary text');
    expect(result[1]!.content).toContain('[Previous conversation summary]');
    expect(result[2]!.content).toBe('u3');
    expect(result).toHaveLength(4); // system + summary + 2 recent
  });
});
