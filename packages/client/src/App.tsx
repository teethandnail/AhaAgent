import { useEffect, useRef, useState } from 'react';
import { useWebSocketStore } from '@/stores/websocket';
import { useTaskStore } from '@/stores/task';
import { ChatWindow } from '@/components/ChatWindow';
import { ApprovalDialog } from '@/components/ApprovalDialog';
import { DevConsole } from '@/components/DevConsole';
import { TaskPanel } from '@/components/TaskPanel';
import { MemoryPanel } from '@/components/MemoryPanel';
import type {
  WsEnvelope,
  TaskStatusChangePayload,
  TaskTerminalPayload,
  ExecutionMode,
} from '@aha-agent/shared';

export default function App() {
  const [devConsoleOpen, setDevConsoleOpen] = useState(false);
  const [taskPanelOpen, setTaskPanelOpen] = useState(false);
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false);
  const connect = useWebSocketStore((s) => s.connect);
  const executionMode = useWebSocketStore((s) => s.executionMode);
  const setExecutionMode = useWebSocketStore((s) => s.setExecutionMode);
  const rawMessages = useWebSocketStore((s) => s.rawMessages);
  const updateTask = useTaskStore((s) => s.updateTask);
  const completeTask = useTaskStore((s) => s.completeTask);
  const taskCount = useTaskStore((s) => s.tasks.size);
  const processedIndexRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const host = window.location.hostname;
    const wsPort = import.meta.env.VITE_WS_PORT ?? '3000';
    const httpProtocol = window.location.protocol === 'https:' ? 'https' : 'http';
    const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';

    (async () => {
      try {
        const res = await fetch(`${httpProtocol}://${host}:${wsPort}`);
        const body = (await res.json()) as { token?: string };
        const token = body.token;
        if (!res.ok || typeof token !== 'string' || token.length === 0) {
          throw new Error('Invalid gateway token response');
        }
        if (cancelled) return;
        const wsUrl = `${wsProtocol}://${host}:${wsPort}/ws?token=${encodeURIComponent(token)}`;
        connect(wsUrl);
      } catch {
        // Keep behavior predictable when gateway token endpoint is unreachable.
        if (cancelled) return;
        const fallbackWsUrl = `${wsProtocol}://${host}:${wsPort}/ws`;
        connect(fallbackWsUrl);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [connect]);

  // Forward task-related WS events to the task store, processing any new messages
  useEffect(() => {
    const startIndex = processedIndexRef.current;
    if (rawMessages.length <= startIndex) return;

    for (let i = startIndex; i < rawMessages.length; i++) {
      const msg = rawMessages[i];
      if (msg.direction !== 'in') continue;

      try {
        const envelope = JSON.parse(msg.data) as WsEnvelope<unknown>;

        if (envelope.type === 'task_status_change') {
          updateTask(envelope.payload as TaskStatusChangePayload);
        } else if (envelope.type === 'task_terminal') {
          completeTask(envelope.payload as TaskTerminalPayload);
        }
      } catch {
        /* ignore parse errors */
      }
    }

    processedIndexRef.current = rawMessages.length;
  }, [rawMessages, updateTask, completeTask]);

  return (
    <div className="h-screen flex flex-col" style={{ backgroundColor: 'var(--background)' }}>
      {/* Header */}
      <header
        className="flex items-center justify-between px-4 py-3 border-b"
        style={{ borderColor: 'var(--border)' }}
      >
        <h1 className="text-lg font-semibold">AhaAgent</h1>
        <div className="flex items-center gap-2">
          <select
            value={executionMode}
            onChange={(e) => setExecutionMode(e.target.value as ExecutionMode)}
            className="text-sm rounded-md border px-2 py-1.5"
            style={{ borderColor: 'var(--border)', backgroundColor: 'var(--background)' }}
          >
            <option value="interactive">Interactive</option>
            <option value="autonomous">Autonomous</option>
          </select>
          <button
            onClick={() => setTaskPanelOpen((o) => !o)}
            className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border transition-colors hover:opacity-80"
            style={{
              borderColor: 'var(--border)',
              color: 'var(--foreground)',
            }}
          >
            <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
              <path d="M2 3.5A1.5 1.5 0 013.5 2h9A1.5 1.5 0 0114 3.5v9a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5v-9zM3.5 3a.5.5 0 00-.5.5v9a.5.5 0 00.5.5h9a.5.5 0 00.5-.5v-9a.5.5 0 00-.5-.5h-9z" />
              <path d="M7 5.5a.5.5 0 01.5-.5h4a.5.5 0 010 1h-4a.5.5 0 01-.5-.5zM7 8a.5.5 0 01.5-.5h4a.5.5 0 010 1h-4A.5.5 0 017 8zm0 2.5a.5.5 0 01.5-.5h4a.5.5 0 010 1h-4a.5.5 0 01-.5-.5zM4.5 5h1v1h-1V5zm0 2.5h1v1h-1v-1zm0 2.5h1v1h-1v-1z" />
            </svg>
            Tasks
            {taskCount > 0 && (
              <span
                className="text-xs font-medium px-1.5 py-0.5 rounded-full"
                style={{
                  backgroundColor: 'var(--muted)',
                  color: 'var(--muted-foreground)',
                }}
              >
                {taskCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setMemoryPanelOpen((o) => !o)}
            className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border transition-colors hover:opacity-80"
            style={{
              borderColor: 'var(--border)',
              color: 'var(--foreground)',
            }}
          >
            <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3 2.5A1.5 1.5 0 014.5 1h7A1.5 1.5 0 0113 2.5v11a.5.5 0 01-.8.4L8 10.75 3.8 13.9a.5.5 0 01-.8-.4v-11zM4.5 2a.5.5 0 00-.5.5v10l3.7-2.775a.5.5 0 01.6 0L12 12.5v-10a.5.5 0 00-.5-.5h-7z" />
            </svg>
            Memory
          </button>
        </div>
      </header>

      {/* Main content with optional task panel */}
      <div className="flex-1 flex overflow-hidden">
        <main className="flex-1 overflow-hidden">
          <ChatWindow />
        </main>
        <MemoryPanel open={memoryPanelOpen} onClose={() => setMemoryPanelOpen(false)} />
        <TaskPanel open={taskPanelOpen} onClose={() => setTaskPanelOpen(false)} />
      </div>

      {/* Overlays */}
      <ApprovalDialog />
      <DevConsole open={devConsoleOpen} onToggle={() => setDevConsoleOpen((o) => !o)} />
    </div>
  );
}
