import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  type WsEnvelope,
  type SendMessagePayload,
  type ApproveActionPayload,
  type CancelTaskPayload,
  type ListMemoriesPayload,
  type DeleteMemoryPayload,
  type UpdateMemoryPayload,
  type MemoryListPayload,
  type MemoryDeletedPayload,
  type MemoryUpdatedPayload,
  type ApprovalActionType,
  type RiskLevel,
  type ExecutionMode,
  type StreamChunkPayload,
  type TaskStatusChangePayload,
  type TaskTerminalPayload,
  type ErrorPayload,
  type PolicyAction,
  ClientEvents,
  ServerEvents,
} from '@aha-agent/shared';

import { createGateway, type Gateway } from './gateway/ws-server.js';
import { TaskManager } from './orchestrator/task-manager.js';
import { ApprovalManager } from './orchestrator/approval-manager.js';
import {
  CheckpointManager,
  type ApprovalRecoveryRecord,
} from './orchestrator/checkpoint-manager.js';
import { MemoryController } from './memory/memory-controller.js';
import { ContextManager } from './memory/context-manager.js';
import { validateMemoryStoreInput } from './memory/validation.js';
import { validateMemoryUpdateInput } from './memory/validation.js';
import { MutationQueue } from './orchestrator/mutation-queue.js';
import { FileLock } from './orchestrator/file-lock.js';
import { Sandbox } from './tools/sandbox.js';
import { AuditLogger } from './logger/audit-logger.js';
import { LLMRouter, type ChatMessage } from './llm/router.js';
import { createDatabase, type AppDatabase } from './db/client.js';
import { ExtensionInstaller } from './extensions/installer.js';
import { ExtensionRunner } from './extensions/runner.js';
import { readFile } from './tools/read-file.js';
import { listDir } from './tools/list-dir.js';
import { computeFileVersion } from './tools/file-version.js';
import { runCommand } from './tools/run-command.js';
import { writeFileSafely } from './tools/write-file.js';
import { extractMainContent, fetchUrlWithSafety, searchWebDuckDuckGo } from './tools/web-search.js';
import { BrowserAutomationService } from './tools/browser-automation.js';
import { evaluate } from './policy/policy-engine.js';

import type { Database as SqliteDatabase } from 'better-sqlite3';

const MAX_TOOL_STEPS = 8;
const AUTONOMOUS_DEFAULT_MAX_STEPS = 16;
const DEFAULT_MODE: ExecutionMode = 'interactive';

interface ToolCallRequest {
  id: string;
  name: string;
  arguments: string;
}

interface PendingApprovalContext {
  taskId: string;
  requestId: string;
  traceId: string;
  ws?: WebSocket;
  messages: ChatMessage[];
  step: number;
  toolCall: ToolCallRequest;
  execution: ExecutionContext;
}

interface RuntimeBudget {
  maxSteps: number;
  maxWrites?: number;
  maxCommands?: number;
}

interface ExecutionContext {
  mode: ExecutionMode;
  budget: RuntimeBudget;
  usage: {
    steps: number;
    writes: number;
    commands: number;
  };
}

const CODING_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List entries under a directory in the current workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or workspace-relative path.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or workspace-relative file path.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_dir',
      description: 'Create a directory recursively in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or workspace-relative directory path.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write UTF-8 content to a file in the workspace. Creates parent directories if needed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or workspace-relative file path.' },
          content: { type: 'string', description: 'File content.' },
          expectedVersion: {
            type: 'string',
            description: 'Required when overwriting an existing file; use the version returned by read_file.',
          },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_tool',
      description:
        'Control a real browser session. Supports: status/start/stop/search/open/click_result/click/type/snapshot.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'start', 'stop', 'search', 'open', 'click_result', 'click', 'type', 'snapshot'],
          },
          query: { type: 'string' },
          engine: { type: 'string', enum: ['duckduckgo', 'google', 'bing'] },
          maxResults: { type: 'number' },
          url: { type: 'string' },
          index: { type: 'number' },
          selector: { type: 'string' },
          text: { type: 'string' },
          submit: { type: 'boolean' },
          timeoutSec: { type: 'number' },
          maxChars: { type: 'number' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_search',
      description: 'Search the web and return top results with title/url/snippet.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          engine: { type: 'string', enum: ['duckduckgo'] },
          maxResults: { type: 'number' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch a URL and return cleaned textual content for summarization.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          timeoutSec: { type: 'number' },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_open',
      description: 'Open a URL in browser-style fetch mode (alias of fetch_url).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          timeoutSec: { type: 'number' },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extract_main_content',
      description: 'Extract simplified markdown text from HTML.',
      parameters: {
        type: 'object',
        properties: {
          html: { type: 'string' },
        },
        required: ['html'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'diff_edit',
      description: 'Apply targeted text replacements in a file with optional version precondition.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or workspace-relative file path.' },
          expectedVersion: { type: 'string', description: 'Optional version hash precondition.' },
          hunks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                oldText: { type: 'string' },
                newText: { type: 'string' },
              },
              required: ['oldText', 'newText'],
              additionalProperties: false,
            },
          },
        },
        required: ['path', 'hunks'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or workspace-relative file path.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
          cwd: { type: 'string' },
          timeoutSec: { type: 'number' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_search',
      description:
        'Search past memories. Must be called before answering questions about prior work, decisions, preferences, people, dates, or todos. Returns relevant memory snippets with IDs.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search keywords or natural language question.' },
          topK: { type: 'number', description: 'Max results to return. Default 5.' },
          category: {
            type: 'string',
            enum: ['preference', 'fact', 'skill', 'context'],
            description: 'Optional category filter.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_store',
      description:
        'Store a piece of durable information worth remembering long-term: user preferences, project facts, key decisions, skill learnings. Do NOT store temporary or one-off details.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The content to remember.' },
          category: {
            type: 'string',
            enum: ['preference', 'fact', 'skill', 'context'],
            description: 'Memory category.',
          },
          sensitivity: {
            type: 'string',
            enum: ['public', 'restricted', 'secret'],
            description: 'Sensitivity level. Defaults to public.',
          },
        },
        required: ['content', 'category'],
        additionalProperties: false,
      },
    },
  },
] as const;

export interface AhaAppConfig {
  port: number;
  originPort?: number;
  workspacePath: string;
  dataDir: string;
  llmConfig?: { provider: string; model: string; apiKey: string; baseUrl: string };
}

export class AhaApp {
  private readonly config: AhaAppConfig;
  private readonly verbose: boolean = process.env.AHA_VERBOSE !== '0';

  private gateway: Gateway | null = null;
  private taskManager: TaskManager;
  private approvalManager: ApprovalManager;
  private checkpointManager: CheckpointManager | null = null;
  private memoryController: MemoryController | null = null;
  private contextManager: ContextManager | null = null;
  private mutationQueue: MutationQueue;
  private fileLock: FileLock;
  private sandbox: Sandbox;
  private auditLogger: AuditLogger;
  private llmRouter: LLMRouter | null = null;
  private extensionInstaller: ExtensionInstaller;
  private extensionRunner: ExtensionRunner;
  private browserAutomation: BrowserAutomationService;
  private pendingApprovals = new Map<string, PendingApprovalContext>();
  private conversationHistories = new Map<string, ChatMessage[]>();

  private db: AppDatabase | null = null;
  private sqlite: SqliteDatabase | null = null;

  constructor(config: AhaAppConfig) {
    this.config = config;

    // Eagerly create services that don't need the database
    this.taskManager = new TaskManager({
      onStateChange: (taskId) => {
        const task = this.taskManager.getTask(taskId);
        if (task) {
          this.checkpointManager?.saveTask(task);
        }
      },
    });
    this.approvalManager = new ApprovalManager();
    this.mutationQueue = new MutationQueue();
    this.fileLock = new FileLock();
    this.sandbox = new Sandbox([config.workspacePath]);
    this.auditLogger = new AuditLogger(path.join(config.dataDir, 'logs'));
    this.extensionInstaller = new ExtensionInstaller({
      extensionsDir: path.join(config.dataDir, 'extensions'),
      allowedSources: [],
    });
    this.extensionRunner = new ExtensionRunner();
    this.browserAutomation = new BrowserAutomationService();

    if (config.llmConfig) {
      this.llmRouter = new LLMRouter({
        provider: config.llmConfig.provider,
        apiKey: config.llmConfig.apiKey,
        model: config.llmConfig.model,
        baseUrl: config.llmConfig.baseUrl,
      });
    }
  }

  async start(): Promise<{ port: number; token: string }> {
    // 1. Create data directories if needed
    fs.mkdirSync(this.config.dataDir, { recursive: true });
    fs.mkdirSync(path.join(this.config.dataDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(this.config.dataDir, 'extensions'), { recursive: true });

    // 2. Initialize SQLite database
    const dbPath = path.join(this.config.dataDir, 'aha.db');
    const { db, sqlite } = createDatabase(dbPath);
    this.db = db;
    this.sqlite = sqlite;

    // 3. Init schemas (checkpoint, memory)
    this.checkpointManager = new CheckpointManager(db, sqlite);
    this.checkpointManager.initSchema();

    this.memoryController = new MemoryController(db, sqlite);
    this.memoryController.initSchema();

    const contextWindow = parseInt(process.env.AHA_CONTEXT_WINDOW ?? '128000', 10);
    this.contextManager = new ContextManager({ contextWindow });

    // 3.5. Reconcile tasks left mid-flight by the previous daemon process.
    this.reconcileInterruptedTasksOnStartup();

    // 4. Start gateway with message handler
    this.gateway = createGateway({
      port: this.config.port,
      originPort: this.config.originPort,
      onConnect: (ws) => {
        this.handleClientConnect(ws);
      },
      onMessage: (ws, envelope) => {
        this.handleMessage(envelope, ws);
      },
    });

    await this.gateway.start();

    this.auditLogger.info('AhaAgent started', {
      port: this.config.port,
      workspace: this.config.workspacePath,
    });

    // 5. Return port and session token
    return {
      port: this.config.port,
      token: this.gateway.sessionToken,
    };
  }

  async stop(): Promise<void> {
    this.pendingApprovals.clear();

    // 1. Stop all extensions
    await this.extensionRunner.stopAll();
    await this.browserAutomation.stop().catch(() => undefined);

    // 2. Close gateway
    if (this.gateway) {
      await this.gateway.stop();
      this.gateway = null;
    }

    // 3. Close database
    if (this.sqlite) {
      this.sqlite.close();
      this.sqlite = null;
      this.db = null;
    }

    this.auditLogger.info('AhaAgent stopped');
    this.logProgress('daemon_stopped');
  }

  private handleMessage(envelope: WsEnvelope<Record<string, unknown>>, ws: WebSocket): void {
    const traceId = crypto.randomUUID();

    switch (envelope.type) {
      case ClientEvents.SEND_MESSAGE:
        this.handleSendMessage(envelope as unknown as WsEnvelope<SendMessagePayload>, ws, traceId);
        break;

      case ClientEvents.APPROVE_ACTION:
        this.handleApproveAction(envelope as unknown as WsEnvelope<ApproveActionPayload>, ws, traceId);
        break;

      case ClientEvents.CANCEL_TASK:
        this.handleCancelTask(envelope as unknown as WsEnvelope<CancelTaskPayload>, ws, traceId);
        break;
      case ClientEvents.LIST_MEMORIES:
        this.handleListMemories(envelope as unknown as WsEnvelope<ListMemoriesPayload>, ws);
        break;
      case ClientEvents.DELETE_MEMORY:
        this.handleDeleteMemory(envelope as unknown as WsEnvelope<DeleteMemoryPayload>, ws, traceId);
        break;
      case ClientEvents.UPDATE_MEMORY:
        this.handleUpdateMemory(envelope as unknown as WsEnvelope<UpdateMemoryPayload>, ws, traceId);
        break;

      default:
        this.sendError(ws, envelope.requestId, 'AHA-SYS-001', `Unknown event type: ${envelope.type}`);
        break;
    }
  }

  private handleSendMessage(
    envelope: WsEnvelope<SendMessagePayload>,
    ws: WebSocket,
    traceId: string,
  ): void {
    const { payload } = envelope;
    const execution = this.resolveExecutionContext(payload);

    // Create a task
    const task = this.taskManager.createTask(payload.text);
    this.logProgress('task_created', {
      taskId: task.id,
      requestId: envelope.requestId,
      message: payload.text,
    });

    // Log the audit event
    this.auditLogger.audit({
      traceId,
      taskId: task.id,
      requestId: envelope.requestId,
      actor: 'user',
      action: 'send_message',
      result: 'task_created',
      details: { conversationId: payload.conversationId, text: payload.text },
    });

    // Transition to running
    this.taskManager.transition(task.id, 'running');

    // Send task_status_change back
    const statusPayload: TaskStatusChangePayload = {
      taskId: task.id,
      state: task.status,
      desc: `Task created: ${payload.text}`,
      mode: execution.mode,
      budget: this.toBudgetPayload(execution),
    };

    this.sendEnvelope(ws, envelope.requestId, ServerEvents.TASK_STATUS_CHANGE, statusPayload);

    // Continue task execution asynchronously so the gateway thread stays responsive.
    void this.runLLMTask(task.id, payload.text, envelope.requestId, ws, traceId, execution, payload.conversationId);
  }

  private async runLLMTask(
    taskId: string,
    userText: string,
    requestId: string,
    ws: WebSocket,
    traceId: string,
    execution: ExecutionContext,
    conversationId: string,
  ): Promise<void> {
    this.logProgress('llm_task_started', { taskId, requestId });
    if (!this.llmRouter) {
      this.taskManager.transition(taskId, 'failed');
      const terminalPayload: TaskTerminalPayload = {
        taskId,
        state: 'failed',
        summary: 'LLM is not configured. Set AHA_LLM_API_KEY or ~/.aha/config.json.',
        errorCode: 'AHA-LLM-001',
      };
      this.sendEnvelope(ws, requestId, ServerEvents.TASK_TERMINAL, terminalPayload);
      this.logProgress('task_failed', { taskId, reason: terminalPayload.summary });
      return;
    }

    try {
      let messages = this.conversationHistories.get(conversationId);
      if (messages) {
        // Append the new user message to existing conversation history
        messages.push({ role: 'user', content: userText });
      } else {
        // First message in this conversation – create history with system prompt
        messages = [
          {
            role: 'system',
            content:
              'You are a coding agent operating inside a local workspace. Use tools when filesystem changes or web research are requested. ' +
              'For web tasks, prefer browser_tool(action=search/open/click_result/snapshot) for interactive browsing. ' +
              'For fast reading, use browser_search + fetch_url and cite source URLs in your final response.\n\n' +
              '## Memory\n\n' +
              'You have a long-term memory system. Follow these rules:\n\n' +
              '**Recall**: Before answering questions about prior work, decisions, dates, people, preferences, or todos, ' +
              'call memory_search to check your memories. If low confidence after search, tell the user you checked but found nothing.\n\n' +
              '**Store**: When the conversation reveals information worth remembering long-term ' +
              '(user preferences, project facts, key decisions), call memory_store. Do not store temporary or one-off details.',
          },
          { role: 'user', content: userText },
        ];
        this.conversationHistories.set(conversationId, messages);
      }
      await this.continueAgentLoop({
        taskId,
        requestId,
        traceId,
        ws,
        messages,
        startStep: 0,
        execution,
      });
    } catch (error: unknown) {
      const current = this.taskManager.getTask(taskId);
      if (current?.status === 'cancelled') {
        return;
      }

      const errMsg = error instanceof Error ? error.message : 'Unknown LLM error';

      this.auditLogger.error('LLM task failed', {
        traceId,
        taskId,
        requestId,
        error: errMsg,
      });

      this.taskManager.transition(taskId, 'failed');
      const terminalPayload: TaskTerminalPayload = {
        taskId,
        state: 'failed',
        summary: `LLM request failed: ${errMsg}`,
        errorCode: 'AHA-LLM-002',
      };
      this.sendEnvelope(ws, requestId, ServerEvents.TASK_TERMINAL, terminalPayload);
      this.logProgress('task_failed', { taskId, reason: errMsg });
    }
  }

  private async continueAgentLoop(params: {
    taskId: string;
    requestId: string;
    traceId: string;
    ws: WebSocket;
    messages: ChatMessage[];
    startStep: number;
    execution: ExecutionContext;
  }): Promise<void> {
    if (!this.llmRouter) return;
    const stepsLimit = params.execution.budget.maxSteps;
    for (let step = params.startStep; step < stepsLimit; step++) {
      params.execution.usage.steps = step + 1;
      const current = this.taskManager.getTask(params.taskId);
      if (current?.status === 'cancelled') return;

      // --- Context compaction check ---
      if (this.contextManager && this.memoryController && this.llmRouter) {
        // Phase 1: Memory Flush
        if (this.contextManager.needsFlush(params.messages)) {
          this.logProgress('memory_flush_start', { taskId: params.taskId, step });
          const flushMessages: ChatMessage[] = [
            { role: 'system', content: this.contextManager.flushPrompt },
            ...params.messages.slice(1),
            { role: 'user', content: 'Store any durable memories now. Reply NO_REPLY if nothing to store.' },
          ];
          const flushResponse = await this.llmRouter.chat(flushMessages, params.traceId, {
            tools: CODING_TOOLS as unknown as unknown[],
            toolChoice: 'auto',
          });
          if (flushResponse.toolCalls) {
            for (const tc of flushResponse.toolCalls) {
              if (tc.name === 'memory_store') {
                await this.executeToolCall(tc.name, tc.arguments, {
                  traceId: params.traceId,
                  taskId: params.taskId,
                  requestId: params.requestId,
                });
              }
            }
          }
          this.contextManager.markFlushed();
          this.logProgress('memory_flush_done', { taskId: params.taskId, step });
        }

        // Phase 2: Compaction
        if (this.contextManager.needsCompaction(params.messages)) {
          this.logProgress('compaction_start', { taskId: params.taskId, step });
          const { system, old, recent } = this.contextManager.splitForCompaction(params.messages);
          if (old.length > 0) {
            const summaryMessages: ChatMessage[] = [
              { role: 'system', content: this.contextManager.compactionPrompt },
              ...old,
            ];
            const summaryResponse = await this.llmRouter.chat(summaryMessages, params.traceId);
            const summary = summaryResponse.content || '(no summary generated)';
            params.messages = this.contextManager.buildCompactedMessages(system, summary, recent);
            this.contextManager.resetFlushFlag();
            this.logProgress('compaction_done', {
              taskId: params.taskId,
              step,
              oldMessages: old.length,
              newTotal: params.messages.length,
            });
          }
        }
      }
      // --- End context compaction check ---

      const response = await this.llmRouter.chat(params.messages, params.traceId, {
        tools: CODING_TOOLS as unknown as unknown[],
        toolChoice: 'auto',
      });
      this.logProgress('llm_step_done', {
        taskId: params.taskId,
        step,
        toolCalls: response.toolCalls?.length ?? 0,
        mode: params.execution.mode,
      });

      if (response.toolCalls && response.toolCalls.length > 0) {
        params.messages.push({
          role: 'assistant',
          content: response.content || '',
          toolCalls: response.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: tc.arguments,
            },
          })),
        });

        for (const tc of response.toolCalls) {
          let parsedArgs: Record<string, unknown> | undefined;
          try {
            parsedArgs = JSON.parse(tc.arguments) as Record<string, unknown>;
          } catch {
            parsedArgs = undefined;
          }
          this.logProgress('tool_call', {
            taskId: params.taskId,
            step,
            tool: tc.name,
            action:
              tc.name === 'browser_tool' && parsedArgs && typeof parsedArgs.action === 'string'
                ? parsedArgs.action
                : undefined,
          });
          const policyResult = this.evaluateToolPolicy(tc.name, tc.arguments, false);
          if (policyResult.decision === 'deny') {
            params.messages.push({
              role: 'tool',
              toolCallId: tc.id,
              content: JSON.stringify({
                ok: false,
                error: policyResult.reason ?? 'Denied by policy',
                errorCode: policyResult.errorCode,
              }),
            });
            continue;
          }

          if (policyResult.decision === 'require_approval') {
            const action = this.toPolicyAction(tc.name);
            if (this.canAutoApproveInAutonomousMode(params.execution.mode, action)) {
              const budgetOk = this.consumeMutationBudget(tc.name, params.execution);
              if (!budgetOk.ok) {
                this.taskManager.transition(params.taskId, 'failed');
                this.sendEnvelope(params.ws, params.requestId, ServerEvents.TASK_TERMINAL, {
                  taskId: params.taskId,
                  state: 'failed',
                  summary: budgetOk.reason,
                  errorCode: 'AHA-POLICY-001',
                } satisfies TaskTerminalPayload);
                this.logProgress('task_failed', { taskId: params.taskId, reason: budgetOk.reason });
                return;
              }
              this.logProgress('tool_auto_approved', {
                taskId: params.taskId,
                step,
                tool: tc.name,
                mode: params.execution.mode,
              });
              const autoResult = await this.executeToolCall(tc.name, tc.arguments, {
                traceId: params.traceId,
                taskId: params.taskId,
                requestId: params.requestId,
              });
              this.logProgress('tool_result', {
                taskId: params.taskId,
                step,
                tool: tc.name,
                ok: autoResult.ok === true,
                error: typeof autoResult.error === 'string' ? autoResult.error : undefined,
                mode: params.execution.mode,
              });
              params.messages.push({
                role: 'tool',
                toolCallId: tc.id,
                content: JSON.stringify(autoResult),
              });
              continue;
            }
            const task = this.taskManager.getTask(params.taskId);
            if (task && task.status === 'running') {
              this.taskManager.transition(task.id, 'blocked');
              this.sendEnvelope(params.ws, params.requestId, ServerEvents.TASK_STATUS_CHANGE, {
                taskId: task.id,
                state: 'blocked',
                desc: `Waiting for approval: ${tc.name}`,
                mode: params.execution.mode,
                budget: this.toBudgetPayload(params.execution),
              } satisfies TaskStatusChangePayload);
            }

            const approval = this.approvalManager.createApproval({
              taskId: params.taskId,
              actionType: this.toApprovalActionType(tc.name),
              target: this.describeToolTarget(tc.name, tc.arguments),
              riskLevel: this.toRiskLevel(tc.name),
              scope: {
                workspace: this.config.workspacePath,
                maxActions: 1,
                timeoutSec: 300,
              },
            });
            this.checkpointManager?.saveCheckpoint({
              checkpointId: crypto.randomUUID(),
              taskId: params.taskId,
              stepId: `approval-step-${String(step)}`,
              llmContextRef: `messages:${String(params.messages.length)}`,
              pendingApprovalId: approval.approvalId,
              createdAt: new Date().toISOString(),
            });

            this.pendingApprovals.set(approval.approvalId, {
              taskId: params.taskId,
              requestId: params.requestId,
              traceId: params.traceId,
              ws: params.ws,
              messages: params.messages,
              step,
              toolCall: tc,
              execution: params.execution,
            });
            this.persistApprovalRecovery(approval.approvalId);

            const blockedPayload = this.approvalManager.toBlockedPayload(approval);
            this.sendEnvelope(params.ws, params.requestId, ServerEvents.ACTION_BLOCKED, blockedPayload);
            this.logProgress('approval_required', {
              taskId: params.taskId,
              approvalId: approval.approvalId,
              action: tc.name,
              target: this.describeToolTarget(tc.name, tc.arguments),
            });
            return;
          }

          const budgetOk = this.consumeMutationBudget(tc.name, params.execution);
          if (!budgetOk.ok) {
            this.taskManager.transition(params.taskId, 'failed');
            this.sendEnvelope(params.ws, params.requestId, ServerEvents.TASK_TERMINAL, {
              taskId: params.taskId,
              state: 'failed',
              summary: budgetOk.reason,
              errorCode: 'AHA-POLICY-001',
            } satisfies TaskTerminalPayload);
            this.logProgress('task_failed', { taskId: params.taskId, reason: budgetOk.reason });
            return;
          }

          const toolResult = await this.executeToolCall(tc.name, tc.arguments, {
            traceId: params.traceId,
            taskId: params.taskId,
            requestId: params.requestId,
          });
          this.logProgress('tool_result', {
            taskId: params.taskId,
            step,
            tool: tc.name,
            ok: toolResult.ok === true,
            error: typeof toolResult.error === 'string' ? toolResult.error : undefined,
          });
          params.messages.push({
            role: 'tool',
            toolCallId: tc.id,
            content: JSON.stringify(toolResult),
          });
        }
        continue;
      }

      this.sendEnvelope(params.ws, params.requestId, ServerEvents.STREAM_CHUNK, {
        taskId: params.taskId,
        chunk: response.content || '(empty response)',
        isFinal: true,
      } satisfies StreamChunkPayload);

      this.taskManager.transition(params.taskId, 'success');
      this.clearTaskRecoveryState(params.taskId);
      this.sendEnvelope(params.ws, params.requestId, ServerEvents.TASK_TERMINAL, {
        taskId: params.taskId,
        state: 'success',
        summary: 'Task completed',
      } satisfies TaskTerminalPayload);
      this.logProgress('task_success', { taskId: params.taskId });
      return;
    }

    this.taskManager.transition(params.taskId, 'failed');
    this.clearTaskRecoveryState(params.taskId);
    this.sendEnvelope(params.ws, params.requestId, ServerEvents.TASK_TERMINAL, {
      taskId: params.taskId,
      state: 'failed',
      summary: `Task aborted after exceeding ${stepsLimit.toString()} tool iterations.`,
      errorCode: 'AHA-LLM-002',
    } satisfies TaskTerminalPayload);
    this.logProgress('task_failed', {
      taskId: params.taskId,
      reason: `exceeded ${stepsLimit.toString()} steps`,
    });
  }

  private resolveWorkspacePath(inputPath: string): string {
    return path.isAbsolute(inputPath)
      ? path.resolve(inputPath)
      : path.resolve(this.config.workspacePath, inputPath);
  }

  private async ensureCreatablePath(targetPath: string): Promise<boolean> {
    if (await this.sandbox.validatePath(targetPath)) {
      return true;
    }

    let cursor = path.resolve(path.dirname(targetPath));
    while (true) {
      if (fs.existsSync(cursor)) {
        return this.sandbox.validatePath(cursor);
      }

      const next = path.dirname(cursor);
      if (next === cursor) {
        return false;
      }
      cursor = next;
    }
  }

  private async executeToolCall(
    name: string,
    rawArgs: string,
    context?: { traceId: string; taskId: string; requestId: string },
  ): Promise<Record<string, unknown>> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(rawArgs) as Record<string, unknown>;
    } catch {
      return { ok: false, error: 'Invalid JSON tool arguments' };
    }

    switch (name) {
      case 'browser_tool': {
        const action = typeof args.action === 'string' ? args.action : '';
        const timeoutMs =
          typeof args.timeoutSec === 'number' && Number.isFinite(args.timeoutSec)
            ? Math.max(1, Math.min(60, args.timeoutSec)) * 1000
            : undefined;

        try {
          switch (action) {
            case 'status':
              return await this.browserAutomation.status();
            case 'start':
              return await this.browserAutomation.start();
            case 'stop':
              return await this.browserAutomation.stop();
            case 'search': {
              const query = typeof args.query === 'string' ? args.query : '';
              if (!query.trim()) return { ok: false, error: 'query is required for action=search' };
              return await this.browserAutomation.search({
                query,
                engine: args.engine,
                maxResults: args.maxResults as number | undefined,
                timeoutMs,
              });
            }
            case 'open': {
              const url = typeof args.url === 'string' ? args.url : '';
              if (!url.trim()) return { ok: false, error: 'url is required for action=open' };
              return await this.browserAutomation.open({ url, timeoutMs });
            }
            case 'click_result': {
              const index = typeof args.index === 'number' ? args.index : Number.NaN;
              if (!Number.isFinite(index)) return { ok: false, error: 'index is required for action=click_result' };
              return await this.browserAutomation.clickResult({ index, timeoutMs });
            }
            case 'click': {
              const selector = typeof args.selector === 'string' ? args.selector : '';
              if (!selector.trim()) return { ok: false, error: 'selector is required for action=click' };
              return await this.browserAutomation.click({ selector, timeoutMs });
            }
            case 'type': {
              const selector = typeof args.selector === 'string' ? args.selector : '';
              const text = typeof args.text === 'string' ? args.text : '';
              const submit = typeof args.submit === 'boolean' ? args.submit : false;
              if (!selector.trim()) return { ok: false, error: 'selector is required for action=type' };
              return await this.browserAutomation.type({ selector, text, submit, timeoutMs });
            }
            case 'snapshot': {
              const maxChars =
                typeof args.maxChars === 'number' && Number.isFinite(args.maxChars)
                  ? Math.max(500, Math.min(50_000, Math.floor(args.maxChars)))
                  : undefined;
              return await this.browserAutomation.snapshot({ maxChars });
            }
            default:
              return { ok: false, error: `Unsupported browser_tool action: ${action || '(empty)'}` };
          }
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : 'browser_tool failed';
          return { ok: false, error: msg };
        }
      }

      case 'browser_search': {
        const query = typeof args.query === 'string' ? args.query : '';
        const maxResults =
          typeof args.maxResults === 'number' && Number.isFinite(args.maxResults)
            ? Math.max(1, Math.min(10, Math.floor(args.maxResults)))
            : 5;
        if (!query) return { ok: false, error: 'query is required' };
        try {
          const result = await searchWebDuckDuckGo(query, maxResults);
          if (context) {
            this.auditLogger.audit({
              traceId: context.traceId,
              taskId: context.taskId,
              requestId: context.requestId,
              actor: 'assistant',
              action: 'browser_search',
              result: 'ok',
              details: { query, returned: result.results.length },
            });
          }
          return { ok: true, output: result };
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : 'search failed';
          if (context) {
            this.auditLogger.audit({
              traceId: context.traceId,
              taskId: context.taskId,
              requestId: context.requestId,
              actor: 'assistant',
              action: 'browser_search',
              result: 'error',
              details: { query, error: msg },
            });
          }
          return { ok: false, error: msg };
        }
      }

      case 'fetch_url':
      case 'browser_open': {
        const url = typeof args.url === 'string' ? args.url : '';
        const timeoutSec =
          typeof args.timeoutSec === 'number' && Number.isFinite(args.timeoutSec)
            ? Math.max(1, Math.min(30, args.timeoutSec))
            : 12;
        const maxBytes = 512 * 1024;
        if (!url) return { ok: false, error: 'url is required' };
        try {
          const fetched = await fetchUrlWithSafety({
            url,
            timeoutMs: Math.floor(timeoutSec * 1000),
            maxBytes,
          });
          if (context) {
            this.auditLogger.audit({
              traceId: context.traceId,
              taskId: context.taskId,
              requestId: context.requestId,
              actor: 'assistant',
              action: name,
              result: 'ok',
              details: { url, finalUrl: fetched.finalUrl, status: fetched.status },
            });
          }
          return {
            ok: true,
            output: {
              finalUrl: fetched.finalUrl,
              status: fetched.status,
              title: fetched.title,
              text: fetched.text.slice(0, 12_000),
              html: fetched.html.slice(0, 30_000),
            },
          };
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : 'fetch failed';
          return { ok: false, error: msg };
        }
      }

      case 'extract_main_content': {
        const html = typeof args.html === 'string' ? args.html : '';
        if (!html) return { ok: false, error: 'html is required' };
        return { ok: true, output: extractMainContent(html) };
      }

      case 'list_dir': {
        const pathArg = typeof args.path === 'string' ? args.path : '.';
        const result = await listDir({ path: this.resolveWorkspacePath(pathArg) }, this.sandbox);
        return result.ok ? { ok: true, output: result.output } : { ok: false, error: result.errorMessage };
      }

      case 'read_file': {
        const pathArg = typeof args.path === 'string' ? args.path : '';
        if (!pathArg) return { ok: false, error: 'path is required' };
        const result = await readFile({ path: this.resolveWorkspacePath(pathArg) }, this.sandbox);
        return result.ok ? { ok: true, output: result.output } : { ok: false, error: result.errorMessage };
      }

      case 'create_dir': {
        const pathArg = typeof args.path === 'string' ? args.path : '';
        if (!pathArg) return { ok: false, error: 'path is required' };
        const target = this.resolveWorkspacePath(pathArg);
        if (!(await this.ensureCreatablePath(target))) {
          return { ok: false, error: 'path escapes workspace boundary' };
        }
        await fsp.mkdir(target, { recursive: true });
        return { ok: true, output: { path: target } };
      }

      case 'write_file': {
        const pathArg = typeof args.path === 'string' ? args.path : '';
        const content = typeof args.content === 'string' ? args.content : '';
        const expectedVersion =
          typeof args.expectedVersion === 'string' ? args.expectedVersion : undefined;
        if (!pathArg) return { ok: false, error: 'path is required' };

        const target = this.resolveWorkspacePath(pathArg);
        if (!(await this.ensureCreatablePath(target))) {
          return { ok: false, error: 'path escapes workspace boundary' };
        }

        return this.mutationQueue.enqueue(() =>
          writeFileSafely({
            path: target,
            content,
            expectedVersion,
          }).then((result) =>
            result.ok
              ? { ok: true, output: result.output }
              : { ok: false, errorCode: result.errorCode, error: result.errorMessage },
          ),
        );
      }

      case 'diff_edit': {
        const pathArg = typeof args.path === 'string' ? args.path : '';
        const expectedVersion =
          typeof args.expectedVersion === 'string' ? args.expectedVersion : undefined;
        const hunks = Array.isArray(args.hunks)
          ? args.hunks.filter(
              (h): h is { oldText: string; newText: string } =>
                typeof h === 'object' &&
                h !== null &&
                typeof (h as Record<string, unknown>).oldText === 'string' &&
                typeof (h as Record<string, unknown>).newText === 'string',
            )
          : [];

        if (!pathArg) return { ok: false, error: 'path is required' };
        if (hunks.length === 0) return { ok: false, error: 'hunks is required' };

        const target = this.resolveWorkspacePath(pathArg);
        const allowed = await this.sandbox.validatePath(target);
        if (!allowed) return { ok: false, error: 'path escapes workspace boundary' };

        return this.mutationQueue.enqueue(async () => {
          if (expectedVersion) {
            const currentVersion = await computeFileVersion(target);
            if (currentVersion !== expectedVersion) {
              return {
                ok: false,
                errorCode: 'AHA-TOOL-002',
                error: `Version conflict: expected ${expectedVersion}, got ${currentVersion}`,
              };
            }
          }

          let content = await fsp.readFile(target, 'utf-8');
          for (const hunk of hunks) {
            if (!content.includes(hunk.oldText)) {
              return {
                ok: false,
                error: `oldText not found in file: ${hunk.oldText.slice(0, 60)}`,
              };
            }
            content = content.replace(hunk.oldText, hunk.newText);
          }

          await fsp.writeFile(target, content, 'utf-8');
          const version = await computeFileVersion(target);
          return { ok: true, output: { path: target, version, appliedHunks: hunks.length } };
        });
      }

      case 'delete_file': {
        const pathArg = typeof args.path === 'string' ? args.path : '';
        if (!pathArg) return { ok: false, error: 'path is required' };
        const target = this.resolveWorkspacePath(pathArg);
        const allowed = await this.sandbox.validatePath(target);
        if (!allowed) return { ok: false, error: 'path escapes workspace boundary' };

        return this.mutationQueue.enqueue(async () => {
          await fsp.rm(target, { force: false });
          return { ok: true, output: { path: target } };
        });
      }

      case 'run_command': {
        const command = typeof args.command === 'string' ? args.command : '';
        const argv = Array.isArray(args.args)
          ? args.args.filter((a): a is string => typeof a === 'string')
          : [];
        const cwdArg = typeof args.cwd === 'string' ? args.cwd : this.config.workspacePath;
        const cwd = this.resolveWorkspacePath(cwdArg);
        const timeoutSec = typeof args.timeoutSec === 'number' ? args.timeoutSec : undefined;

        if (!command) return { ok: false, error: 'command is required' };
        if (!(await this.sandbox.validatePath(cwd))) {
          return { ok: false, error: 'cwd escapes workspace boundary' };
        }

        const result = await runCommand({
          command,
          args: argv,
          cwd,
          timeoutSec,
        });
        return result.ok ? { ok: true, output: result.output } : { ok: false, error: result.errorMessage };
      }

      case 'memory_search': {
        if (!this.memoryController) {
          return { ok: false, error: 'Memory system not initialized.' };
        }
        const msQuery = typeof args.query === 'string' ? args.query : '';
        const msTopK = typeof args.topK === 'number' ? args.topK : 5;
        const msCategory = typeof args.category === 'string' ? args.category : undefined;
        const msResults = this.memoryController.recall(msQuery, { topK: msTopK, category: msCategory });
        return {
          ok: true,
          output: JSON.stringify(
            msResults.map((m) => ({ id: m.id, content: m.content, category: m.category })),
          ),
        };
      }

      case 'memory_store': {
        if (!this.memoryController) {
          return { ok: false, error: 'Memory system not initialized.' };
        }
        const validation = validateMemoryStoreInput({
          content: typeof args.content === 'string' ? args.content : '',
          category: typeof args.category === 'string' ? args.category : '',
          sensitivity: typeof args.sensitivity === 'string' ? args.sensitivity : undefined,
        });
        if (!validation.ok) {
          return { ok: false, error: validation.error };
        }
        const mEntry = this.memoryController.store({
          content: validation.value.content,
          category: validation.value.category,
          sensitivity: validation.value.sensitivity,
        });
        const maxEntries = parseInt(process.env.AHA_MEMORY_MAX_ENTRIES ?? '500', 10);
        this.memoryController.evict(maxEntries);
        return { ok: true, output: JSON.stringify({ id: mEntry.id }) };
      }

      default:
        return { ok: false, error: `Unsupported tool: ${name}` };
    }
  }

  private toPolicyAction(toolName: string): PolicyAction {
    switch (toolName) {
      case 'browser_tool':
        return 'browser_open';
      case 'list_dir':
        return 'list_dir';
      case 'read_file':
        return 'read_file';
      case 'create_dir':
      case 'write_file':
      case 'diff_edit':
        return 'write_file';
      case 'browser_search':
        return 'web_search';
      case 'fetch_url':
      case 'browser_open':
        return 'fetch_url';
      case 'extract_main_content':
        return 'extract_main_content';
      case 'delete_file':
        return 'delete_file';
      case 'run_command':
        return 'run_command';
      default:
        return 'read_file';
    }
  }

  private toApprovalActionType(toolName: string): ApprovalActionType {
    switch (toolName) {
      case 'delete_file':
        return 'delete_file';
      case 'run_command':
        return 'run_command';
      default:
        return 'write_file';
    }
  }

  private toRiskLevel(toolName: string): RiskLevel {
    switch (toolName) {
      case 'run_command':
        return 'high';
      case 'delete_file':
        return 'critical';
      default:
        return 'medium';
    }
  }

  private describeToolTarget(toolName: string, rawArgs: string): string {
    try {
      const args = JSON.parse(rawArgs) as Record<string, unknown>;
      if (typeof args.path === 'string') return args.path;
      if (typeof args.command === 'string') return `${args.command} ${(args.args as string[] | undefined)?.join(' ') ?? ''}`.trim();
      if (typeof args.url === 'string') return args.url;
      if (typeof args.query === 'string') return args.query;
    } catch {
      // fall through
    }
    return toolName;
  }

  private resolveExecutionContext(payload: SendMessagePayload): ExecutionContext {
    const mode = payload.execution?.mode === 'autonomous' ? 'autonomous' : DEFAULT_MODE;
    const maxStepsRaw = payload.execution?.budget?.maxSteps;
    const maxWritesRaw = payload.execution?.budget?.maxWrites;
    const maxCommandsRaw = payload.execution?.budget?.maxCommands;

    const maxSteps =
      typeof maxStepsRaw === 'number' && Number.isFinite(maxStepsRaw)
        ? Math.max(1, Math.min(64, Math.floor(maxStepsRaw)))
        : mode === 'autonomous'
          ? AUTONOMOUS_DEFAULT_MAX_STEPS
          : MAX_TOOL_STEPS;
    const maxWrites =
      typeof maxWritesRaw === 'number' && Number.isFinite(maxWritesRaw)
        ? Math.max(1, Math.min(200, Math.floor(maxWritesRaw)))
        : undefined;
    const maxCommands =
      typeof maxCommandsRaw === 'number' && Number.isFinite(maxCommandsRaw)
        ? Math.max(1, Math.min(200, Math.floor(maxCommandsRaw)))
        : undefined;

    return {
      mode,
      budget: { maxSteps, maxWrites, maxCommands },
      usage: { steps: 0, writes: 0, commands: 0 },
    };
  }

  private toBudgetPayload(execution: ExecutionContext): TaskStatusChangePayload['budget'] {
    return {
      stepsUsed: execution.usage.steps,
      stepsLimit: execution.budget.maxSteps,
      writesUsed: execution.usage.writes,
      writesLimit: execution.budget.maxWrites,
      commandsUsed: execution.usage.commands,
      commandsLimit: execution.budget.maxCommands,
    };
  }

  private canAutoApproveInAutonomousMode(mode: ExecutionMode, action: PolicyAction): boolean {
    if (mode !== 'autonomous') return false;
    return action === 'write_file' || action === 'delete_file' || action === 'run_command';
  }

  private consumeMutationBudget(
    toolName: string,
    execution: ExecutionContext,
  ): { ok: true } | { ok: false; reason: string } {
    if (toolName === 'run_command') {
      execution.usage.commands += 1;
      if (
        typeof execution.budget.maxCommands === 'number' &&
        execution.usage.commands > execution.budget.maxCommands
      ) {
        return {
          ok: false,
          reason: `Execution budget exceeded: commands ${execution.usage.commands.toString()}/${execution.budget.maxCommands.toString()}`,
        };
      }
      return { ok: true };
    }

    if (
      toolName === 'create_dir' ||
      toolName === 'write_file' ||
      toolName === 'diff_edit' ||
      toolName === 'delete_file'
    ) {
      execution.usage.writes += 1;
      if (
        typeof execution.budget.maxWrites === 'number' &&
        execution.usage.writes > execution.budget.maxWrites
      ) {
        return {
          ok: false,
          reason: `Execution budget exceeded: writes ${execution.usage.writes.toString()}/${execution.budget.maxWrites.toString()}`,
        };
      }
      return { ok: true };
    }

    return { ok: true };
  }

  private evaluateToolPolicy(
    toolName: string,
    rawArgs: string,
    approved: boolean,
    approvalExpiresAt?: string,
  ): ReturnType<typeof evaluate> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(rawArgs) as Record<string, unknown>;
    } catch {
      return { decision: 'deny', errorCode: 'AHA-TOOL-001', reason: 'Invalid tool arguments JSON' };
    }

    const resourcePath = typeof args.path === 'string' ? this.resolveWorkspacePath(args.path) : undefined;
    const command = typeof args.command === 'string' ? args.command : undefined;
    const url = typeof args.url === 'string' ? args.url : undefined;

    return evaluate({
      actor: 'assistant',
      action: this.toPolicyAction(toolName),
      resource: {
        path: resourcePath,
        url,
        workspace: this.config.workspacePath,
        command,
      },
      context: {
        sessionValid: true,
        originValid: true,
        hasUserApproval: approved,
        approvalScope:
          approved && approvalExpiresAt
            ? {
                workspace: this.config.workspacePath,
                maxActions: 1,
                expiresAt: approvalExpiresAt,
              }
            : undefined,
      },
    });
  }

  private handleApproveAction(
    envelope: WsEnvelope<ApproveActionPayload>,
    ws: WebSocket,
    traceId: string,
  ): void {
    const { payload } = envelope;

    // Validate via approvalManager
    const result = this.approvalManager.validateApproval(payload.approvalId, payload.approvalNonce);

    this.auditLogger.audit({
      traceId,
      taskId: payload.taskId,
      requestId: envelope.requestId,
      actor: 'user',
      action: 'approve_action',
      result: result.valid ? 'approved' : 'rejected',
      details: { approvalId: payload.approvalId, decision: payload.decision },
    });
    this.logProgress('approval_decision', {
      taskId: payload.taskId,
      approvalId: payload.approvalId,
      decision: payload.decision,
    });

    if (!result.valid) {
      this.sendError(ws, envelope.requestId, 'AHA-POLICY-002', result.error);
      return;
    }

    const pending = this.pendingApprovals.get(payload.approvalId);
    if (!pending) {
      this.sendError(ws, envelope.requestId, 'AHA-TASK-001', 'Approval context not found');
      return;
    }

    pending.ws = ws;

    // Consume the approval
    this.approvalManager.consumeApproval(payload.approvalId);
    this.pendingApprovals.delete(payload.approvalId);
    this.checkpointManager?.deleteApprovalRecovery(payload.approvalId);

    if (payload.decision === 'reject') {
      this.taskManager.transition(payload.taskId, 'failed');
      this.clearTaskRecoveryState(payload.taskId);
      this.sendEnvelope(ws, pending.requestId, ServerEvents.TASK_TERMINAL, {
        taskId: payload.taskId,
        state: 'failed',
        summary: 'Action rejected by user',
        errorCode: 'AHA-POLICY-002',
      } satisfies TaskTerminalPayload);
      this.logProgress('task_failed', {
        taskId: payload.taskId,
        reason: 'approval rejected',
      });
      return;
    }

    // Resume the task (transition from blocked -> running)
    const task = this.taskManager.getTask(payload.taskId);
    if (task && task.status === 'blocked') {
      this.taskManager.transition(task.id, 'running');

      const statusPayload: TaskStatusChangePayload = {
        taskId: task.id,
        state: task.status,
        desc: 'Task resumed after approval',
        mode: pending.execution.mode,
        budget: this.toBudgetPayload(pending.execution),
      };

      this.sendEnvelope(ws, pending.requestId, ServerEvents.TASK_STATUS_CHANGE, statusPayload);
    }

    const policyAfterApproval = this.evaluateToolPolicy(
      pending.toolCall.name,
      pending.toolCall.arguments,
      true,
      result.approval.expiresAt,
    );

    if (policyAfterApproval.decision !== 'allow') {
      this.taskManager.transition(payload.taskId, 'failed');
      this.clearTaskRecoveryState(payload.taskId);
      this.sendEnvelope(ws, pending.requestId, ServerEvents.TASK_TERMINAL, {
        taskId: payload.taskId,
        state: 'failed',
        summary: policyAfterApproval.reason ?? 'Approved action still denied by policy',
        errorCode: policyAfterApproval.errorCode ?? 'AHA-POLICY-001',
      } satisfies TaskTerminalPayload);
      return;
    }

    void (async () => {
      const toolResult = await this.executeToolCall(
        pending.toolCall.name,
        pending.toolCall.arguments,
        {
          traceId: pending.traceId,
          taskId: pending.taskId,
          requestId: pending.requestId,
        },
      );
      pending.messages.push({
        role: 'tool',
        toolCallId: pending.toolCall.id,
        content: JSON.stringify(toolResult),
      });

      await this.continueAgentLoop({
        taskId: pending.taskId,
        requestId: pending.requestId,
        traceId: pending.traceId,
        ws,
        messages: pending.messages,
        startStep: pending.step + 1,
        execution: pending.execution,
      });
    })().catch((err: unknown) => {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      this.taskManager.transition(payload.taskId, 'failed');
      this.clearTaskRecoveryState(payload.taskId);
      this.sendEnvelope(ws, pending.requestId, ServerEvents.TASK_TERMINAL, {
        taskId: payload.taskId,
        state: 'failed',
        summary: `Resume failed: ${errMsg}`,
        errorCode: 'AHA-SYS-001',
      } satisfies TaskTerminalPayload);
    });
  }

  private handleCancelTask(
    envelope: WsEnvelope<CancelTaskPayload>,
    ws: WebSocket,
    traceId: string,
  ): void {
    const { payload } = envelope;

    for (const [approvalId, pending] of this.pendingApprovals.entries()) {
      if (pending.taskId === payload.taskId) {
        this.pendingApprovals.delete(approvalId);
        this.checkpointManager?.deleteApprovalRecovery(approvalId);
      }
    }

    // Cancel the task
    const result = this.taskManager.cancel(payload.taskId);

    this.auditLogger.audit({
      traceId,
      taskId: payload.taskId,
      requestId: envelope.requestId,
      actor: 'user',
      action: 'cancel_task',
      result: 'code' in result ? 'error' : 'cancelled',
      details: { reason: payload.reason },
    });

    if ('code' in result) {
      // AhaError returned
      this.sendError(ws, envelope.requestId, result.code, result.message);
      return;
    }

    // Send task_terminal with cancelled
    const terminalPayload: TaskTerminalPayload = {
      taskId: payload.taskId,
      state: 'cancelled',
      summary: payload.reason ?? 'Task cancelled by user',
    };

    this.clearTaskRecoveryState(payload.taskId);
    this.sendEnvelope(ws, envelope.requestId, ServerEvents.TASK_TERMINAL, terminalPayload);
    this.logProgress('task_cancelled', {
      taskId: payload.taskId,
      reason: terminalPayload.summary,
    });
  }

  private handleListMemories(
    envelope: WsEnvelope<ListMemoriesPayload>,
    ws: WebSocket,
  ): void {
    if (!this.memoryController) {
      this.sendError(ws, envelope.requestId, 'AHA-SYS-001', 'Memory system not initialized');
      return;
    }

    const items = this.memoryController.list({
      query: envelope.payload.query,
      category: envelope.payload.category,
      sensitivity: envelope.payload.sensitivity,
      limit: envelope.payload.limit,
    });

    const payload: MemoryListPayload = {
      items: items.map((item) => ({
        id: item.id,
        content: item.content,
        category: item.category,
        sensitivity: item.sensitivity,
        accessCount: item.accessCount,
        lastAccessedAt: item.lastAccessedAt,
        createdAt: item.createdAt,
        score: item.score,
      })),
    };

    this.sendEnvelope(ws, envelope.requestId, ServerEvents.MEMORY_LIST, payload);
  }

  private handleDeleteMemory(
    envelope: WsEnvelope<DeleteMemoryPayload>,
    ws: WebSocket,
    traceId: string,
  ): void {
    if (!this.memoryController) {
      this.sendError(ws, envelope.requestId, 'AHA-SYS-001', 'Memory system not initialized');
      return;
    }

    const deleted = this.memoryController.delete(envelope.payload.id);
    this.auditLogger.audit({
      traceId,
      taskId: '',
      requestId: envelope.requestId,
      actor: 'user',
      action: 'delete_memory',
      result: deleted ? 'deleted' : 'not_found',
      details: { memoryId: envelope.payload.id },
    });

    const payload: MemoryDeletedPayload = {
      id: envelope.payload.id,
      deleted,
    };

    this.sendEnvelope(ws, envelope.requestId, ServerEvents.MEMORY_DELETED, payload);
  }

  private handleUpdateMemory(
    envelope: WsEnvelope<UpdateMemoryPayload>,
    ws: WebSocket,
    traceId: string,
  ): void {
    if (!this.memoryController) {
      this.sendError(ws, envelope.requestId, 'AHA-SYS-001', 'Memory system not initialized');
      return;
    }

    const validation = validateMemoryUpdateInput({
      content: envelope.payload.content,
      category: envelope.payload.category,
      sensitivity: envelope.payload.sensitivity,
    });
    if (!validation.ok) {
      this.sendError(ws, envelope.requestId, 'AHA-TOOL-001', validation.error);
      return;
    }

    const updated = this.memoryController.update(envelope.payload.id, {
      content: validation.value.content,
      category: validation.value.category,
      sensitivity: validation.value.sensitivity,
    });

    if (!updated) {
      this.sendError(ws, envelope.requestId, 'AHA-TASK-001', 'Memory not found');
      return;
    }

    this.auditLogger.audit({
      traceId,
      taskId: '',
      requestId: envelope.requestId,
      actor: 'user',
      action: 'update_memory',
      result: 'updated',
      details: { memoryId: updated.id },
    });

    const payload: MemoryUpdatedPayload = {
      item: {
        id: updated.id,
        content: updated.content,
        category: updated.category,
        sensitivity: updated.sensitivity,
        accessCount: updated.accessCount,
        lastAccessedAt: updated.lastAccessedAt,
        createdAt: updated.createdAt,
      },
    };

    this.sendEnvelope(ws, envelope.requestId, ServerEvents.MEMORY_UPDATED, payload);
  }

  private logProgress(event: string, details?: Record<string, unknown>): void {
    if (!this.verbose) return;
    const ts = new Date().toISOString();
    const suffix = details ? ` ${JSON.stringify(details)}` : '';
    console.log(`[AhaAgent][${ts}] ${event}${suffix}`);
  }

  private sendEnvelope(ws: WebSocket, requestId: string, type: string, payload: unknown): void {
    const envelope: WsEnvelope<unknown> = {
      protocolVersion: '1.0',
      sessionId: this.gateway?.sessionToken ?? '',
      requestId,
      idempotencyKey: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      type,
      payload,
    };
    ws.send(JSON.stringify(envelope));
  }

  private sendError(ws: WebSocket, requestId: string, errorCode: string, message: string): void {
    const payload: ErrorPayload = {
      requestId,
      errorCode,
      message,
      retryable: false,
    };
    this.sendEnvelope(ws, requestId, ServerEvents.ERROR, payload);
  }

  private handleClientConnect(ws: WebSocket): void {
    for (const task of this.taskManager.listTasks()) {
      if (task.status === 'success' || task.status === 'failed' || task.status === 'cancelled') {
        continue;
      }

      this.sendEnvelope(ws, crypto.randomUUID(), ServerEvents.TASK_STATUS_CHANGE, {
        taskId: task.id,
        state: task.status,
        desc:
          task.status === 'blocked'
            ? 'Recovered pending approval'
            : `Recovered active task: ${task.title}`,
      } satisfies TaskStatusChangePayload);
    }

    for (const [approvalId, pending] of this.pendingApprovals.entries()) {
      pending.ws = ws;
      const approval = this.approvalManager.getActiveApproval(pending.taskId);
      if (!approval || approval.approvalId !== approvalId) {
        continue;
      }
      this.sendEnvelope(
        ws,
        pending.requestId,
        ServerEvents.ACTION_BLOCKED,
        this.approvalManager.toBlockedPayload(approval),
      );
    }
  }

  private persistApprovalRecovery(approvalId: string): void {
    if (!this.checkpointManager) return;
    const pending = this.pendingApprovals.get(approvalId);
    const approval = pending ? this.approvalManager.getActiveApproval(pending.taskId) : null;
    if (!pending || !approval) return;

    const record: ApprovalRecoveryRecord = {
      approval,
      taskId: pending.taskId,
      requestId: pending.requestId,
      traceId: pending.traceId,
      messagesJson: JSON.stringify(pending.messages),
      step: pending.step,
      toolCallJson: JSON.stringify(pending.toolCall),
      executionJson: JSON.stringify(pending.execution),
      createdAt: new Date().toISOString(),
    };
    this.checkpointManager.saveApprovalRecovery(record);
  }

  private clearTaskRecoveryState(taskId: string): void {
    this.checkpointManager?.deleteCheckpointsForTask(taskId);
    this.checkpointManager?.deleteApprovalRecoveriesForTask(taskId);
  }

  private reconcileInterruptedTasksOnStartup(): void {
    if (!this.checkpointManager) return;

    const restoredTaskIds = new Set<string>();
    for (const record of this.checkpointManager.loadApprovalRecoveries()) {
      try {
        const expiresAt = new Date(record.approval.expiresAt).getTime();
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
          this.checkpointManager.markTaskFailed(
            record.taskId,
            'AHA-POLICY-002',
            'Approval expired while daemon was offline.',
          );
          this.clearTaskRecoveryState(record.taskId);
          continue;
        }

        const task = this.checkpointManager.loadTask(record.taskId);
        if (!task || task.status !== 'blocked') {
          this.clearTaskRecoveryState(record.taskId);
          continue;
        }

        this.taskManager.restoreTask(task);
        this.approvalManager.restoreApproval(record.approval);
        this.pendingApprovals.set(record.approval.approvalId, {
          taskId: record.taskId,
          requestId: record.requestId,
          traceId: record.traceId,
          messages: JSON.parse(record.messagesJson) as ChatMessage[],
          step: record.step,
          toolCall: JSON.parse(record.toolCallJson) as ToolCallRequest,
          execution: JSON.parse(record.executionJson) as ExecutionContext,
        });
        restoredTaskIds.add(record.taskId);
      } catch {
        this.checkpointManager.markTaskFailed(
          record.taskId,
          'AHA-SYS-001',
          'Task recovery data was corrupted after daemon restart.',
        );
        this.clearTaskRecoveryState(record.taskId);
      }
    }

    const pendingTasks = this.checkpointManager.loadPendingTasks();
    if (pendingTasks.length === 0) return;

    for (const task of pendingTasks) {
      if (restoredTaskIds.has(task.id)) {
        continue;
      }
      const checkpoint = this.checkpointManager.loadCheckpoint(task.id);
      this.checkpointManager.markTaskFailed(
        task.id,
        'AHA-SYS-001',
        'Task interrupted by daemon restart before automatic recovery was available.',
      );
      this.checkpointManager.deleteCheckpointsForTask(task.id);
      this.auditLogger.audit({
        traceId: crypto.randomUUID(),
        taskId: task.id,
        requestId: '',
        actor: 'system',
        action: 'startup_reconcile_task',
        result: 'failed',
        details: {
          previousStatus: task.status,
          checkpointId: checkpoint?.checkpointId,
        },
      });
    }

    this.logProgress('startup_reconciled_interrupted_tasks', {
      count: pendingTasks.length,
      restoredBlockedTasks: restoredTaskIds.size,
    });
  }
}
