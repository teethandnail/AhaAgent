import { useTaskStore } from '@/stores/task';
import { TaskTree } from '@/components/TaskTree';

interface TaskPanelProps {
  open: boolean;
  onClose: () => void;
}

export function TaskPanel({ open, onClose }: TaskPanelProps) {
  const { getRootTasks, clearCompleted, tasks } = useTaskStore();
  const rootTasks = getRootTasks();
  const taskCount = tasks.size;
  const hasCompletedTasks = Array.from(tasks.values()).some(
    (t) => t.status === 'success' || t.status === 'failed' || t.status === 'cancelled',
  );

  if (!open) return null;

  return (
    <div
      className="flex flex-col border-l h-full"
      style={{
        width: 320,
        backgroundColor: 'var(--background)',
        borderColor: 'var(--border)',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 border-b shrink-0"
        style={{ borderColor: 'var(--border)' }}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
            Tasks
          </span>
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
        </div>
        <button
          onClick={onClose}
          className="text-sm hover:opacity-70 transition-opacity"
          style={{ color: 'var(--muted-foreground)' }}
          title="Close task panel"
        >
          <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4.646 4.646a.5.5 0 01.708 0L8 7.293l2.646-2.647a.5.5 0 01.708.708L8.707 8l2.647 2.646a.5.5 0 01-.708.708L8 8.707l-2.646 2.647a.5.5 0 01-.708-.708L7.293 8 4.646 5.354a.5.5 0 010-.708z" />
          </svg>
        </button>
      </div>

      {/* Task list */}
      <div className="flex-1 overflow-y-auto p-2">
        {rootTasks.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm" style={{ color: 'var(--muted-foreground)' }}>
              No active tasks
            </p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {rootTasks.map((task) => (
              <TaskTree key={task.id} task={task} />
            ))}
          </div>
        )}
      </div>

      {/* Footer -- clear completed button */}
      {hasCompletedTasks && (
        <div
          className="shrink-0 px-4 py-3 border-t"
          style={{ borderColor: 'var(--border)' }}
        >
          <button
            onClick={clearCompleted}
            className="w-full text-xs py-1.5 rounded-md border transition-colors hover:opacity-80"
            style={{
              borderColor: 'var(--border)',
              color: 'var(--muted-foreground)',
            }}
          >
            Clear completed tasks
          </button>
        </div>
      )}
    </div>
  );
}
