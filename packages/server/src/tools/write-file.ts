import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { type ToolResult, type WriteFileOutput } from '@aha-agent/shared';
import { computeFileVersion } from './file-version.js';

export interface SafeWriteFileInput {
  path: string;
  content: string;
  expectedVersion?: string;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write a file with an overwrite precondition.
 *
 * - Creating a new file does not require expectedVersion.
 * - Overwriting an existing file requires expectedVersion to prevent blind writes.
 * - If expectedVersion is present, it must match the current content hash.
 */
export async function writeFileSafely(
  input: SafeWriteFileInput,
): Promise<ToolResult<WriteFileOutput>> {
  const exists = await fileExists(input.path);

  if (exists) {
    if (!input.expectedVersion) {
      return {
        ok: false,
        errorCode: 'AHA-TOOL-002',
        errorMessage: 'expectedVersion is required when overwriting an existing file',
      };
    }

    const currentVersion = await computeFileVersion(input.path);
    if (currentVersion !== input.expectedVersion) {
      return {
        ok: false,
        errorCode: 'AHA-TOOL-002',
        errorMessage: `Version conflict: expected ${input.expectedVersion}, got ${currentVersion}`,
      };
    }
  }

  await fs.mkdir(path.dirname(input.path), { recursive: true });
  await fs.writeFile(input.path, input.content, 'utf-8');
  const version = await computeFileVersion(input.path);
  return {
    ok: true,
    output: {
      path: input.path,
      version,
    },
  };
}
