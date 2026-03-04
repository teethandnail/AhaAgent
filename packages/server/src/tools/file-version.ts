import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

/**
 * Compute a version string for a file based on its content.
 * Returns the first 16 hex characters of the SHA-256 hash.
 */
export async function computeFileVersion(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  const hash = createHash('sha256').update(content).digest('hex');
  return hash.slice(0, 16);
}
