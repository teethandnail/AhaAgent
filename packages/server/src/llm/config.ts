import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { type LLMConfig } from './router.js';

const CONFIG_PATH = path.join(os.homedir(), '.aha', 'config.json');

export function loadLLMConfig(): LLMConfig {
  // Environment variables take precedence
  if (process.env.AHA_LLM_API_KEY) {
    return {
      provider: process.env.AHA_LLM_PROVIDER ?? 'openai',
      apiKey: process.env.AHA_LLM_API_KEY,
      model: process.env.AHA_LLM_MODEL ?? 'gpt-4',
      baseUrl: process.env.AHA_LLM_BASE_URL ?? 'https://api.openai.com/v1',
    };
  }

  // Fallback to config file
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const config = JSON.parse(raw) as { llm?: Partial<LLMConfig> };
    if (!config.llm?.apiKey) throw new Error('Missing llm.apiKey in config');
    return {
      provider: config.llm.provider ?? 'openai',
      apiKey: config.llm.apiKey,
      model: config.llm.model ?? 'gpt-4',
      baseUrl: config.llm.baseUrl ?? 'https://api.openai.com/v1',
    };
  } catch {
    throw new Error(
      `No LLM config found. Set AHA_LLM_API_KEY env var or create ${CONFIG_PATH}`,
    );
  }
}
