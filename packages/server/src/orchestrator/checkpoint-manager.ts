import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { ApprovalRequest } from '@aha-agent/shared';
import { eq, desc, notInArray } from 'drizzle-orm';
import type { Checkpoint, TaskNode } from '@aha-agent/shared';
import type { AppDatabase } from '../db/client.js';
import { tasks, checkpoints, approvalRecoveries } from '../db/schema.js';

export interface ApprovalRecoveryRecord {
  approval: ApprovalRequest;
  taskId: string;
  requestId: string;
  traceId: string;
  messagesJson: string;
  step: number;
  toolCallJson: string;
  executionJson: string;
  createdAt: string;
}

const CREATE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS checkpoints (
    checkpoint_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    step_id TEXT NOT NULL,
    llm_context_ref TEXT NOT NULL,
    pending_approval_id TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trace_id TEXT NOT NULL,
    task_id TEXT,
    request_id TEXT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    result TEXT NOT NULL,
    details TEXT,
    timestamp TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS approval_recoveries (
    approval_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    request_id TEXT NOT NULL,
    trace_id TEXT NOT NULL,
    approval_json TEXT NOT NULL,
    messages_json TEXT NOT NULL,
    step INTEGER NOT NULL,
    tool_call_json TEXT NOT NULL,
    execution_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`;

export class CheckpointManager {
  private db: AppDatabase;
  private sqlite: SqliteDatabase;

  constructor(db: AppDatabase, sqlite: SqliteDatabase) {
    this.db = db;
    this.sqlite = sqlite;
  }

  /**
   * Create all tables if they do not already exist.
   */
  initSchema(): void {
    this.sqlite.exec(CREATE_TABLES_SQL);
  }

  /**
   * Save a checkpoint record. Also upserts the associated task status to 'running'.
   */
  saveCheckpoint(checkpoint: Checkpoint): void {
    this.db
      .insert(checkpoints)
      .values({
        checkpointId: checkpoint.checkpointId,
        taskId: checkpoint.taskId,
        stepId: checkpoint.stepId,
        llmContextRef: checkpoint.llmContextRef,
        pendingApprovalId: checkpoint.pendingApprovalId ?? null,
        createdAt: checkpoint.createdAt,
      })
      .run();
  }

  /**
   * Load the latest checkpoint for a given task (ordered by createdAt descending).
   * Returns null if no checkpoint exists.
   */
  loadCheckpoint(taskId: string): Checkpoint | null {
    const row = this.db
      .select()
      .from(checkpoints)
      .where(eq(checkpoints.taskId, taskId))
      .orderBy(desc(checkpoints.createdAt))
      .limit(1)
      .get();

    if (!row) return null;

    return {
      checkpointId: row.checkpointId,
      taskId: row.taskId,
      stepId: row.stepId,
      llmContextRef: row.llmContextRef,
      pendingApprovalId: row.pendingApprovalId ?? undefined,
      createdAt: row.createdAt,
    };
  }

  /**
   * Upsert a task record.
   */
  saveTask(task: TaskNode): void {
    const now = new Date().toISOString();
    this.db
      .insert(tasks)
      .values({
        id: task.id,
        parentId: task.parentId ?? null,
        title: task.title,
        status: task.status,
        errorCode: task.errorCode ?? null,
        errorMessage: task.errorMessage ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: tasks.id,
        set: {
          parentId: task.parentId ?? null,
          title: task.title,
          status: task.status,
          errorCode: task.errorCode ?? null,
          errorMessage: task.errorMessage ?? null,
          updatedAt: now,
        },
      })
      .run();
  }

  /**
   * Load a task by ID. Returns null if not found.
   */
  loadTask(taskId: string): TaskNode | null {
    const row = this.db.select().from(tasks).where(eq(tasks.id, taskId)).get();

    if (!row) return null;

    return {
      id: row.id,
      title: row.title,
      status: row.status as TaskNode['status'],
      ...(row.parentId != null ? { parentId: row.parentId } : {}),
      ...(row.errorCode != null ? { errorCode: row.errorCode } : {}),
      ...(row.errorMessage != null ? { errorMessage: row.errorMessage } : {}),
    };
  }

  /**
   * Return all tasks that are not in a terminal state (pending, running, blocked).
   * Useful for daemon restart recovery.
   */
  loadPendingTasks(): TaskNode[] {
    const terminalStates = ['success', 'failed', 'cancelled'];
    const rows = this.db
      .select()
      .from(tasks)
      .where(notInArray(tasks.status, terminalStates))
      .all();

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status as TaskNode['status'],
      ...(row.parentId != null ? { parentId: row.parentId } : {}),
      ...(row.errorCode != null ? { errorCode: row.errorCode } : {}),
      ...(row.errorMessage != null ? { errorMessage: row.errorMessage } : {}),
    }));
  }

  /**
   * Delete a checkpoint by ID (e.g. after successful completion).
   */
  deleteCheckpoint(checkpointId: string): void {
    this.db
      .delete(checkpoints)
      .where(eq(checkpoints.checkpointId, checkpointId))
      .run();
  }

  /**
   * Delete every checkpoint associated with a task.
   */
  deleteCheckpointsForTask(taskId: string): void {
    this.db.delete(checkpoints).where(eq(checkpoints.taskId, taskId)).run();
  }

  /**
   * Mark a task as failed during daemon restart reconciliation.
   */
  markTaskFailed(taskId: string, errorCode: string, errorMessage: string): void {
    const now = new Date().toISOString();
    this.db
      .update(tasks)
      .set({
        status: 'failed',
        errorCode,
        errorMessage,
        updatedAt: now,
      })
      .where(eq(tasks.id, taskId))
      .run();
  }

  saveApprovalRecovery(record: ApprovalRecoveryRecord): void {
    this.db
      .insert(approvalRecoveries)
      .values({
        approvalId: record.approval.approvalId,
        taskId: record.taskId,
        requestId: record.requestId,
        traceId: record.traceId,
        approvalJson: JSON.stringify(record.approval),
        messagesJson: record.messagesJson,
        step: record.step,
        toolCallJson: record.toolCallJson,
        executionJson: record.executionJson,
        createdAt: record.createdAt,
      })
      .onConflictDoUpdate({
        target: approvalRecoveries.approvalId,
        set: {
          taskId: record.taskId,
          requestId: record.requestId,
          traceId: record.traceId,
          approvalJson: JSON.stringify(record.approval),
          messagesJson: record.messagesJson,
          step: record.step,
          toolCallJson: record.toolCallJson,
          executionJson: record.executionJson,
          createdAt: record.createdAt,
        },
      })
      .run();
  }

  loadApprovalRecoveries(): ApprovalRecoveryRecord[] {
    const rows = this.db.select().from(approvalRecoveries).all();
    return rows.map((row) => ({
      approval: JSON.parse(row.approvalJson) as ApprovalRequest,
      taskId: row.taskId,
      requestId: row.requestId,
      traceId: row.traceId,
      messagesJson: row.messagesJson,
      step: row.step,
      toolCallJson: row.toolCallJson,
      executionJson: row.executionJson,
      createdAt: row.createdAt,
    }));
  }

  deleteApprovalRecovery(approvalId: string): void {
    this.db
      .delete(approvalRecoveries)
      .where(eq(approvalRecoveries.approvalId, approvalId))
      .run();
  }

  deleteApprovalRecoveriesForTask(taskId: string): void {
    this.db
      .delete(approvalRecoveries)
      .where(eq(approvalRecoveries.taskId, taskId))
      .run();
  }
}
