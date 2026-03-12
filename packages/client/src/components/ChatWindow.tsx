import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useWebSocketStore } from '@/stores/websocket';
import { cn } from '@/lib/utils';

const statusConfig: Record<string, { color: string; label: string }> = {
  connected: { color: 'bg-green-500', label: 'Connected' },
  connecting: { color: 'bg-yellow-500', label: 'Connecting...' },
  disconnected: { color: 'bg-gray-400', label: 'Disconnected' },
  error: { color: 'bg-red-500', label: 'Error' },
};

const stageLabel: Record<string, string> = {
  created: 'Preparing',
  thinking: 'Thinking',
  memory: 'Memory',
  tool: 'Tool',
  waiting_approval: 'Waiting for approval',
  responding: 'Responding',
  completed: 'Completed',
  failed: 'Stopped',
};

function formatElapsed(startedAt?: string): string | null {
  if (!startedAt) return null;
  const deltaMs = Date.now() - new Date(startedAt).getTime();
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return null;
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remain = seconds % 60;
  return `${minutes}m ${remain}s`;
}

export function ChatWindow() {
  const [input, setInput] = useState('');
  const [, setNow] = useState(() => Date.now());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { messages, status, sendMessage, executionMode, activeTaskId, taskProgress, recentTaskEvents } =
    useWebSocketStore();
  const statusInfo = statusConfig[status] ?? statusConfig['disconnected'];
  const activeProgress = activeTaskId ? taskProgress[activeTaskId] : null;
  const visibleRecentEvents =
    activeTaskId
      ? recentTaskEvents.filter((event) => event.taskId === activeTaskId).slice(-3).reverse()
      : [];
  const elapsed = formatElapsed(activeProgress?.startedAt);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (!activeProgress?.startedAt) {
      return;
    }
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [activeProgress?.startedAt]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    sendMessage(trimmed);
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Connection status bar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b" style={{ borderColor: 'var(--border)' }}>
        <span className={cn('w-2 h-2 rounded-full', statusInfo.color)} />
        <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
          {statusInfo.label}
        </span>
        <span
          className="text-xs px-2 py-0.5 rounded-full border"
          style={{ borderColor: 'var(--border)', color: 'var(--muted-foreground)' }}
        >
          Mode: {executionMode}
        </span>
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {activeProgress && (
          <div
            className="rounded-lg border px-4 py-3"
            style={{ borderColor: 'var(--border)', backgroundColor: 'var(--muted)' }}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <span className="inline-flex h-2.5 w-2.5 rounded-full bg-[var(--primary)] animate-pulse" />
                <span className="text-sm font-medium">{stageLabel[activeProgress.stage] ?? 'Working'}</span>
                {activeProgress.step && activeProgress.totalSteps ? (
                  <span
                    className="text-xs px-2 py-0.5 rounded-full border"
                    style={{ borderColor: 'var(--border)', color: 'var(--muted-foreground)' }}
                  >
                    Step {activeProgress.step}/{activeProgress.totalSteps}
                  </span>
                ) : null}
              </div>
              {elapsed ? (
                <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                  {elapsed}
                </span>
              ) : null}
            </div>
            <p className="mt-2 text-sm">{activeProgress.message}</p>
            {activeProgress.detail ? (
              <p className="mt-1 text-xs" style={{ color: 'var(--muted-foreground)' }}>
                {activeProgress.detail}
              </p>
            ) : null}
            {visibleRecentEvents.length > 1 ? (
              <div className="mt-3 space-y-1">
                {visibleRecentEvents.slice(1).map((event, index) => (
                  <div
                    key={`${event.timestamp}-${index}`}
                    className="text-xs"
                    style={{ color: 'var(--muted-foreground)' }}
                  >
                    {event.message}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        )}
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm" style={{ color: 'var(--muted-foreground)' }}>
              Send a message to get started.
            </p>
          </div>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={cn(
              'flex',
              msg.role === 'user' ? 'justify-end' : 'justify-start',
            )}
          >
            <div
              className={cn(
                'max-w-[75%] rounded-lg px-4 py-2 text-sm',
                msg.role === 'user'
                  ? 'text-white whitespace-pre-wrap'
                  : 'prose prose-sm dark:prose-invert max-w-none',
              )}
              style={{
                backgroundColor: msg.role === 'user' ? 'var(--primary)' : 'var(--muted)',
                color: msg.role === 'user' ? 'var(--primary-foreground)' : 'var(--foreground)',
              }}
            >
              {msg.role === 'user' ? (
                msg.content
              ) : (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
              )}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="border-t p-4" style={{ borderColor: 'var(--border)' }}>
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            disabled={status !== 'connected'}
            className={cn(
              'flex-1 rounded-md border px-3 py-2 text-sm outline-none',
              'focus:ring-2 focus:ring-offset-1',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            )}
            style={{
              borderColor: 'var(--border)',
              backgroundColor: 'var(--background)',
              color: 'var(--foreground)',
            }}
          />
          <button
            onClick={handleSend}
            disabled={status !== 'connected' || !input.trim()}
            className={cn(
              'rounded-md px-4 py-2 text-sm font-medium',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              'transition-colors',
            )}
            style={{
              backgroundColor: 'var(--primary)',
              color: 'var(--primary-foreground)',
            }}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
