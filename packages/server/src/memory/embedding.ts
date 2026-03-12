import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG_PATH = path.join(os.homedir(), '.aha', 'config.json');

export interface EmbeddingConfig {
  provider: 'openai';
  apiKey: string;
  model: string;
  baseUrl: string;
}

export interface EmbeddingProvider {
  readonly model: string;
  embed(input: string[]): Promise<number[][]>;
}

export function normalizeEmbeddingText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

export function buildEmbeddingInput(category: string, content: string): string {
  return `${category}: ${normalizeEmbeddingText(content)}`;
}

export function hashEmbeddingInput(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! * left[index]!;
    rightNorm += right[index]! * right[index]!;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export function loadEmbeddingConfig(): EmbeddingConfig | undefined {
  if (process.env.AHA_EMBEDDING_API_KEY) {
    return {
      provider: 'openai',
      apiKey: process.env.AHA_EMBEDDING_API_KEY,
      model: process.env.AHA_EMBEDDING_MODEL ?? 'text-embedding-3-small',
      baseUrl: process.env.AHA_EMBEDDING_BASE_URL ?? 'https://api.openai.com/v1',
    };
  }

  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const config = JSON.parse(raw) as { embedding?: Partial<EmbeddingConfig> };
    if (!config.embedding?.apiKey) {
      return undefined;
    }

    return {
      provider: 'openai',
      apiKey: config.embedding.apiKey,
      model: config.embedding.model ?? 'text-embedding-3-small',
      baseUrl: config.embedding.baseUrl ?? 'https://api.openai.com/v1',
    };
  } catch {
    return undefined;
  }
}

export function createEmbeddingProvider(config: EmbeddingConfig): EmbeddingProvider {
  return new OpenAIEmbeddingProvider(config);
}

class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: EmbeddingConfig) {
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
  }

  async embed(input: string[]): Promise<number[][]> {
    if (input.length === 0) {
      return [];
    }

    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input,
      }),
    });

    if (!response.ok) {
      throw new Error(`Embedding request failed with status ${String(response.status)}`);
    }

    const payload = (await response.json()) as {
      data?: Array<{ index: number; embedding: number[] }>;
    };

    const data = payload.data ?? [];
    return data
      .slice()
      .sort((left, right) => left.index - right.index)
      .map((item) => item.embedding);
  }
}
