import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AhaApp } from './app.js';
import { createDatabase } from './db/client.js';
import { CheckpointManager } from './orchestrator/checkpoint-manager.js';

interface FakeEnvelope {
  type: string;
  payload: Record<string, unknown>;
}

async function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('AhaApp recovery', () => {
  const cleanupDirs: string[] = [];
  const realFetch = global.fetch.bind(globalThis);

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('replays a persisted approval and resumes execution after approval', async () => {
    const workspacePath = await createTempDir('aha-recovery-workspace-');
    const dataDir = await createTempDir('aha-recovery-data-');
    cleanupDirs.push(workspacePath, dataDir);

    const { db, sqlite } = createDatabase(path.join(dataDir, 'aha.db'));
    const checkpointManager = new CheckpointManager(db, sqlite);
    checkpointManager.initSchema();
    checkpointManager.saveTask({
      id: 'task-recovery-1',
      title: 'Recovered task',
      status: 'blocked',
    });
    checkpointManager.saveApprovalRecovery({
      approval: {
        approvalId: 'approval-recovery-1',
        taskId: 'task-recovery-1',
        actionType: 'write_file',
        target: 'recovered.txt',
        riskLevel: 'medium',
        nonce: 'a'.repeat(64),
        expiresAt: '2099-01-01T00:05:00.000Z',
        scope: {
          workspace: workspacePath,
          maxActions: 1,
          timeoutSec: 300,
        },
      },
      taskId: 'task-recovery-1',
      requestId: 'request-recovery-123',
      traceId: 'trace-recovery-123',
      messagesJson: JSON.stringify([
        { role: 'system', content: 'You are a coding agent.' },
        { role: 'user', content: 'Create recovered.txt' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'tool-call-1',
              type: 'function',
              function: {
                name: 'write_file',
                arguments: JSON.stringify({
                  path: 'recovered.txt',
                  content: 'recovered content',
                }),
              },
            },
          ],
        },
      ]),
      step: 0,
      toolCallJson: JSON.stringify({
        id: 'tool-call-1',
        name: 'write_file',
        arguments: JSON.stringify({
          path: 'recovered.txt',
          content: 'recovered content',
        }),
      }),
      executionJson: JSON.stringify({
        mode: 'interactive',
        budget: { maxSteps: 8 },
        usage: { steps: 1, writes: 0, commands: 0 },
      }),
      createdAt: '2026-03-13T00:00:00.000Z',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input
          : input instanceof URL ? input.toString()
          : typeof input === 'object' &&
              input !== null &&
              'url' in input &&
              typeof (input as { url: unknown }).url === 'string'
            ? (input as { url: string }).url
            : '';

        if (url.startsWith('http://llm.local/')) {
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: 'Recovered complete',
                  },
                },
              ],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
              },
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          );
        }

        return realFetch(input as never, init);
      }),
    );

    const app = new AhaApp({
      port: 3000,
      originPort: 5173,
      workspacePath,
      dataDir,
      llmConfig: {
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'test-key',
        baseUrl: 'http://llm.local',
      },
    });

    const appInternals = app as unknown as {
      checkpointManager: CheckpointManager | null;
      gateway: { sessionToken: string } | null;
      reconcileInterruptedTasksOnStartup: () => void;
      handleClientConnect: (ws: { send: (raw: string) => void }) => void;
      handleApproveAction: (
        envelope: {
          requestId: string;
          payload: {
            taskId: string;
            approvalId: string;
            approvalNonce: string;
            decision: 'approve' | 'reject';
          };
        },
        ws: { send: (raw: string) => void },
        traceId: string,
      ) => void;
    };

    appInternals.checkpointManager = checkpointManager;
    appInternals.gateway = { sessionToken: 'session-token' };
    appInternals.reconcileInterruptedTasksOnStartup();

    const sent: FakeEnvelope[] = [];
    const fakeWs = {
      send(raw: string) {
        sent.push(JSON.parse(raw) as FakeEnvelope);
      },
    };

    appInternals.handleClientConnect(fakeWs);

    expect(sent.some((envelope) => envelope.type === 'task_status_change')).toBe(true);
    expect(sent.some((envelope) => envelope.type === 'action_blocked')).toBe(true);

    appInternals.handleApproveAction(
      {
        requestId: 'approve-request-1',
        payload: {
          taskId: 'task-recovery-1',
          approvalId: 'approval-recovery-1',
          approvalNonce: 'a'.repeat(64),
          decision: 'approve',
        },
      },
      fakeWs,
      'trace-approve-1',
    );

    await waitFor(() =>
      sent.some(
        (envelope) =>
          envelope.type === 'task_terminal' &&
          envelope.payload.taskId === 'task-recovery-1' &&
          envelope.payload.state === 'success',
      ),
    );

    expect(await fs.readFile(path.join(workspacePath, 'recovered.txt'), 'utf-8')).toBe('recovered content');
    sqlite.close();
  });
});
