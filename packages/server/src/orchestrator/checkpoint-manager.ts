import type { Database as SqliteDatabase } from 'better-sqlite3';
import { eq, desc, notInArray } from 'drizzle-orm';
import type { Checkpoint, TaskNode } from '@aha-agent/shared';
import type { AppDatabase } from '../db/client.js';
import { tasks, checkpoints } from '../db/schema.js';

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
}
