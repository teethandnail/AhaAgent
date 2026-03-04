import { withRetry } from './retry.js';

export interface LLMConfig {
  provider: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  maxRetries?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: unknown[];
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  traceId?: string;
}

export interface ChatResponse {
  content: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  usage: { promptTokens: number; completionTokens: number };
}

export class LLMRouter {
  private config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
  }

  buildRequest(messages: ChatMessage[], traceId?: string): ChatRequest {
    return {
      model: this.config.model,
      messages,
      traceId,
    };
  }

  async chat(messages: ChatMessage[], traceId?: string): Promise<ChatResponse> {
    const maxRetries = this.config.maxRetries ?? 3;
    return withRetry(async () => {
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
          ...(traceId ? { 'X-Trace-Id': traceId } : {}),
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
        }),
      });

      if (!response.ok) {
        throw new Error(`LLM request failed: ${response.status.toString()} ${response.statusText}`);
      }

      const data = (await response.json()) as Record<string, unknown>;
      const choices = data.choices as Array<Record<string, unknown>> | undefined;
      const choice = choices?.[0];
      const message = choice?.message as Record<string, unknown> | undefined;

      return {
        content: (message?.content as string | undefined) ?? '',
        toolCalls: message?.tool_calls as ChatResponse['toolCalls'],
        usage: {
          promptTokens:
            (data.usage as Record<string, number> | undefined)?.prompt_tokens ?? 0,
          completionTokens:
            (data.usage as Record<string, number> | undefined)?.completion_tokens ?? 0,
        },
      };
    }, maxRetries);
  }
}
