import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeFileVersion } from './file-version.js';
import { writeFileSafely } from './write-file.js';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-write-file-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('writeFileSafely', () => {
  it('creates a new file without expectedVersion', async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, 'new.txt');

    const result = await writeFileSafely({
      path: filePath,
      content: 'hello',
    });

    expect(result.ok).toBe(true);
    expect(await fs.readFile(filePath, 'utf-8')).toBe('hello');
  });

  it('rejects overwriting an existing file without expectedVersion', async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, 'existing.txt');
    await fs.writeFile(filePath, 'before', 'utf-8');

    const result = await writeFileSafely({
      path: filePath,
      content: 'after',
    });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('AHA-TOOL-002');
    expect(result.errorMessage).toContain('expectedVersion is required');
    expect(await fs.readFile(filePath, 'utf-8')).toBe('before');
  });

  it('rejects overwriting when expectedVersion mismatches', async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, 'existing.txt');
    await fs.writeFile(filePath, 'before', 'utf-8');

    const result = await writeFileSafely({
      path: filePath,
      content: 'after',
      expectedVersion: 'deadbeefdeadbeef',
    });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('AHA-TOOL-002');
    expect(result.errorMessage).toContain('Version conflict');
    expect(await fs.readFile(filePath, 'utf-8')).toBe('before');
  });

  it('overwrites when expectedVersion matches the current file', async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, 'existing.txt');
    await fs.writeFile(filePath, 'before', 'utf-8');
    const expectedVersion = await computeFileVersion(filePath);

    const result = await writeFileSafely({
      path: filePath,
      content: 'after',
      expectedVersion,
    });

    expect(result.ok).toBe(true);
    expect(await fs.readFile(filePath, 'utf-8')).toBe('after');
  });
});
