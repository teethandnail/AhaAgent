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
  type ApprovalActionType,
  type RiskLevel,
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
import { CheckpointManager } from './orchestrator/checkpoint-manager.js';
import { MemoryController } from './memory/memory-controller.js';
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
import { evaluate } from './policy/policy-engine.js';

import type { Database as SqliteDatabase } from 'better-sqlite3';

const MAX_TOOL_STEPS = 8;

interface ToolCallRequest {
  id: string;
  name: string;
  arguments: string;
}

interface PendingApprovalContext {
  taskId: string;
  requestId: string;
  traceId: string;
  ws: WebSocket;
  messages: ChatMessage[];
  step: number;
  toolCall: ToolCallRequest;
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
        },
        required: ['path', 'content'],
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

  private gateway: Gateway | null = null;
  private taskManager: TaskManager;
  private approvalManager: ApprovalManager;
  private checkpointManager: CheckpointManager | null = null;
  private memoryController: MemoryController | null = null;
  private mutationQueue: MutationQueue;
  private fileLock: FileLock;
  private sandbox: Sandbox;
  private auditLogger: AuditLogger;
  private llmRouter: LLMRouter | null = null;
  private extensionInstaller: ExtensionInstaller;
  private extensionRunner: ExtensionRunner;
  private pendingApprovals = new Map<string, PendingApprovalContext>();

  private db: AppDatabase | null = null;
  private sqlite: SqliteDatabase | null = null;

  constructor(config: AhaAppConfig) {
    this.config = config;

    // Eagerly create services that don't need the database
    this.taskManager = new TaskManager();
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

    // 4. Start gateway with message handler
    this.gateway = createGateway({
      port: this.config.port,
      originPort: this.config.originPort,
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

    // Create a task
    const task = this.taskManager.createTask(payload.text);

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

    // Persist task if checkpoint manager is available
    this.checkpointManager?.saveTask(task);

    // Send task_status_change back
    const statusPayload: TaskStatusChangePayload = {
      taskId: task.id,
      state: task.status,
      desc: `Task created: ${payload.text}`,
    };

    this.sendEnvelope(ws, envelope.requestId, ServerEvents.TASK_STATUS_CHANGE, statusPayload);

    // Continue task execution asynchronously so the gateway thread stays responsive.
    void this.runLLMTask(task.id, payload.text, envelope.requestId, ws, traceId);
  }

  private async runLLMTask(
    taskId: string,
    userText: string,
    requestId: string,
    ws: WebSocket,
    traceId: string,
  ): Promise<void> {
    if (!this.llmRouter) {
      this.taskManager.transition(taskId, 'failed');
      const terminalPayload: TaskTerminalPayload = {
        taskId,
        state: 'failed',
        summary: 'LLM is not configured. Set AHA_LLM_API_KEY or ~/.aha/config.json.',
        errorCode: 'AHA-LLM-001',
      };
      this.sendEnvelope(ws, requestId, ServerEvents.TASK_TERMINAL, terminalPayload);
      return;
    }

    try {
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content:
            'You are a coding agent operating inside a local workspace. Use tools when filesystem changes are requested. ' +
            'When the user asks to create files/directories, perform it with tools first, then report what was created.',
        },
        { role: 'user', content: userText },
      ];
      await this.continueAgentLoop({
        taskId,
        requestId,
        traceId,
        ws,
        messages,
        startStep: 0,
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
    }
  }

  private async continueAgentLoop(params: {
    taskId: string;
    requestId: string;
    traceId: string;
    ws: WebSocket;
    messages: ChatMessage[];
    startStep: number;
  }): Promise<void> {
    if (!this.llmRouter) return;

    for (let step = params.startStep; step < MAX_TOOL_STEPS; step++) {
      const current = this.taskManager.getTask(params.taskId);
      if (current?.status === 'cancelled') return;

      const response = await this.llmRouter.chat(params.messages, params.traceId, {
        tools: CODING_TOOLS as unknown as unknown[],
        toolChoice: 'auto',
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
            const task = this.taskManager.getTask(params.taskId);
            if (task && task.status === 'running') {
              this.taskManager.transition(task.id, 'blocked');
              this.sendEnvelope(params.ws, params.requestId, ServerEvents.TASK_STATUS_CHANGE, {
                taskId: task.id,
                state: 'blocked',
                desc: `Waiting for approval: ${tc.name}`,
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

            this.pendingApprovals.set(approval.approvalId, {
              taskId: params.taskId,
              requestId: params.requestId,
              traceId: params.traceId,
              ws: params.ws,
              messages: params.messages,
              step,
              toolCall: tc,
            });

            const blockedPayload = this.approvalManager.toBlockedPayload(approval);
            this.sendEnvelope(params.ws, params.requestId, ServerEvents.ACTION_BLOCKED, blockedPayload);
            return;
          }

          const toolResult = await this.executeToolCall(tc.name, tc.arguments);
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
      this.sendEnvelope(params.ws, params.requestId, ServerEvents.TASK_TERMINAL, {
        taskId: params.taskId,
        state: 'success',
        summary: 'Task completed',
      } satisfies TaskTerminalPayload);
      return;
    }

    this.taskManager.transition(params.taskId, 'failed');
    this.sendEnvelope(params.ws, params.requestId, ServerEvents.TASK_TERMINAL, {
      taskId: params.taskId,
      state: 'failed',
      summary: `Task aborted after exceeding ${MAX_TOOL_STEPS.toString()} tool iterations.`,
      errorCode: 'AHA-LLM-002',
    } satisfies TaskTerminalPayload);
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

  private async executeToolCall(name: string, rawArgs: string): Promise<Record<string, unknown>> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(rawArgs) as Record<string, unknown>;
    } catch {
      return { ok: false, error: 'Invalid JSON tool arguments' };
    }

    switch (name) {
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
        if (!pathArg) return { ok: false, error: 'path is required' };

        const target = this.resolveWorkspacePath(pathArg);
        if (!(await this.ensureCreatablePath(target))) {
          return { ok: false, error: 'path escapes workspace boundary' };
        }

        return this.mutationQueue.enqueue(async () => {
          await fsp.mkdir(path.dirname(target), { recursive: true });
          await fsp.writeFile(target, content, 'utf-8');
          const version = await computeFileVersion(target);
          return { ok: true, output: { path: target, version } };
        });
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

      default:
        return { ok: false, error: `Unsupported tool: ${name}` };
    }
  }

  private toPolicyAction(toolName: string): PolicyAction {
    switch (toolName) {
      case 'list_dir':
        return 'list_dir';
      case 'read_file':
        return 'read_file';
      case 'create_dir':
      case 'write_file':
      case 'diff_edit':
        return 'write_file';
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
    } catch {
      // fall through
    }
    return toolName;
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

    return evaluate({
      actor: 'assistant',
      action: this.toPolicyAction(toolName),
      resource: {
        path: resourcePath,
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

    if (!result.valid) {
      this.sendError(ws, envelope.requestId, 'AHA-POLICY-002', result.error);
      return;
    }

    const pending = this.pendingApprovals.get(payload.approvalId);
    if (!pending) {
      this.sendError(ws, envelope.requestId, 'AHA-TASK-001', 'Approval context not found');
      return;
    }

    // Consume the approval
    this.approvalManager.consumeApproval(payload.approvalId);
    this.pendingApprovals.delete(payload.approvalId);

    if (payload.decision === 'reject') {
      this.taskManager.transition(payload.taskId, 'failed');
      this.sendEnvelope(pending.ws, pending.requestId, ServerEvents.TASK_TERMINAL, {
        taskId: payload.taskId,
        state: 'failed',
        summary: 'Action rejected by user',
        errorCode: 'AHA-POLICY-002',
      } satisfies TaskTerminalPayload);
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
      };

      this.sendEnvelope(pending.ws, pending.requestId, ServerEvents.TASK_STATUS_CHANGE, statusPayload);
    }

    const policyAfterApproval = this.evaluateToolPolicy(
      pending.toolCall.name,
      pending.toolCall.arguments,
      true,
      result.approval.expiresAt,
    );

    if (policyAfterApproval.decision !== 'allow') {
      this.taskManager.transition(payload.taskId, 'failed');
      this.sendEnvelope(pending.ws, pending.requestId, ServerEvents.TASK_TERMINAL, {
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
        ws: pending.ws,
        messages: pending.messages,
        startStep: pending.step + 1,
      });
    })().catch((err: unknown) => {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      this.taskManager.transition(payload.taskId, 'failed');
      this.sendEnvelope(pending.ws, pending.requestId, ServerEvents.TASK_TERMINAL, {
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

    this.sendEnvelope(ws, envelope.requestId, ServerEvents.TASK_TERMINAL, terminalPayload);
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
}
