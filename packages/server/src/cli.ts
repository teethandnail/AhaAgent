import path from 'node:path';
import os from 'node:os';
import { AhaApp } from './app.js';
import { loadLLMConfig } from './llm/config.js';
import type { LLMConfig } from './llm/router.js';

async function main(): Promise<void> {
  const workspacePath = process.argv[2] ?? process.cwd();
  const port = parseInt(process.env.AHA_PORT ?? '3000', 10);
  const dataDir = path.join(os.homedir(), '.aha');

  let llmConfig: LLMConfig | undefined;
  try {
    llmConfig = loadLLMConfig();
  } catch {
    // LLM config is optional; the agent can start without it
    console.warn('Warning: No LLM config found. LLM features will be unavailable.');
  }

  const app = new AhaApp({
    port,
    workspacePath,
    dataDir,
    llmConfig: llmConfig
      ? {
          provider: llmConfig.provider,
          model: llmConfig.model,
          apiKey: llmConfig.apiKey,
          baseUrl: llmConfig.baseUrl,
        }
      : undefined,
  });

  const { port: actualPort, token } = await app.start();

  console.log('AhaAgent daemon started');
  console.log(`  URL: http://localhost:${String(actualPort)}`);
  console.log(`  Token: ${token}`);
  console.log(`  Workspace: ${workspacePath}`);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('Shutting down...');
    await app.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await app.stop();
    process.exit(0);
  });
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
