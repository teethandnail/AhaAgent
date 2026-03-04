import { type ChildProcess, fork } from 'node:child_process';
import { createError } from '@aha-agent/shared';
import { type ExtensionMetadata, type ExtensionTool } from './manifest.js';

/**
 * IPC message types for communication between the runner and extension processes.
 */
export interface IpcMessage {
  type: 'health_check' | 'get_tools' | 'invoke_tool';
  id: string;
  payload?: unknown;
}

export interface IpcResponse {
  type: 'health_check_response' | 'get_tools_response' | 'invoke_tool_response';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: string;
}

interface RunningExtension {
  process: ChildProcess;
  metadata: ExtensionMetadata;
}

const STARTUP_TIMEOUT_MS = 10_000;

/**
 * Manages isolated child processes for running extensions.
 */
export class ExtensionRunner {
  private readonly processes: Map<string, RunningExtension>;

  constructor() {
    this.processes = new Map();
  }

  /**
   * Start an extension in an isolated child process.
   *
   * - Spawns a child process via fork() with resource limits
   * - Sets up IPC communication
   * - Runs a health check after startup
   */
  async start(metadata: ExtensionMetadata): Promise<boolean> {
    const extensionId = metadata.id;

    // Don't start if already running
    if (this.processes.has(extensionId)) {
      return false;
    }

    const entryPath = `${metadata.installPath}/${metadata.manifest.entry}`;

    const child = fork(entryPath, [], {
      execArgv: ['--max-old-space-size=128'],
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      silent: true,
    });

    const running: RunningExtension = { process: child, metadata };
    this.processes.set(extensionId, running);

    // Handle process exit / crash
    child.on('exit', (code) => {
      const entry = this.processes.get(extensionId);
      if (entry) {
        if (code !== 0 && code !== null) {
          entry.metadata.status = 'failed';
        } else {
          entry.metadata.status = 'stopped';
        }
        this.processes.delete(extensionId);
      }
    });

    child.on('error', () => {
      const entry = this.processes.get(extensionId);
      if (entry) {
        entry.metadata.status = 'failed';
        this.processes.delete(extensionId);
      }
    });

    // Wait for startup with timeout
    const startupOk = await this.waitForStartup(extensionId);
    if (!startupOk) {
      // Kill the process if startup timed out
      child.kill('SIGTERM');
      this.processes.delete(extensionId);
      metadata.status = 'failed';
      return false;
    }

    metadata.status = 'running';
    return true;
  }

  /**
   * Stop a running extension.
   */
  async stop(extensionId: string): Promise<boolean> {
    const entry = this.processes.get(extensionId);
    if (!entry) {
      return false;
    }

    return new Promise<boolean>((resolve) => {
      const { process: child, metadata } = entry;

      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        this.processes.delete(extensionId);
        metadata.status = 'stopped';
        resolve(true);
      }, 5000);

      child.on('exit', () => {
        clearTimeout(timeout);
        this.processes.delete(extensionId);
        metadata.status = 'stopped';
        resolve(true);
      });

      child.kill('SIGTERM');
    });
  }

  /**
   * Perform a health check on a running extension via IPC.
   */
  async healthCheck(
    extensionId: string,
  ): Promise<{ healthy: boolean; error?: string }> {
    const entry = this.processes.get(extensionId);
    if (!entry) {
      return { healthy: false, error: 'Extension not running' };
    }

    try {
      const response = await this.sendIpcMessage(entry.process, {
        type: 'health_check',
        id: crypto.randomUUID(),
      });

      if (response.ok) {
        entry.metadata.lastHealthCheck = new Date().toISOString();
        return { healthy: true };
      }
      return { healthy: false, error: response.error ?? 'Health check failed' };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return { healthy: false, error: message };
    }
  }

  /**
   * Get the current status of an extension.
   */
  getStatus(extensionId: string): 'running' | 'stopped' | 'failed' | 'unknown' {
    const entry = this.processes.get(extensionId);
    if (!entry) {
      return 'unknown';
    }
    return entry.metadata.status as 'running' | 'stopped' | 'failed';
  }

  /**
   * Stop all running extensions.
   */
  async stopAll(): Promise<void> {
    const ids = [...this.processes.keys()];
    await Promise.all(ids.map((id) => this.stop(id)));
  }

  /**
   * Get the tools registered by a running extension.
   */
  getTools(extensionId: string): ExtensionTool[] {
    const entry = this.processes.get(extensionId);
    if (!entry) {
      return [];
    }
    return entry.metadata.tools;
  }

  /**
   * Wait for the extension to respond to a health check within the startup timeout.
   */
  private async waitForStartup(extensionId: string): Promise<boolean> {
    const entry = this.processes.get(extensionId);
    if (!entry) {
      return false;
    }

    try {
      const response = await this.sendIpcMessage(
        entry.process,
        { type: 'health_check', id: crypto.randomUUID() },
        STARTUP_TIMEOUT_MS,
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Send an IPC message to a child process and await the response.
   */
  private sendIpcMessage(
    child: ChildProcess,
    message: IpcMessage,
    timeoutMs = 5000,
  ): Promise<IpcResponse> {
    return new Promise<IpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(
          createError('EXT_RUNTIME_CRASH', 'IPC message timed out'),
        );
      }, timeoutMs);

      const onMessage = (response: IpcResponse) => {
        if (response.id === message.id) {
          cleanup();
          resolve(response);
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        child.off('message', onMessage);
      };

      child.on('message', onMessage);
      child.send(message);
    });
  }
}
