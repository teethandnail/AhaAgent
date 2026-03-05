import { create } from 'zustand';
import type {
  WsEnvelope,
  StreamChunkPayload,
  TaskStatusChangePayload,
  ActionBlockedPayload,
  TaskTerminalPayload,
  ExecutionMode,
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

interface WebSocketState {
  socket: WebSocket | null;
  status: ConnectionStatus;
  messages: Message[];
  pendingApproval: PendingApproval | null;
  taskState: string;
  executionMode: ExecutionMode;
  sessionId: string;
  rawMessages: RawWsMessage[];
  connect: (url: string) => void;
  disconnect: () => void;
  sendMessage: (text: string) => void;
  setExecutionMode: (mode: ExecutionMode) => void;
  approve: (approvalId: string, nonce: string, decision: 'approve' | 'reject') => void;
  cancelTask: (taskId: string) => void;
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
          set({ taskState: p.state });
        } else if (type === 'task_terminal') {
          set({ taskState: 'idle', pendingApproval: null });
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
}));
