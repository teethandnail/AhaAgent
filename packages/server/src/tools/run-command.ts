import { spawn } from 'node:child_process';
import {
  type RunCommandInput,
  type RunCommandOutput,
  type ToolResult,
} from '@aha-agent/shared';

const DEFAULT_TIMEOUT_SEC = 30;

/**
 * Spawn a child process and collect its output.
 *
 * - Applies a configurable timeout (default 30s).
 * - Collects stdout and stderr.
 * - Returns exitCode, stdout, stderr.
 */
export async function runCommand(
  input: RunCommandInput,
): Promise<ToolResult<RunCommandOutput>> {
  const timeoutMs = (input.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;

  return new Promise((resolve) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on('error', (err) => {
      resolve({
        ok: false,
        errorCode: 'AHA-SYS-001',
        errorMessage: `Failed to spawn process: ${err.message}`,
      });
    });

    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      const exitCode = code ?? 1;

      resolve({
        ok: exitCode === 0,
        output: { exitCode, stdout, stderr },
      });
    });
  });
}
