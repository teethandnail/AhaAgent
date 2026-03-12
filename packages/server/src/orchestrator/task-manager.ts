/**
 * TaskManager — creates, tracks, and transitions tasks through a state machine.
 *
 * State machine transitions (TaskState):
 *   pending  -> running
 *   running  -> blocked | success | failed | cancelled
 *   blocked  -> running | cancelled
 *   success  -> (terminal)
 *   failed   -> (terminal)
 *   cancelled -> (terminal)
 */

import { randomUUID } from 'node:crypto';
import type { TaskState, TaskNode, AhaError } from '@aha-agent/shared';
import { createError } from '@aha-agent/shared';

/** Allowed transitions: `from` -> Set<to> */
const VALID_TRANSITIONS: Record<string, Set<TaskState>> = {
  pending: new Set<TaskState>(['running']),
  running: new Set<TaskState>(['blocked', 'success', 'failed', 'cancelled']),
  blocked: new Set<TaskState>(['running', 'cancelled']),
};

const TERMINAL_STATES: Set<TaskState> = new Set(['success', 'failed', 'cancelled']);

export interface TaskManagerOptions {
  onStateChange?: (taskId: string, oldState: TaskState, newState: TaskState) => void;
}

export class TaskManager {
  private tasks = new Map<string, TaskNode>();
  private onStateChange?: TaskManagerOptions['onStateChange'];

  constructor(options?: TaskManagerOptions) {
    this.onStateChange = options?.onStateChange;
  }

  /**
   * Create a new task in `pending` state.
   */
  createTask(title: string, parentId?: string): TaskNode {
    const task: TaskNode = {
      id: randomUUID(),
      title,
      status: 'pending',
      ...(parentId !== undefined ? { parentId } : {}),
    };

    this.tasks.set(task.id, task);

    // Register as child of parent (if parent exists)
    if (parentId !== undefined) {
      const parent = this.tasks.get(parentId);
      if (parent) {
        if (!parent.children) parent.children = [];
        parent.children.push(task);
      }
    }

    return task;
  }

  /**
   * Restore a persisted task into the in-memory state machine.
   */
  restoreTask(task: TaskNode): void {
    this.tasks.set(task.id, { ...task });
  }

  /**
   * Retrieve a task by ID.
   */
  getTask(taskId: string): TaskNode | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Get all direct children of a parent task.
   */
  getChildren(parentId: string): TaskNode[] {
    const result: TaskNode[] = [];
    for (const task of this.tasks.values()) {
      if (task.parentId === parentId) {
        result.push(task);
      }
    }
    return result;
  }

  /**
   * Return all tasks currently tracked in memory.
   */
  listTasks(): TaskNode[] {
    return [...this.tasks.values()];
  }

  /**
   * Transition a task to a new state.
   * Returns the updated TaskNode on success, or an AhaError on failure.
   */
  transition(taskId: string, newState: TaskState): TaskNode | AhaError {
    const task = this.tasks.get(taskId);
    if (!task) {
      return createError('TASK_NOT_FOUND', taskId);
    }

    const oldState = task.status;

    if (TERMINAL_STATES.has(oldState)) {
      return createError('TASK_NOT_FOUND', `task ${taskId} is in terminal state '${oldState}'`);
    }

    const allowed = VALID_TRANSITIONS[oldState];
    if (!allowed || !allowed.has(newState)) {
      return createError(
        'TASK_NOT_FOUND',
        `invalid transition '${oldState}' -> '${newState}' for task ${taskId}`,
      );
    }

    task.status = newState;
    this.onStateChange?.(taskId, oldState, newState);

    return task;
  }

  /**
   * Cancel a task and recursively cancel all non-terminal children.
   */
  cancel(taskId: string): TaskNode | AhaError {
    const task = this.tasks.get(taskId);
    if (!task) {
      return createError('TASK_NOT_FOUND', taskId);
    }

    // Only cancel if in a non-terminal state
    if (!TERMINAL_STATES.has(task.status)) {
      const oldState = task.status;
      task.status = 'cancelled';
      this.onStateChange?.(taskId, oldState, 'cancelled');
    }

    // Recursively cancel children
    this.cancelChildren(taskId);

    return task;
  }

  private cancelChildren(parentId: string): void {
    for (const task of this.tasks.values()) {
      if (task.parentId === parentId && !TERMINAL_STATES.has(task.status)) {
        const oldState = task.status;
        task.status = 'cancelled';
        this.onStateChange?.(task.id, oldState, 'cancelled');
        // Recurse into grandchildren
        this.cancelChildren(task.id);
      }
    }
  }
}
