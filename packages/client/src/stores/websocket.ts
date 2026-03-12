import { create } from 'zustand';
import type {
  WsEnvelope,
  StreamChunkPayload,
  TaskStatusChangePayload,
  TaskProgressPayload,
  ActionBlockedPayload,
  TaskTerminalPayload,
  ExecutionMode,
  MemoryListPayload,
  MemoryDeletedPayload,
  MemoryUpdatedPayload,
} from '@aha-agent/shared';

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface PendingApproval {
  taskId: string;
  approvalId: string;
  approvalNonce: string;
  actionType: string;
  target: string;
  riskLevel: string;
  diffPreview?: string;
  expiresAt: string;
}

export interface RawWsMessage {
  direction: 'in' | 'out';
  data: string;
  timestamp: number;
}

export interface MemoryItem {
  id: string;
  content: string;
  category: 'preference' | 'fact' | 'skill' | 'context';
  sensitivity: 'public' | 'restricted' | 'secret';
  accessCount: number;
  lastAccessedAt: string;
  createdAt: string;
  score?: number;
}

export interface TaskProgressEvent {
  taskId: string;
  stage: TaskProgressPayload['stage'];
  message: string;
  detail?: string;
  step?: number;
  totalSteps?: number;
  toolName?: string;
  startedAt?: string;
  timestamp: string;
}

interface WebSocketState {
  socket: WebSocket | null;
  status: ConnectionStatus;
  messages: Message[];
  pendingApproval: PendingApproval | null;
  taskState: string;
  executionMode: ExecutionMode;
  sessionId: string;
  rawMessages: RawWsMessage[];
  activeTaskId: string | null;
  taskProgress: Record<string, TaskProgressEvent>;
  recentTaskEvents: TaskProgressEvent[];
  memories: MemoryItem[];
  memoryLoading: boolean;
  connect: (url: string) => void;
  disconnect: () => void;
  sendMessage: (text: string) => void;
  setExecutionMode: (mode: ExecutionMode) => void;
  approve: (approvalId: string, nonce: string, decision: 'approve' | 'reject') => void;
  cancelTask: (taskId: string) => void;
  listMemories: (filters?: {
    query?: string;
    category?: MemoryItem['category'];
    sensitivity?: MemoryItem['sensitivity'];
    limit?: number;
  }) => void;
  deleteMemory: (id: string) => void;
  updateMemory: (input: {
    id: string;
    content: string;
    category: MemoryItem['category'];
    sensitivity: MemoryItem['sensitivity'];
  }) => void;
}

export const useWebSocketStore = create<WebSocketState>((set, get) => ({
  socket: null,
  status: 'disconnected',
  messages: [],
  pendingApproval: null,
  taskState: 'idle',
  executionMode: 'interactive',
  sessionId: crypto.randomUUID(),
  rawMessages: [],
  activeTaskId: null,
  taskProgress: {},
  recentTaskEvents: [],
  memories: [],
  memoryLoading: false,

  connect: (url: string) => {
    set({ status: 'connecting' });
    const ws = new WebSocket(url);

    ws.onopen = () => set({ status: 'connected' });

    ws.onmessage = (event: MessageEvent) => {
      const raw = String(event.data);
      set((state) => ({
        rawMessages: [
          ...state.rawMessages,
          { direction: 'in' as const, data: raw, timestamp: Date.now() },
        ],
      }));

      try {
        const envelope = JSON.parse(raw) as WsEnvelope<unknown>;
        const { type, payload } = envelope;

        if (type === 'stream_chunk') {
          const p = payload as StreamChunkPayload;
          set((state) => {
            const last = state.messages[state.messages.length - 1];
            if (last && last.role === 'assistant' && !p.isFinal) {
              const updated = [...state.messages];
              updated[updated.length - 1] = { ...last, content: last.content + p.chunk };
              return { messages: updated };
            }
            return {
              messages: [
                ...state.messages,
                {
                  id: crypto.randomUUID(),
                  role: 'assistant' as const,
                  content: p.chunk,
                  timestamp: Date.now(),
                },
              ],
            };
          });
        } else if (type === 'action_blocked') {
          const p = payload as ActionBlockedPayload;
          set({
            pendingApproval: {
              taskId: p.taskId,
              approvalId: p.approvalId,
              approvalNonce: p.approvalNonce,
              actionType: p.actionType,
              target: p.target,
              riskLevel: p.riskLevel,
              diffPreview: p.diffPreview,
              expiresAt: p.expiresAt,
            },
            taskState: 'blocked',
          });
        } else if (type === 'task_status_change') {
          const p = payload as TaskStatusChangePayload;
          set((state) => {
            const previous = state.taskProgress[p.taskId];
            const progressEvent: TaskProgressEvent = {
              taskId: p.taskId,
              stage:
                p.state === 'blocked' ? 'waiting_approval'
                : p.state === 'failed' ? 'failed'
                : p.state === 'success' ? 'completed'
                : 'thinking',
              message: p.desc,
              step: p.budget?.stepsUsed,
              totalSteps: p.budget?.stepsLimit,
              startedAt: previous?.startedAt,
              timestamp: new Date().toISOString(),
            };
            return {
              taskState: p.state,
              activeTaskId: p.taskId,
              taskProgress: {
                ...state.taskProgress,
                [p.taskId]: progressEvent,
              },
              recentTaskEvents: [...state.recentTaskEvents, progressEvent].slice(-8),
            };
          });
        } else if (type === 'task_progress') {
          const p = payload as TaskProgressPayload;
          const progressEvent: TaskProgressEvent = {
            taskId: p.taskId,
            stage: p.stage,
            message: p.message,
            detail: p.detail,
            step: p.step,
            totalSteps: p.totalSteps,
            toolName: p.toolName,
            startedAt: p.startedAt,
            timestamp: p.timestamp,
          };
          set((state) => ({
            activeTaskId: p.taskId,
            taskProgress: {
              ...state.taskProgress,
              [p.taskId]: progressEvent,
            },
            recentTaskEvents: [...state.recentTaskEvents, progressEvent].slice(-8),
          }));
        } else if (type === 'task_terminal') {
          const p = payload as TaskTerminalPayload;
          set((state) => {
            const existing = state.taskProgress[p.taskId];
            const finalProgress: TaskProgressEvent = {
              taskId: p.taskId,
              stage:
                p.state === 'success' ? 'completed'
                : p.state === 'cancelled' ? 'failed'
                : 'failed',
              message: p.summary,
              step: existing?.step,
              totalSteps: existing?.totalSteps,
              toolName: existing?.toolName,
              startedAt: existing?.startedAt,
              timestamp: new Date().toISOString(),
            };
            return {
              taskState: 'idle',
              pendingApproval: null,
              activeTaskId: p.taskId,
              taskProgress: {
                ...state.taskProgress,
                [p.taskId]: finalProgress,
              },
              recentTaskEvents: [...state.recentTaskEvents, finalProgress].slice(-8),
            };
          });
        } else if (type === 'memory_list') {
          const p = payload as MemoryListPayload;
          set({ memories: p.items as MemoryItem[], memoryLoading: false });
        } else if (type === 'memory_deleted') {
          const p = payload as MemoryDeletedPayload;
          if (p.deleted) {
            set((state) => ({
              memories: state.memories.filter((memory) => memory.id !== p.id),
            }));
          }
        } else if (type === 'memory_updated') {
          const p = payload as MemoryUpdatedPayload;
          set((state) => ({
            memories: state.memories.map((memory) =>
              memory.id === p.item.id ? { ...memory, ...p.item } : memory,
            ),
          }));
        }
      } catch {
        /* ignore parse errors */
      }
    };

    ws.onerror = () => set({ status: 'error' });
    ws.onclose = () => set({ status: 'disconnected', socket: null });
    set({ socket: ws });
  },

  disconnect: () => {
    get().socket?.close();
    set({ socket: null, status: 'disconnected' });
  },

  sendMessage: (text: string) => {
    const { socket } = get();
    if (!socket) return;
    const msg: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };
    set((state) => ({ messages: [...state.messages, msg] }));
    set({ activeTaskId: null });
    const envelope = JSON.stringify({
      protocolVersion: '1.0',
      sessionId: get().sessionId,
      requestId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      type: 'send_message',
      payload: {
        conversationId: 'main',
        text,
        execution: {
          mode: get().executionMode,
        },
      },
    });
    set((state) => ({
      rawMessages: [
        ...state.rawMessages,
        { direction: 'out' as const, data: envelope, timestamp: Date.now() },
      ],
    }));
    socket.send(envelope);
  },

  setExecutionMode: (mode: ExecutionMode) => {
    set({ executionMode: mode });
  },

  approve: (approvalId: string, nonce: string, decision: 'approve' | 'reject') => {
    const { socket } = get();
    if (!socket) return;
    const envelope = JSON.stringify({
      protocolVersion: '1.0',
      sessionId: get().sessionId,
      requestId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      type: 'approve_action',
      payload: { taskId: get().pendingApproval?.taskId ?? '', approvalId, approvalNonce: nonce, decision },
    });
    set((state) => ({
      rawMessages: [
        ...state.rawMessages,
        { direction: 'out' as const, data: envelope, timestamp: Date.now() },
      ],
    }));
    socket.send(envelope);
    set({ pendingApproval: null });
  },

  cancelTask: (taskId: string) => {
    const { socket } = get();
    if (!socket) return;
    const envelope = JSON.stringify({
      protocolVersion: '1.0',
      sessionId: get().sessionId,
      requestId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      type: 'cancel_task',
      payload: { taskId },
    });
    set((state) => ({
      rawMessages: [
        ...state.rawMessages,
        { direction: 'out' as const, data: envelope, timestamp: Date.now() },
      ],
    }));
    socket.send(envelope);
  },

  listMemories: (filters) => {
    const { socket } = get();
    if (!socket) return;
    const envelope = JSON.stringify({
      protocolVersion: '1.0',
      sessionId: get().sessionId,
      requestId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      type: 'list_memories',
      payload: {
        query: filters?.query,
        category: filters?.category,
        sensitivity: filters?.sensitivity,
        limit: filters?.limit,
      },
    });
    set((state) => ({
      memoryLoading: true,
      rawMessages: [
        ...state.rawMessages,
        { direction: 'out' as const, data: envelope, timestamp: Date.now() },
      ],
    }));
    socket.send(envelope);
  },

  deleteMemory: (id: string) => {
    const { socket } = get();
    if (!socket) return;
    const envelope = JSON.stringify({
      protocolVersion: '1.0',
      sessionId: get().sessionId,
      requestId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      type: 'delete_memory',
      payload: { id },
    });
    set((state) => ({
      rawMessages: [
        ...state.rawMessages,
        { direction: 'out' as const, data: envelope, timestamp: Date.now() },
      ],
    }));
    socket.send(envelope);
  },

  updateMemory: (input) => {
    const { socket } = get();
    if (!socket) return;
    const envelope = JSON.stringify({
      protocolVersion: '1.0',
      sessionId: get().sessionId,
      requestId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      type: 'update_memory',
      payload: input,
    });
    set((state) => ({
      rawMessages: [
        ...state.rawMessages,
        { direction: 'out' as const, data: envelope, timestamp: Date.now() },
      ],
    }));
    socket.send(envelope);
  },
}));
