import type { TaskNode, TaskState } from '@aha-agent/shared';
import { useTaskStore } from '@/stores/task';
import { cn } from '@/lib/utils';

interface TaskTreeProps {
  task: TaskNode;
  depth?: number;
}

const statusConfig: Record<TaskState, { icon: React.ReactNode; color: string }> = {
  pending: {
    icon: (
      <span
        className="inline-block w-3 h-3 rounded-full border-2"
        style={{ borderColor: 'var(--muted-foreground)' }}
      />
    ),
    color: 'var(--muted-foreground)',
  },
  running: {
    icon: (
      <span
        className="inline-block w-3 h-3 rounded-full border-2 border-t-transparent animate-spin"
        style={{ borderColor: '#3b82f6', borderTopColor: 'transparent' }}
      />
    ),
    color: '#3b82f6',
  },
  blocked: {
    icon: (
      <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none">
        <path
          d="M8 1.5l6.5 11.25H1.5L8 1.5z"
          fill="#eab308"
          stroke="#eab308"
          strokeWidth="0.5"
        />
        <path d="M8 6v3" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="8" cy="11" r="0.75" fill="white" />
      </svg>
    ),
    color: '#eab308',
  },
  success: {
    icon: (
      <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="7" fill="#22c55e" />
        <path d="M5 8l2 2 4-4" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    color: '#22c55e',
  },
  failed: {
    icon: (
      <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="7" fill="#ef4444" />
        <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
    color: '#ef4444',
  },
  cancelled: {
    icon: (
      <span
        className="inline-block w-3 h-3 rounded-full"
        style={{ backgroundColor: 'var(--muted-foreground)', opacity: 0.5 }}
      />
    ),
    color: 'var(--muted-foreground)',
  },
};

export function TaskTree({ task, depth = 0 }: TaskTreeProps) {
  const { expandedTasks, toggleExpand, cancelTask, getChildTasks } = useTaskStore();
  const children = getChildTasks(task.id);
  const hasChildren = children.length > 0;
  const isExpanded = expandedTasks.has(task.id);
  const config = statusConfig[task.status];
  const isCancellable = task.status === 'running' || task.status === 'blocked';
  const isCancelled = task.status === 'cancelled';

  return (
    <div style={{ paddingLeft: depth > 0 ? 16 : 0 }}>
      {/* Task node row */}
      <div
        className={cn(
          'group flex items-center gap-2 px-2 py-1.5 rounded-md transition-colors',
          'hover:bg-black/5',
        )}
      >
        {/* Expand/collapse toggle */}
        {hasChildren ? (
          <button
            onClick={() => toggleExpand(task.id)}
            className="flex items-center justify-center w-4 h-4 text-xs shrink-0 hover:opacity-70 transition-opacity"
            style={{ color: 'var(--muted-foreground)' }}
          >
            <svg
              className={cn('w-3 h-3 transition-transform', isExpanded && 'rotate-90')}
              viewBox="0 0 12 12"
              fill="currentColor"
            >
              <path d="M4 2l5 4-5 4V2z" />
            </svg>
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}

        {/* Status icon */}
        <span className="shrink-0 flex items-center justify-center w-4 h-4">
          {config.icon}
        </span>

        {/* Task title */}
        <span
          className={cn(
            'text-sm truncate flex-1',
            isCancelled && 'line-through opacity-50',
          )}
          style={{ color: 'var(--foreground)' }}
          title={task.title}
        >
          {task.title}
        </span>

        {/* Cancel button -- visible on hover for running/blocked tasks */}
        {isCancellable && (
          <button
            onClick={() => cancelTask(task.id)}
            className={cn(
              'opacity-0 group-hover:opacity-100 transition-opacity',
              'shrink-0 text-xs px-1.5 py-0.5 rounded border',
              'hover:opacity-80',
            )}
            style={{
              borderColor: 'var(--border)',
              color: 'var(--muted-foreground)',
            }}
            title="Cancel task"
          >
            Cancel
          </button>
        )}
      </div>

      {/* Error message for failed tasks */}
      {task.status === 'failed' && task.errorMessage && (
        <div
          className="ml-10 px-2 py-1 text-xs rounded"
          style={{
            color: '#ef4444',
            backgroundColor: 'rgba(239, 68, 68, 0.08)',
          }}
        >
          {task.errorMessage}
        </div>
      )}

      {/* Children (recursive) */}
      {hasChildren && isExpanded && (
        <div>
          {children.map((child) => (
            <TaskTree key={child.id} task={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
