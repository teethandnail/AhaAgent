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
  toolCalls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  toolCallId?: string;
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

export interface ChatOptions {
  tools?: unknown[];
  toolChoice?: 'auto' | 'none';
  extraBody?: Record<string, unknown>;
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

  async chat(messages: ChatMessage[], traceId?: string, options?: ChatOptions): Promise<ChatResponse> {
    const maxRetries = this.config.maxRetries ?? 3;
    return withRetry(async () => {
      const requestMessages = messages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.toolCalls ? { tool_calls: message.toolCalls } : {}),
        ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
      }));

      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
          ...(traceId ? { 'X-Trace-Id': traceId } : {}),
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: requestMessages,
          ...(options?.tools ? { tools: options.tools, tool_choice: options.toolChoice ?? 'auto' } : {}),
          ...(options?.extraBody ?? {}),
        }),
      });

      if (!response.ok) {
        throw new Error(`LLM request failed: ${response.status.toString()} ${response.statusText}`);
      }

      const data = (await response.json()) as Record<string, unknown>;
      const choices = data.choices as Array<Record<string, unknown>> | undefined;
      const choice = choices?.[0];
      const message = choice?.message as Record<string, unknown> | undefined;
      const rawToolCalls = message?.tool_calls as Array<Record<string, unknown>> | undefined;
      const toolCalls = rawToolCalls
        ?.map((tc) => {
          const fn = tc.function as Record<string, unknown> | undefined;
          const name = typeof fn?.name === 'string' ? fn.name : '';
          if (!name) return null;
          return {
            id: typeof tc.id === 'string' ? tc.id : '',
            name,
            arguments: typeof fn?.arguments === 'string' ? fn.arguments : '{}',
          };
        })
        .filter((item): item is NonNullable<typeof item> => item !== null);

      const contentRaw = message?.content;
      const content =
        typeof contentRaw === 'string' ? contentRaw
        : Array.isArray(contentRaw) ? JSON.stringify(contentRaw)
        : '';

      return {
        content,
        toolCalls,
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
