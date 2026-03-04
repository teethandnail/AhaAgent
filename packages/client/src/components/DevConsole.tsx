import { useRef, useEffect } from 'react';
import { useWebSocketStore } from '@/stores/websocket';
import { cn } from '@/lib/utils';

interface DevConsoleProps {
  open: boolean;
  onToggle: () => void;
}

export function DevConsole({ open, onToggle }: DevConsoleProps) {
  const { rawMessages } = useWebSocketStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [rawMessages, open]);

  return (
    <>
      {/* Toggle button */}
      <button
        onClick={onToggle}
        className={cn(
          'fixed bottom-4 right-4 z-40 rounded-full w-10 h-10',
          'flex items-center justify-center text-sm font-mono',
          'shadow-lg transition-colors hover:opacity-90',
        )}
        style={{
          backgroundColor: 'var(--primary)',
          color: 'var(--primary-foreground)',
        }}
        title="Toggle Dev Console"
      >
        {'</>'}
      </button>

      {/* Slide-out panel */}
      {open && (
        <div
          className="fixed bottom-0 left-0 right-0 z-30 border-t shadow-2xl"
          style={{
            height: '40vh',
            backgroundColor: 'var(--background)',
            borderColor: 'var(--border)',
          }}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between px-4 py-2 border-b"
            style={{ borderColor: 'var(--border)' }}
          >
            <span className="text-sm font-semibold">Dev Console</span>
            <div className="flex items-center gap-2">
              <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                {rawMessages.length} messages
              </span>
              <button
                onClick={onToggle}
                className="text-sm hover:opacity-70 transition-opacity"
                style={{ color: 'var(--muted-foreground)' }}
              >
                Close
              </button>
            </div>
          </div>

          {/* Message log */}
          <div ref={scrollRef} className="overflow-y-auto p-4 space-y-2" style={{ height: 'calc(40vh - 44px)' }}>
            {rawMessages.length === 0 && (
              <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                No WebSocket messages yet.
              </p>
            )}
            {rawMessages.map((msg, i) => (
              <div key={i} className="text-xs font-mono">
                <span
                  className={cn(
                    'inline-block w-8 text-center mr-2 rounded px-1',
                    msg.direction === 'in'
                      ? 'bg-blue-100 text-blue-700'
                      : 'bg-green-100 text-green-700',
                  )}
                >
                  {msg.direction === 'in' ? 'IN' : 'OUT'}
                </span>
                <span className="opacity-50 mr-2">
                  {new Date(msg.timestamp).toLocaleTimeString()}
                </span>
                <span className="break-all">{msg.data}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
