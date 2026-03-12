// WebSocket message envelope
export interface WsEnvelope<T> {
  protocolVersion: '1.0';
  sessionId: string;
  requestId: string;
  idempotencyKey: string;
  timestamp: string;
  type: string;
  payload: T;
}

// Client -> Server events
export interface SendMessagePayload {
  conversationId: string;
  taskId?: string;
  text: string;
  model?: string;
  contextRefs?: string[];
  execution?: {
    mode?: ExecutionMode;
    budget?: {
      maxSteps?: number;
      maxWrites?: number;
      maxCommands?: number;
    };
  };
}

export interface ApproveActionPayload {
  taskId: string;
  approvalId: string;
  approvalNonce: string;
  decision: 'approve' | 'reject';
  scope?: {
    workspace: string;
    maxActions: number;
    timeoutSec: number;
  };
}

export interface CancelTaskPayload {
  taskId: string;
  reason?: string;
}

export interface ListMemoriesPayload {
  query?: string;
  category?: 'preference' | 'fact' | 'skill' | 'context';
  sensitivity?: 'public' | 'restricted' | 'secret';
  limit?: number;
}

export interface DeleteMemoryPayload {
  id: string;
}

// Server -> Client events
export interface StreamChunkPayload {
  taskId: string;
  chunk: string;
  isFinal: boolean;
}

export interface TaskStatusChangePayload {
  taskId: string;
  state: TaskState;
  desc: string;
  stepId?: string;
  progress?: { current: number; total: number };
  mode?: ExecutionMode;
  budget?: {
    stepsUsed: number;
    stepsLimit: number;
    writesUsed: number;
    writesLimit?: number;
    commandsUsed: number;
    commandsLimit?: number;
  };
}

export interface ActionBlockedPayload {
  taskId: string;
  approvalId: string;
  approvalNonce: string;
  expiresAt: string;
  riskLevel: RiskLevel;
  actionType: ApprovalActionType;
  target: string;
  diffPreview?: string;
  permissionScope: PermissionScope;
}

export interface TaskTerminalPayload {
  taskId: string;
  state: 'success' | 'failed' | 'cancelled';
  summary: string;
  errorCode?: string;
}

export interface ErrorPayload {
  requestId: string;
  errorCode: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface MemoryListItemPayload {
  id: string;
  content: string;
  category: 'preference' | 'fact' | 'skill' | 'context';
  sensitivity: 'public' | 'restricted' | 'secret';
  accessCount: number;
  lastAccessedAt: string;
  createdAt: string;
  score?: number;
}

export interface MemoryListPayload {
  items: MemoryListItemPayload[];
}

export interface MemoryDeletedPayload {
  id: string;
  deleted: boolean;
}

// Shared enums/types
export type TaskState =
  | 'pending'
  | 'running'
  | 'blocked'
  | 'success'
  | 'failed'
  | 'cancelled';
export type ExecutionMode = 'interactive' | 'autonomous';
export type RiskLevel = 'medium' | 'high' | 'critical';
export type ApprovalActionType =
  | 'write_file'
  | 'delete_file'
  | 'run_command'
  | 'install_extension';

export interface PermissionScope {
  workspace: string;
  maxActions: number;
  timeoutSec: number;
}

// Event type string constants
export const ClientEvents = {
  SEND_MESSAGE: 'send_message',
  APPROVE_ACTION: 'approve_action',
  CANCEL_TASK: 'cancel_task',
  LIST_MEMORIES: 'list_memories',
  DELETE_MEMORY: 'delete_memory',
} as const;

export const ServerEvents = {
  STREAM_CHUNK: 'stream_chunk',
  TASK_STATUS_CHANGE: 'task_status_change',
  ACTION_BLOCKED: 'action_blocked',
  TASK_TERMINAL: 'task_terminal',
  MEMORY_LIST: 'memory_list',
  MEMORY_DELETED: 'memory_deleted',
  ERROR: 'error',
} as const;
