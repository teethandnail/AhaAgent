import { describe, it, expect, vi } from 'vitest';
import type { TaskState, AhaError } from '@aha-agent/shared';
import { TaskManager } from './task-manager.js';

/** Type guard: distinguish AhaError from TaskNode */
function isError(value: unknown): value is AhaError {
  return typeof value === 'object' && value !== null && 'code' in value && 'retryable' in value;
}

describe('TaskManager', () => {
  // ---- createTask ----

  it('should create a task with pending status', () => {
    const mgr = new TaskManager();
    const task = mgr.createTask('Build project');

    expect(task.id).toBeDefined();
    expect(task.title).toBe('Build project');
    expect(task.status).toBe('pending');
    expect(task.parentId).toBeUndefined();
  });

  it('should create a child task with parentId', () => {
    const mgr = new TaskManager();
    const parent = mgr.createTask('Parent');
    const child = mgr.createTask('Child', parent.id);

    expect(child.parentId).toBe(parent.id);
  });

  it('should register child in parent.children array', () => {
    const mgr = new TaskManager();
    const parent = mgr.createTask('Parent');
    const child = mgr.createTask('Child', parent.id);

    expect(parent.children).toBeDefined();
    expect(parent.children).toContain(child);
  });

  // ---- getTask / getChildren ----

  it('should retrieve a task by ID', () => {
    const mgr = new TaskManager();
    const task = mgr.createTask('Fetch data');

    expect(mgr.getTask(task.id)).toBe(task);
  });

  it('should return undefined for unknown task ID', () => {
    const mgr = new TaskManager();
    expect(mgr.getTask('nonexistent')).toBeUndefined();
  });

  it('should return children of a parent task', () => {
    const mgr = new TaskManager();
    const parent = mgr.createTask('Parent');
    const c1 = mgr.createTask('Child 1', parent.id);
    const c2 = mgr.createTask('Child 2', parent.id);
    mgr.createTask('Orphan'); // not a child

    const children = mgr.getChildren(parent.id);
    expect(children).toHaveLength(2);
    expect(children).toContain(c1);
    expect(children).toContain(c2);
  });

  it('restores a persisted task into memory', () => {
    const mgr = new TaskManager();
    mgr.restoreTask({
      id: 'restored-task',
      title: 'Recovered approval',
      status: 'blocked',
    });

    const task = mgr.getTask('restored-task');
    expect(task).toBeDefined();
    expect(task?.status).toBe('blocked');
  });

  it('lists all tracked tasks', () => {
    const mgr = new TaskManager();
    const a = mgr.createTask('A');
    const b = mgr.createTask('B');

    const ids = mgr.listTasks().map((task) => task.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
  });

  // ---- valid transitions ----

  it('should transition pending -> running', () => {
    const mgr = new TaskManager();
    const task = mgr.createTask('Task');
    const result = mgr.transition(task.id, 'running');

    expect(isError(result)).toBe(false);
    expect(task.status).toBe('running');
  });

  it('should transition running -> blocked', () => {
    const mgr = new TaskManager();
    const task = mgr.createTask('Task');
    mgr.transition(task.id, 'running');
    const result = mgr.transition(task.id, 'blocked');

    expect(isError(result)).toBe(false);
    expect(task.status).toBe('blocked');
  });

  it('should transition running -> success', () => {
    const mgr = new TaskManager();
    const task = mgr.createTask('Task');
    mgr.transition(task.id, 'running');
    const result = mgr.transition(task.id, 'success');

    expect(isError(result)).toBe(false);
    expect(task.status).toBe('success');
  });

  it('should transition running -> failed', () => {
    const mgr = new TaskManager();
    const task = mgr.createTask('Task');
    mgr.transition(task.id, 'running');
    const result = mgr.transition(task.id, 'failed');

    expect(isError(result)).toBe(false);
    expect(task.status).toBe('failed');
  });

  it('should transition running -> cancelled', () => {
    const mgr = new TaskManager();
    const task = mgr.createTask('Task');
    mgr.transition(task.id, 'running');
    const result = mgr.transition(task.id, 'cancelled');

    expect(isError(result)).toBe(false);
    expect(task.status).toBe('cancelled');
  });

  it('should transition blocked -> running', () => {
    const mgr = new TaskManager();
    const task = mgr.createTask('Task');
    mgr.transition(task.id, 'running');
    mgr.transition(task.id, 'blocked');
    const result = mgr.transition(task.id, 'running');

    expect(isError(result)).toBe(false);
    expect(task.status).toBe('running');
  });

  it('should transition blocked -> cancelled', () => {
    const mgr = new TaskManager();
    const task = mgr.createTask('Task');
    mgr.transition(task.id, 'running');
    mgr.transition(task.id, 'blocked');
    const result = mgr.transition(task.id, 'cancelled');

    expect(isError(result)).toBe(false);
    expect(task.status).toBe('cancelled');
  });

  // ---- invalid transitions ----

  it('should reject invalid transition pending -> blocked', () => {
    const mgr = new TaskManager();
    const task = mgr.createTask('Task');
    const result = mgr.transition(task.id, 'blocked');

    expect(isError(result)).toBe(true);
  });

  it('should reject transition on terminal state (success)', () => {
    const mgr = new TaskManager();
    const task = mgr.createTask('Task');
    mgr.transition(task.id, 'running');
    mgr.transition(task.id, 'success');

    const result = mgr.transition(task.id, 'running');
    expect(isError(result)).toBe(true);
  });

  it('should reject transition on terminal state (failed)', () => {
    const mgr = new TaskManager();
    const task = mgr.createTask('Task');
    mgr.transition(task.id, 'running');
    mgr.transition(task.id, 'failed');

    const result = mgr.transition(task.id, 'running');
    expect(isError(result)).toBe(true);
  });

  it('should reject transition on terminal state (cancelled)', () => {
    const mgr = new TaskManager();
    const task = mgr.createTask('Task');
    mgr.transition(task.id, 'running');
    mgr.transition(task.id, 'cancelled');

    const result = mgr.transition(task.id, 'running');
    expect(isError(result)).toBe(true);
  });

  it('should return error for unknown task ID', () => {
    const mgr = new TaskManager();
    const result = mgr.transition('nonexistent', 'running');
    expect(isError(result)).toBe(true);
  });

  // ---- cancel cascade ----

  it('should cancel a task and all non-terminal children recursively', () => {
    const mgr = new TaskManager();
    const parent = mgr.createTask('Parent');
    const child1 = mgr.createTask('Child 1', parent.id);
    const child2 = mgr.createTask('Child 2', parent.id);
    const grandchild = mgr.createTask('Grandchild', child1.id);

    // Make parent and child1 running
    mgr.transition(parent.id, 'running');
    mgr.transition(child1.id, 'running');

    // Make child2 already succeeded (terminal)
    mgr.transition(child2.id, 'running');
    mgr.transition(child2.id, 'success');

    mgr.cancel(parent.id);

    expect(parent.status).toBe('cancelled');
    expect(child1.status).toBe('cancelled');
    expect(child2.status).toBe('success'); // Terminal, not changed
    expect(grandchild.status).toBe('cancelled');
  });

  // ---- state change callback ----

  it('should fire onStateChange callback on transition', () => {
    const callback = vi.fn();
    const mgr = new TaskManager({ onStateChange: callback });
    const task = mgr.createTask('Task');

    mgr.transition(task.id, 'running');

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(task.id, 'pending', 'running');
  });

  it('should fire onStateChange for each child during cancel cascade', () => {
    const changes: Array<[string, TaskState, TaskState]> = [];
    const mgr = new TaskManager({
      onStateChange: (id, from, to) => changes.push([id, from, to]),
    });
    const parent = mgr.createTask('Parent');
    const child = mgr.createTask('Child', parent.id);
    mgr.transition(parent.id, 'running');
    mgr.transition(child.id, 'running');

    // Clear recorded transitions so far
    changes.length = 0;

    mgr.cancel(parent.id);

    // Parent running->cancelled, child running->cancelled
    expect(changes).toHaveLength(2);
    expect(changes[0]).toEqual([parent.id, 'running', 'cancelled']);
    expect(changes[1]).toEqual([child.id, 'running', 'cancelled']);
  });

  it('should not fire callback for invalid transitions', () => {
    const callback = vi.fn();
    const mgr = new TaskManager({ onStateChange: callback });
    const task = mgr.createTask('Task');

    mgr.transition(task.id, 'blocked'); // invalid from pending

    expect(callback).not.toHaveBeenCalled();
  });
});
