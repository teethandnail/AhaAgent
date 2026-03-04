import { create } from 'zustand';
import type {
  TaskStatusChangePayload,
  TaskTerminalPayload,
  TaskState,
} from '@aha-agent/shared';
import type { TaskNode } from '@aha-agent/shared';
import { useWebSocketStore } from '@/stores/websocket';

interface TaskStore {
  tasks: Map<string, TaskNode>;
  expandedTasks: Set<string>;
  /** Tracks insertion order so getRootTasks can return stable ordering. */
  insertionOrder: string[];

  // Actions
  updateTask: (payload: TaskStatusChangePayload) => void;
  completeTask: (payload: TaskTerminalPayload) => void;
  toggleExpand: (taskId: string) => void;
  cancelTask: (taskId: string) => void;
  clearCompleted: () => void;
  getRootTasks: () => TaskNode[];
  getChildTasks: (parentId: string) => TaskNode[];
}

export const useTaskStore = create<TaskStore>((set, get) => ({
  tasks: new Map<string, TaskNode>(),
  expandedTasks: new Set<string>(),
  insertionOrder: [],

  updateTask: (payload: TaskStatusChangePayload) => {
    set((state) => {
      const tasks = new Map(state.tasks);
      const existing = tasks.get(payload.taskId);

      if (existing) {
        // Update existing task
        tasks.set(payload.taskId, {
          ...existing,
          status: payload.state,
          title: payload.desc || existing.title,
        });
        return { tasks };
      }

      // Create new task
      const parentId = payload.stepId;
      const newTask: TaskNode = {
        id: payload.taskId,
        parentId,
        title: payload.desc,
        status: payload.state,
      };
      tasks.set(payload.taskId, newTask);

      return {
        tasks,
        insertionOrder: [...state.insertionOrder, payload.taskId],
      };
    });
  },

  completeTask: (payload: TaskTerminalPayload) => {
    set((state) => {
      const tasks = new Map(state.tasks);
      const existing = tasks.get(payload.taskId);

      if (existing) {
        tasks.set(payload.taskId, {
          ...existing,
          status: payload.state as TaskState,
          title: payload.summary || existing.title,
          errorCode: payload.errorCode,
          errorMessage: payload.state === 'failed' ? payload.summary : undefined,
        });
      }

      return { tasks };
    });
  },

  toggleExpand: (taskId: string) => {
    set((state) => {
      const expandedTasks = new Set(state.expandedTasks);
      if (expandedTasks.has(taskId)) {
        expandedTasks.delete(taskId);
      } else {
        expandedTasks.add(taskId);
      }
      return { expandedTasks };
    });
  },

  cancelTask: (taskId: string) => {
    useWebSocketStore.getState().cancelTask(taskId);
  },

  clearCompleted: () => {
    set((state) => {
      const tasks = new Map(state.tasks);
      const terminalStates: TaskState[] = ['success', 'failed', 'cancelled'];
      const removedIds = new Set<string>();

      for (const [id, task] of tasks) {
        if (terminalStates.includes(task.status)) {
          removedIds.add(id);
        }
      }

      for (const id of removedIds) {
        tasks.delete(id);
      }

      return {
        tasks,
        insertionOrder: state.insertionOrder.filter((id) => !removedIds.has(id)),
      };
    });
  },

  getRootTasks: () => {
    const { tasks, insertionOrder } = get();
    const rootTasks: TaskNode[] = [];

    for (const id of insertionOrder) {
      const task = tasks.get(id);
      if (task && !task.parentId) {
        rootTasks.push(task);
      }
    }

    return rootTasks;
  },

  getChildTasks: (parentId: string) => {
    const { tasks, insertionOrder } = get();
    const children: TaskNode[] = [];

    for (const id of insertionOrder) {
      const task = tasks.get(id);
      if (task && task.parentId === parentId) {
        children.push(task);
      }
    }

    return children;
  },
}));
