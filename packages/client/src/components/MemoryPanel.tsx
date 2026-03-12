import { useEffect, useState } from 'react';
import { useWebSocketStore } from '@/stores/websocket';
import { cn } from '@/lib/utils';

interface MemoryPanelProps {
  open: boolean;
  onClose: () => void;
}

const categoryLabels: Record<string, string> = {
  preference: 'Preference',
  fact: 'Fact',
  skill: 'Skill',
  context: 'Context',
};

const sensitivityClasses: Record<string, string> = {
  public: 'bg-emerald-100 text-emerald-800',
  restricted: 'bg-amber-100 text-amber-800',
  secret: 'bg-rose-100 text-rose-800',
};

export function MemoryPanel({ open, onClose }: MemoryPanelProps) {
  const memories = useWebSocketStore((s) => s.memories);
  const memoryLoading = useWebSocketStore((s) => s.memoryLoading);
  const listMemories = useWebSocketStore((s) => s.listMemories);
  const deleteMemory = useWebSocketStore((s) => s.deleteMemory);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<'' | 'preference' | 'fact' | 'skill' | 'context'>('');
  const [sensitivity, setSensitivity] = useState<'' | 'public' | 'restricted' | 'secret'>('');

  useEffect(() => {
    if (!open) return;
    listMemories({
      query: query.trim() || undefined,
      category: category || undefined,
      sensitivity: sensitivity || undefined,
      limit: 50,
    });
  }, [open, query, category, sensitivity, listMemories]);

  if (!open) return null;

  return (
    <div
      className="flex flex-col border-l h-full"
      style={{
        width: 380,
        backgroundColor: 'var(--background)',
        borderColor: 'var(--border)',
      }}
    >
      <div
        className="flex items-center justify-between px-4 py-3 border-b shrink-0"
        style={{ borderColor: 'var(--border)' }}
      >
        <div>
          <div className="text-sm font-semibold">Memory</div>
          <div className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
            Search, inspect, and delete stored memories
          </div>
        </div>
        <button
          onClick={onClose}
          className="text-sm hover:opacity-70 transition-opacity"
          style={{ color: 'var(--muted-foreground)' }}
          title="Close memory panel"
        >
          Close
        </button>
      </div>

      <div className="shrink-0 p-4 border-b space-y-3" style={{ borderColor: 'var(--border)' }}>
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search memories..."
          className="w-full rounded-md border px-3 py-2 text-sm outline-none"
          style={{
            borderColor: 'var(--border)',
            backgroundColor: 'var(--background)',
            color: 'var(--foreground)',
          }}
        />
        <div className="grid grid-cols-2 gap-2">
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value as typeof category)}
            className="rounded-md border px-2 py-2 text-sm"
            style={{ borderColor: 'var(--border)', backgroundColor: 'var(--background)' }}
          >
            <option value="">All categories</option>
            <option value="preference">Preference</option>
            <option value="fact">Fact</option>
            <option value="skill">Skill</option>
            <option value="context">Context</option>
          </select>
          <select
            value={sensitivity}
            onChange={(event) => setSensitivity(event.target.value as typeof sensitivity)}
            className="rounded-md border px-2 py-2 text-sm"
            style={{ borderColor: 'var(--border)', backgroundColor: 'var(--background)' }}
          >
            <option value="">All sensitivities</option>
            <option value="public">Public</option>
            <option value="restricted">Restricted</option>
            <option value="secret">Secret</option>
          </select>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {memoryLoading && (
          <div className="text-sm" style={{ color: 'var(--muted-foreground)' }}>
            Loading memories...
          </div>
        )}
        {!memoryLoading && memories.length === 0 && (
          <div className="text-sm" style={{ color: 'var(--muted-foreground)' }}>
            No memories found.
          </div>
        )}
        {memories.map((memory) => (
          <div
            key={memory.id}
            className="rounded-lg border p-3 space-y-3"
            style={{ borderColor: 'var(--border)', backgroundColor: 'var(--muted)' }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                <span
                  className="text-[11px] font-medium px-2 py-0.5 rounded-full"
                  style={{ backgroundColor: 'var(--background)', color: 'var(--foreground)' }}
                >
                  {categoryLabels[memory.category] ?? memory.category}
                </span>
                <span className={cn('text-[11px] font-medium px-2 py-0.5 rounded-full', sensitivityClasses[memory.sensitivity] ?? sensitivityClasses.public)}>
                  {memory.sensitivity}
                </span>
                {typeof memory.score === 'number' && (
                  <span
                    className="text-[11px] font-medium px-2 py-0.5 rounded-full"
                    style={{ backgroundColor: 'var(--background)', color: 'var(--muted-foreground)' }}
                  >
                    score {memory.score.toFixed(2)}
                  </span>
                )}
              </div>
              <button
                onClick={() => deleteMemory(memory.id)}
                className="text-xs px-2 py-1 rounded-md border hover:opacity-80"
                style={{ borderColor: 'var(--border)', color: 'var(--destructive)' }}
              >
                Delete
              </button>
            </div>
            <p className="text-sm whitespace-pre-wrap" style={{ color: 'var(--foreground)' }}>
              {memory.sensitivity === 'secret' ? '[Secret memory hidden]' : memory.content}
            </p>
            <div className="text-[11px] flex justify-between" style={{ color: 'var(--muted-foreground)' }}>
              <span>Created {new Date(memory.createdAt).toLocaleString()}</span>
              <span>Accessed {memory.accessCount} times</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
