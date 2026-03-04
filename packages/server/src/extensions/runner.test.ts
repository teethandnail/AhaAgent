import { describe, it, expect, beforeEach, vi } from 'vitest';
import { type ExtensionMetadata } from './manifest.js';
import { ExtensionRunner, type IpcMessage, type IpcResponse } from './runner.js';

// Create a mock ChildProcess with EventEmitter-like behavior
function createMockChildProcess() {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();

  const mockProcess = {
    pid: 12345,
    killed: false,
    connected: true,

    on(event: string, handler: (...args: unknown[]) => void) {
      const handlers = listeners.get(event) ?? [];
      handlers.push(handler);
      listeners.set(event, handlers);
      return mockProcess;
    },

    off(event: string, handler: (...args: unknown[]) => void) {
      const handlers = listeners.get(event) ?? [];
      listeners.set(
        event,
        handlers.filter((h) => h !== handler),
      );
      return mockProcess;
    },

    send(message: IpcMessage) {
      // Simulate IPC response based on message type
      setTimeout(() => {
        const messageHandlers = listeners.get('message') ?? [];
        if (message.type === 'health_check') {
          const response: IpcResponse = {
            type: 'health_check_response',
            id: message.id,
            ok: true,
          };
          for (const handler of messageHandlers) {
            handler(response);
          }
        } else if (message.type === 'get_tools') {
          const response: IpcResponse = {
            type: 'get_tools_response',
            id: message.id,
            ok: true,
            payload: [],
          };
          for (const handler of messageHandlers) {
            handler(response);
          }
        }
      }, 10);
      return true;
    },

    kill(signal?: string) {
      mockProcess.killed = true;
      // Emit exit event when killed
      setTimeout(() => {
        const exitHandlers = listeners.get('exit') ?? [];
        for (const handler of exitHandlers) {
          handler(signal === 'SIGKILL' ? 1 : 0, signal ?? 'SIGTERM');
        }
      }, 10);
      return true;
    },

    // Helper to simulate a crash
    _simulateCrash() {
      const exitHandlers = listeners.get('exit') ?? [];
      for (const handler of exitHandlers) {
        handler(1, null);
      }
    },

    // Helper to get listeners
    _getListeners() {
      return listeners;
    },
  };

  return mockProcess;
}

// Mock child_process.fork
vi.mock('node:child_process', () => ({
  fork: vi.fn(() => createMockChildProcess()),
}));

function createTestMetadata(
  overrides?: Partial<ExtensionMetadata>,
): ExtensionMetadata {
  return {
    id: 'test-ext',
    manifest: {
      name: 'test-ext',
      version: '1.0.0',
      description: 'Test extension',
      author: 'Tester',
      entry: 'index.js',
      permissions: [],
      checksum: 'a'.repeat(64),
    },
    installPath: '/tmp/extensions/test-ext',
    enabled: true,
    status: 'installed',
    tools: [],
    ...overrides,
  };
}

describe('ExtensionRunner', () => {
  let runner: ExtensionRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    runner = new ExtensionRunner();
  });

  describe('start', () => {
    it('should create a child process and return true', async () => {
      const metadata = createTestMetadata();
      const result = await runner.start(metadata);

      expect(result).toBe(true);
      expect(metadata.status).toBe('running');
    });

    it('should return false if extension is already running', async () => {
      const metadata = createTestMetadata();
      await runner.start(metadata);

      const result = await runner.start(metadata);
      expect(result).toBe(false);
    });
  });

  describe('stop', () => {
    it('should kill the process and return true', async () => {
      const metadata = createTestMetadata();
      await runner.start(metadata);

      const result = await runner.stop('test-ext');
      expect(result).toBe(true);
      expect(metadata.status).toBe('stopped');
    });

    it('should return false for unknown extension', async () => {
      const result = await runner.stop('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('getStatus', () => {
    it('should return "unknown" for an unregistered extension', () => {
      expect(runner.getStatus('nonexistent')).toBe('unknown');
    });

    it('should return "running" for a started extension', async () => {
      const metadata = createTestMetadata();
      await runner.start(metadata);
      expect(runner.getStatus('test-ext')).toBe('running');
    });
  });

  describe('healthCheck', () => {
    it('should return healthy for a running process', async () => {
      const metadata = createTestMetadata();
      await runner.start(metadata);

      const result = await runner.healthCheck('test-ext');
      expect(result.healthy).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should return unhealthy for a stopped/unknown process', async () => {
      const result = await runner.healthCheck('nonexistent');
      expect(result.healthy).toBe(false);
      expect(result.error).toBe('Extension not running');
    });
  });

  describe('getTools', () => {
    it('should return empty array for unknown extension', () => {
      const tools = runner.getTools('nonexistent');
      expect(tools).toEqual([]);
    });

    it('should return tools from metadata for running extension', async () => {
      const metadata = createTestMetadata({
        tools: [
          {
            name: 'my_tool',
            description: 'A test tool',
            inputSchema: { type: 'object' },
          },
        ],
      });
      await runner.start(metadata);

      const tools = runner.getTools('test-ext');
      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toBe('my_tool');
    });
  });

  describe('stopAll', () => {
    it('should stop all running processes', async () => {
      const m1 = createTestMetadata({ id: 'ext-a' });
      m1.manifest = { ...m1.manifest, name: 'ext-a' };
      m1.installPath = '/tmp/extensions/ext-a';

      const m2 = createTestMetadata({ id: 'ext-b' });
      m2.manifest = { ...m2.manifest, name: 'ext-b' };
      m2.installPath = '/tmp/extensions/ext-b';

      await runner.start(m1);
      await runner.start(m2);

      await runner.stopAll();

      expect(runner.getStatus('ext-a')).toBe('unknown');
      expect(runner.getStatus('ext-b')).toBe('unknown');
    });
  });

  describe('process crash handling', () => {
    it('should mark extension as failed on non-zero exit', async () => {
      // We need to get access to the mock process to simulate a crash
      const { fork } = await import('node:child_process');
      const mockFork = vi.mocked(fork);

      const mockChild = createMockChildProcess();
      mockFork.mockReturnValueOnce(
        mockChild as unknown as ReturnType<typeof fork>,
      );

      const metadata = createTestMetadata();
      await runner.start(metadata);

      // Simulate a crash (non-zero exit code)
      mockChild._simulateCrash();

      // Allow async event handlers to execute
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      // After crash, the process should be removed and status should be failed
      expect(runner.getStatus(metadata.id)).toBe('unknown');
      expect(metadata.status).toBe('failed');
    });
  });
});
