import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  type ListDirInput,
  type ListDirOutput,
  type ToolResult,
  ErrorCodes,
} from '@aha-agent/shared';
import { type Sandbox } from './sandbox.js';

/**
 * List directory contents within the sandbox boundary.
 *
 * 1. Validate path via sandbox
 * 2. Read directory entries
 * 3. Return name, path, type for each entry
 */
export async function listDir(
  input: ListDirInput,
  sandbox: Sandbox,
): Promise<ToolResult<ListDirOutput>> {
  // 1. Validate path
  const allowed = await sandbox.validatePath(input.path);
  if (!allowed) {
    return {
      ok: false,
      errorCode: ErrorCodes.SANDBOX_PATH_ESCAPE.code,
      errorMessage: `${ErrorCodes.SANDBOX_PATH_ESCAPE.message}: ${input.path}`,
    };
  }

  // 2. Read directory entries
  const dirents = await fs.readdir(input.path, { withFileTypes: true });

  // 3. Map to output format
  const entries = dirents.map((dirent) => ({
    name: dirent.name,
    path: path.join(input.path, dirent.name),
    type: dirent.isDirectory() ? ('dir' as const) : ('file' as const),
  }));

  return {
    ok: true,
    output: { entries },
  };
}
