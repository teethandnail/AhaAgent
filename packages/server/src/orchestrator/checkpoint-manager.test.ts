import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { Checkpoint, TaskNode } from '@aha-agent/shared';
import * as schema from '../db/schema.js';
import { CheckpointManager } from './checkpoint-manager.js';

function createInMemoryDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

describe('CheckpointManager', () => {
  let sqlite: InstanceType<typeof Database>;
  let manager: CheckpointManager;

  beforeEach(() => {
    const result = createInMemoryDb();
    sqlite = result.sqlite;
    manager = new CheckpointManager(result.db, sqlite);
    manager.initSchema();
  });

  afterEach(() => {
    sqlite.close();
  });

  // --- initSchema ---

  it('initSchema creates tables without error', () => {
    // initSchema already ran in beforeEach; calling it again should be idempotent
    expect(() => manager.initSchema()).not.toThrow();

    // Verify tables exist by querying sqlite_master
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('tasks');
    expect(tableNames).toContain('checkpoints');
    expect(tableNames).toContain('audit_logs');
    expect(tableNames).toContain('approval_recoveries');
  });

  // --- saveTask / loadTask ---

  it('saveTask and loadTask roundtrip', () => {
    const task: TaskNode = {
      id: 'task-1',
      title: 'Test Task',
      status: 'pending',
    };

    manager.saveTask(task);
    const loaded = manager.loadTask('task-1');

    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe('task-1');
    expect(loaded!.title).toBe('Test Task');
    expect(loaded!.status).toBe('pending');
  });

  it('saveTask upserts on conflict', () => {
    const task: TaskNode = {
      id: 'task-1',
      title: 'Original',
      status: 'pending',
    };
    manager.saveTask(task);

    const updated: TaskNode = {
      id: 'task-1',
      title: 'Updated',
      status: 'running',
    };
    manager.saveTask(updated);

    const loaded = manager.loadTask('task-1');
    expect(loaded!.title).toBe('Updated');
    expect(loaded!.status).toBe('running');
  });

  it('loadTask returns null for unknown task', () => {
    const result = manager.loadTask('nonexistent');
    expect(result).toBeNull();
  });

  it('saveTask preserves optional fields', () => {
    const task: TaskNode = {
      id: 'task-err',
      parentId: 'parent-1',
      title: 'Error Task',
      status: 'failed',
      errorCode: 'TIMEOUT',
      errorMessage: 'Request timed out',
    };

    // Must save parent first due to foreign key constraints on checkpoints,
    // but tasks table does not enforce parent FK.
    manager.saveTask(task);
    const loaded = manager.loadTask('task-err');

    expect(loaded).not.toBeNull();
    expect(loaded!.parentId).toBe('parent-1');
    expect(loaded!.errorCode).toBe('TIMEOUT');
    expect(loaded!.errorMessage).toBe('Request timed out');
  });

  // --- saveCheckpoint / loadCheckpoint ---

  it('saveCheckpoint and loadCheckpoint roundtrip', () => {
    // Must create the task first (foreign key constraint)
    manager.saveTask({ id: 'task-1', title: 'T1', status: 'running' });

    const cp: Checkpoint = {
      checkpointId: 'cp-1',
      taskId: 'task-1',
      stepId: 'step-1',
      llmContextRef: 'ctx-ref-abc',
      createdAt: '2025-01-01T00:00:00.000Z',
    };

    manager.saveCheckpoint(cp);
    const loaded = manager.loadCheckpoint('task-1');

    expect(loaded).not.toBeNull();
    expect(loaded!.checkpointId).toBe('cp-1');
    expect(loaded!.taskId).toBe('task-1');
    expect(loaded!.stepId).toBe('step-1');
    expect(loaded!.llmContextRef).toBe('ctx-ref-abc');
    expect(loaded!.pendingApprovalId).toBeUndefined();
    expect(loaded!.createdAt).toBe('2025-01-01T00:00:00.000Z');
  });

  it('loadCheckpoint returns null for unknown task', () => {
    const result = manager.loadCheckpoint('nonexistent');
    expect(result).toBeNull();
  });

  it('saveCheckpoint with pendingApprovalId', () => {
    manager.saveTask({ id: 'task-2', title: 'T2', status: 'blocked' });

    const cp: Checkpoint = {
      checkpointId: 'cp-2',
      taskId: 'task-2',
      stepId: 'step-2',
      llmContextRef: 'ctx-ref-def',
      pendingApprovalId: 'approval-99',
      createdAt: '2025-01-02T00:00:00.000Z',
    };

    manager.saveCheckpoint(cp);
    const loaded = manager.loadCheckpoint('task-2');

    expect(loaded).not.toBeNull();
    expect(loaded!.pendingApprovalId).toBe('approval-99');
  });

  it('multiple checkpoints for same task, loadCheckpoint returns latest', () => {
    manager.saveTask({ id: 'task-3', title: 'T3', status: 'running' });

    const cpOld: Checkpoint = {
      checkpointId: 'cp-old',
      taskId: 'task-3',
      stepId: 'step-1',
      llmContextRef: 'ctx-old',
      createdAt: '2025-01-01T00:00:00.000Z',
    };

    const cpNew: Checkpoint = {
      checkpointId: 'cp-new',
      taskId: 'task-3',
      stepId: 'step-2',
      llmContextRef: 'ctx-new',
      createdAt: '2025-01-02T00:00:00.000Z',
    };

    manager.saveCheckpoint(cpOld);
    manager.saveCheckpoint(cpNew);

    const loaded = manager.loadCheckpoint('task-3');
    expect(loaded).not.toBeNull();
    expect(loaded!.checkpointId).toBe('cp-new');
    expect(loaded!.stepId).toBe('step-2');
    expect(loaded!.llmContextRef).toBe('ctx-new');
  });

  // --- deleteCheckpoint ---

  it('deleteCheckpoint removes checkpoint', () => {
    manager.saveTask({ id: 'task-4', title: 'T4', status: 'running' });

    const cp: Checkpoint = {
      checkpointId: 'cp-del',
      taskId: 'task-4',
      stepId: 'step-1',
      llmContextRef: 'ctx-del',
      createdAt: '2025-01-01T00:00:00.000Z',
    };

    manager.saveCheckpoint(cp);
    expect(manager.loadCheckpoint('task-4')).not.toBeNull();

    manager.deleteCheckpoint('cp-del');
    expect(manager.loadCheckpoint('task-4')).toBeNull();
  });

  it('deleteCheckpointsForTask removes all checkpoints for a task', () => {
    manager.saveTask({ id: 'task-5', title: 'T5', status: 'running' });
    manager.saveCheckpoint({
      checkpointId: 'cp-5a',
      taskId: 'task-5',
      stepId: 'step-1',
      llmContextRef: 'ctx-1',
      createdAt: '2025-01-01T00:00:00.000Z',
    });
    manager.saveCheckpoint({
      checkpointId: 'cp-5b',
      taskId: 'task-5',
      stepId: 'step-2',
      llmContextRef: 'ctx-2',
      createdAt: '2025-01-02T00:00:00.000Z',
    });

    manager.deleteCheckpointsForTask('task-5');
    expect(manager.loadCheckpoint('task-5')).toBeNull();
  });

  // --- loadPendingTasks ---

  it('loadPendingTasks returns non-terminal tasks only', () => {
    manager.saveTask({ id: 't-pending', title: 'Pending', status: 'pending' });
    manager.saveTask({ id: 't-running', title: 'Running', status: 'running' });
    manager.saveTask({ id: 't-blocked', title: 'Blocked', status: 'blocked' });
    manager.saveTask({ id: 't-success', title: 'Success', status: 'success' });
    manager.saveTask({ id: 't-failed', title: 'Failed', status: 'failed' });
    manager.saveTask({
      id: 't-cancelled',
      title: 'Cancelled',
      status: 'cancelled',
    });

    const pending = manager.loadPendingTasks();
    const ids = pending.map((t) => t.id).sort();

    expect(ids).toEqual(['t-blocked', 't-pending', 't-running']);
    expect(pending).toHaveLength(3);
  });

  it('loadPendingTasks returns empty array when no tasks exist', () => {
    const pending = manager.loadPendingTasks();
    expect(pending).toEqual([]);
  });

  it('markTaskFailed updates task status and error details', () => {
    manager.saveTask({ id: 'task-6', title: 'T6', status: 'running' });

    manager.markTaskFailed('task-6', 'AHA-SYS-001', 'Interrupted during restart');

    const loaded = manager.loadTask('task-6');
    expect(loaded).not.toBeNull();
    expect(loaded!.status).toBe('failed');
    expect(loaded!.errorCode).toBe('AHA-SYS-001');
    expect(loaded!.errorMessage).toBe('Interrupted during restart');
  });

  it('saveApprovalRecovery and loadApprovalRecoveries roundtrip', () => {
    manager.saveTask({ id: 'task-7', title: 'T7', status: 'blocked' });

    manager.saveApprovalRecovery({
      approval: {
        approvalId: 'approval-7',
        taskId: 'task-7',
        actionType: 'write_file',
        target: 'src/app.ts',
        riskLevel: 'medium',
        nonce: 'nonce-7',
        expiresAt: '2026-03-13T00:05:00.000Z',
        scope: {
          workspace: '/workspace',
          maxActions: 1,
          timeoutSec: 300,
        },
      },
      taskId: 'task-7',
      requestId: 'request-7',
      traceId: 'trace-7',
      messagesJson: '[{"role":"user","content":"hello"}]',
      step: 3,
      toolCallJson: '{"id":"tool-7","name":"write_file","arguments":"{}"}',
      executionJson: '{"mode":"interactive","budget":{"maxSteps":8},"usage":{"steps":3,"writes":0,"commands":0}}',
      createdAt: '2026-03-13T00:00:00.000Z',
    });

    const recoveries = manager.loadApprovalRecoveries();
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]!.approval.approvalId).toBe('approval-7');
    expect(recoveries[0]!.requestId).toBe('request-7');
    expect(recoveries[0]!.step).toBe(3);
  });

  it('deleteApprovalRecovery removes a persisted approval context', () => {
    manager.saveTask({ id: 'task-8', title: 'T8', status: 'blocked' });
    manager.saveApprovalRecovery({
      approval: {
        approvalId: 'approval-8',
        taskId: 'task-8',
        actionType: 'run_command',
        target: 'npm test',
        riskLevel: 'high',
        nonce: 'nonce-8',
        expiresAt: '2026-03-13T00:03:00.000Z',
        scope: {
          workspace: '/workspace',
          maxActions: 1,
          timeoutSec: 180,
        },
      },
      taskId: 'task-8',
      requestId: 'request-8',
      traceId: 'trace-8',
      messagesJson: '[]',
      step: 1,
      toolCallJson: '{"id":"tool-8","name":"run_command","arguments":"{}"}',
      executionJson: '{"mode":"interactive","budget":{"maxSteps":8},"usage":{"steps":1,"writes":0,"commands":0}}',
      createdAt: '2026-03-13T00:00:00.000Z',
    });

    manager.deleteApprovalRecovery('approval-8');
    expect(manager.loadApprovalRecoveries()).toEqual([]);
  });
});
