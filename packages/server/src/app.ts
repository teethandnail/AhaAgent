import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  type WsEnvelope,
  type SendMessagePayload,
  type ApproveActionPayload,
  type CancelTaskPayload,
  type TaskStatusChangePayload,
  type TaskTerminalPayload,
  type ErrorPayload,
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
import { LLMRouter } from './llm/router.js';
import { createDatabase, type AppDatabase } from './db/client.js';
import { ExtensionInstaller } from './extensions/installer.js';
import { ExtensionRunner } from './extensions/runner.js';

import type { Database as SqliteDatabase } from 'better-sqlite3';

export interface AhaAppConfig {
  port: number;
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

    // Consume the approval
    this.approvalManager.consumeApproval(payload.approvalId);

    // Resume the task (transition from blocked -> running)
    const task = this.taskManager.getTask(payload.taskId);
    if (task && task.status === 'blocked') {
      this.taskManager.transition(task.id, 'running');

      const statusPayload: TaskStatusChangePayload = {
        taskId: task.id,
        state: task.status,
        desc: 'Task resumed after approval',
      };

      this.sendEnvelope(ws, envelope.requestId, ServerEvents.TASK_STATUS_CHANGE, statusPayload);
    }
  }

  private handleCancelTask(
    envelope: WsEnvelope<CancelTaskPayload>,
    ws: WebSocket,
    traceId: string,
  ): void {
    const { payload } = envelope;

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
