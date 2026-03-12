import { describe, expect, it } from 'vitest';
import {
  ClientEvents,
  type DeleteMemoryPayload,
  type ListMemoriesPayload,
  type MemoryDeletedPayload,
  type MemoryListPayload,
  ServerEvents,
  type ApproveActionPayload,
  type CancelTaskPayload,
  type SendMessagePayload,
  type TaskTerminalPayload,
  type TaskStatusChangePayload,
  type ActionBlockedPayload,
  type StreamChunkPayload,
  type WsEnvelope,
} from './protocol.js';

describe('protocol event constants', () => {
  it('exposes the expected client event names', () => {
    expect(ClientEvents).toEqual({
      SEND_MESSAGE: 'send_message',
      APPROVE_ACTION: 'approve_action',
      CANCEL_TASK: 'cancel_task',
      LIST_MEMORIES: 'list_memories',
      DELETE_MEMORY: 'delete_memory',
    });
  });

  it('exposes the expected server event names', () => {
    expect(ServerEvents).toEqual({
      STREAM_CHUNK: 'stream_chunk',
      TASK_STATUS_CHANGE: 'task_status_change',
      ACTION_BLOCKED: 'action_blocked',
      TASK_TERMINAL: 'task_terminal',
      MEMORY_LIST: 'memory_list',
      MEMORY_DELETED: 'memory_deleted',
      ERROR: 'error',
    });
  });
});

describe('protocol payload contracts', () => {
  it('supports typed send_message envelopes', () => {
    const payload: SendMessagePayload = {
      conversationId: 'main',
      text: 'read the repo',
      execution: {
        mode: 'interactive',
        budget: {
          maxSteps: 8,
          maxWrites: 2,
          maxCommands: 1,
        },
      },
    };

    const envelope: WsEnvelope<SendMessagePayload> = {
      protocolVersion: '1.0',
      sessionId: 'session-12345678',
      requestId: 'request-12345678',
      idempotencyKey: 'idem-12345678',
      timestamp: '2026-03-13T00:00:00.000Z',
      type: ClientEvents.SEND_MESSAGE,
      payload,
    };

    expect(envelope.type).toBe('send_message');
    expect(envelope.payload.execution?.budget?.maxSteps).toBe(8);
  });

  it('supports typed approval and cancellation payloads', () => {
    const approval: ApproveActionPayload = {
      taskId: 'task-1',
      approvalId: 'approval-1',
      approvalNonce: 'nonce-1',
      decision: 'approve',
      scope: {
        workspace: '/workspace',
        maxActions: 1,
        timeoutSec: 300,
      },
    };
    const cancel: CancelTaskPayload = {
      taskId: 'task-1',
      reason: 'user cancelled',
    };

    expect(approval.decision).toBe('approve');
    expect(cancel.reason).toBe('user cancelled');
  });

  it('supports typed memory management payloads', () => {
    const list: ListMemoriesPayload = {
      query: 'typescript',
      category: 'fact',
      sensitivity: 'public',
      limit: 20,
    };
    const remove: DeleteMemoryPayload = {
      id: 'memory-1',
    };
    const response: MemoryListPayload = {
      items: [
        {
          id: 'memory-1',
          content: 'Project uses TypeScript strict mode.',
          category: 'fact',
          sensitivity: 'public',
          accessCount: 3,
          lastAccessedAt: '2026-03-13T00:00:00.000Z',
          createdAt: '2026-03-12T00:00:00.000Z',
          score: 0.91,
        },
      ],
    };
    const deleted: MemoryDeletedPayload = {
      id: 'memory-1',
      deleted: true,
    };

    expect(list.limit).toBe(20);
    expect(remove.id).toBe('memory-1');
    expect(response.items[0]?.score).toBe(0.91);
    expect(deleted.deleted).toBe(true);
  });

  it('supports typed server payloads for task lifecycle', () => {
    const status: TaskStatusChangePayload = {
      taskId: 'task-1',
      state: 'running',
      desc: 'Working',
      mode: 'autonomous',
      budget: {
        stepsUsed: 1,
        stepsLimit: 16,
        writesUsed: 0,
        commandsUsed: 0,
      },
    };
    const blocked: ActionBlockedPayload = {
      taskId: 'task-1',
      approvalId: 'approval-1',
      approvalNonce: 'nonce-1',
      expiresAt: '2026-03-13T00:05:00.000Z',
      riskLevel: 'high',
      actionType: 'run_command',
      target: 'npm test',
      permissionScope: {
        workspace: '/workspace',
        maxActions: 1,
        timeoutSec: 300,
      },
    };
    const chunk: StreamChunkPayload = {
      taskId: 'task-1',
      chunk: 'partial output',
      isFinal: false,
    };
    const terminal: TaskTerminalPayload = {
      taskId: 'task-1',
      state: 'success',
      summary: 'Task completed',
    };

    expect(status.state).toBe('running');
    expect(blocked.actionType).toBe('run_command');
    expect(chunk.isFinal).toBe(false);
    expect(terminal.state).toBe('success');
  });
});
