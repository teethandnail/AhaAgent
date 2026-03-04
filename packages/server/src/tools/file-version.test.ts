import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { computeFileVersion } from './file-version.js';

describe('computeFileVersion', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'version-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should produce the same hash for the same content', async () => {
    const file1 = path.join(tmpDir, 'a.txt');
    const file2 = path.join(tmpDir, 'b.txt');
    await fs.writeFile(file1, 'identical content');
    await fs.writeFile(file2, 'identical content');

    const v1 = await computeFileVersion(file1);
    const v2 = await computeFileVersion(file2);
    expect(v1).toBe(v2);
  });

  it('should produce different hashes for different content', async () => {
    const file1 = path.join(tmpDir, 'a.txt');
    const file2 = path.join(tmpDir, 'b.txt');
    await fs.writeFile(file1, 'content A');
    await fs.writeFile(file2, 'content B');

    const v1 = await computeFileVersion(file1);
    const v2 = await computeFileVersion(file2);
    expect(v1).not.toBe(v2);
  });

  it('should return a 16-character hex string', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    await fs.writeFile(filePath, 'some content');

    const version = await computeFileVersion(filePath);
    expect(version).toHaveLength(16);
    expect(version).toMatch(/^[0-9a-f]{16}$/);
  });
});
