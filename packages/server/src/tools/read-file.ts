import * as fs from 'node:fs/promises';
import {
  type ReadFileInput,
  type ReadFileOutput,
  type ToolResult,
  ErrorCodes,
} from '@aha-agent/shared';
import { type Sandbox } from './sandbox.js';
import { computeFileVersion } from './file-version.js';

/**
 * Read a file from within the sandbox boundary.
 *
 * 1. Validate path via sandbox
 * 2. Check sensitivity (reject 'secret')
 * 3. Read file, compute version
 * 4. Return content with version and sensitivity
 */
export async function readFile(
  input: ReadFileInput,
  sandbox: Sandbox,
): Promise<ToolResult<ReadFileOutput>> {
  // 1. Validate path
  const allowed = await sandbox.validatePath(input.path);
  if (!allowed) {
    return {
      ok: false,
      errorCode: ErrorCodes.SANDBOX_PATH_ESCAPE.code,
      errorMessage: `${ErrorCodes.SANDBOX_PATH_ESCAPE.message}: ${input.path}`,
    };
  }

  // 2. Check sensitivity
  const sensitivity = sandbox.classifySensitivity(input.path);
  if (sensitivity === 'secret') {
    return {
      ok: false,
      errorCode: ErrorCodes.SANDBOX_SENSITIVE_FILE.code,
      errorMessage: `${ErrorCodes.SANDBOX_SENSITIVE_FILE.message}: ${input.path}`,
    };
  }

  // 3. Read file and compute version
  const content = await fs.readFile(input.path, 'utf-8');
  const version = await computeFileVersion(input.path);

  // 4. Return result
  return {
    ok: true,
    output: {
      path: input.path,
      content,
      version,
      sensitivity,
    },
  };
}
