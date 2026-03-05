import { get_encoding, type Tiktoken } from 'tiktoken';
import type { ChatMessage } from '../llm/router.js';

export interface CompactionConfig {
  contextWindow: number;
  flushThreshold?: number;
  compactionThreshold?: number;
  keepRecentRounds?: number;
}

const MEMORY_FLUSH_SYSTEM = [
  'Pre-compaction memory flush.',
  '会话即将自动压缩，请将值得长期保留的信息通过 memory_store 存入记忆。',
  '如无需存储，回复 NO_REPLY。',
].join(' ');

const COMPACTION_SYSTEM = [
  '将以下对话历史总结为简洁的上下文摘要。',
  '保留：关键决策、修改的文件路径、操作结果、用户意图。',
  '丢弃：调试细节、中间尝试、工具调用原始输出。',
  '输出纯文本摘要，不超过 500 字。',
].join(' ');

export class ContextManager {
  private encoder: Tiktoken;
  private contextWindow: number;
  private flushThreshold: number;
  private compactionThreshold: number;
  private keepRecentRounds: number;
  private flushedForCurrentCompaction = false;

  constructor(config: CompactionConfig) {
    // o200k_base is the encoding used by gpt-4o and similar models
    this.encoder = get_encoding('o200k_base');
    this.contextWindow = config.contextWindow;
    this.flushThreshold = config.flushThreshold ?? 0.75;
    this.compactionThreshold = config.compactionThreshold ?? 0.80;
    this.keepRecentRounds = config.keepRecentRounds ?? 4;
  }

  /** Estimate total token count for an array of chat messages. */
  estimateTokens(messages: ChatMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      const text =
        typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      total += this.encoder.encode(text).length + 4; // +4 for role/separator overhead
    }
    return total;
  }

  /** Returns true when token usage reaches the flush threshold (default 0.75). */
  needsFlush(messages: ChatMessage[]): boolean {
    if (this.flushedForCurrentCompaction) return false;
    const tokens = this.estimateTokens(messages);
    return tokens >= this.contextWindow * this.flushThreshold;
  }

  /** Returns true when token usage reaches the compaction threshold (default 0.80). */
  needsCompaction(messages: ChatMessage[]): boolean {
    const tokens = this.estimateTokens(messages);
    return tokens >= this.contextWindow * this.compactionThreshold;
  }

  /** Mark that a flush has been performed for the current compaction cycle. */
  markFlushed(): void {
    this.flushedForCurrentCompaction = true;
  }

  /** Reset the flush flag (typically after compaction completes). */
  resetFlushFlag(): void {
    this.flushedForCurrentCompaction = false;
  }

  /** Returns the system prompt used during the memory flush phase. */
  get flushPrompt(): string {
    return MEMORY_FLUSH_SYSTEM;
  }

  /** Returns the system prompt used for conversation compaction/summarization. */
  get compactionPrompt(): string {
    return COMPACTION_SYSTEM;
  }

  /**
   * Split messages into system, old, and recent segments for compaction.
   * The system message (index 0) is always kept separate.
   * Recent = last keepRecentRounds user turns (and all messages following each).
   */
  splitForCompaction(messages: ChatMessage[]): {
    system: ChatMessage;
    old: ChatMessage[];
    recent: ChatMessage[];
  } {
    const system = messages[0]!;
    const rest = messages.slice(1);

    // Count user messages from the end to find the split point
    let userCount = 0;
    let splitIdx = rest.length;
    for (let i = rest.length - 1; i >= 0; i--) {
      if (rest[i]!.role === 'user') {
        userCount++;
        if (userCount >= this.keepRecentRounds) {
          splitIdx = i;
          break;
        }
      }
    }

    return {
      system,
      old: rest.slice(0, splitIdx),
      recent: rest.slice(splitIdx),
    };
  }

  /**
   * Build the compacted message array after receiving a summary from the LLM.
   * Structure: [system, summary-as-assistant-message, ...recent]
   */
  buildCompactedMessages(
    system: ChatMessage,
    summary: string,
    recent: ChatMessage[],
  ): ChatMessage[] {
    return [
      system,
      {
        role: 'assistant' as const,
        content: `[Previous conversation summary]\n${summary}`,
      },
      ...recent,
    ];
  }
}
