import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Sandbox } from './sandbox.js';
import { readFile } from './read-file.js';

describe('readFile', () => {
  let tmpDir: string;
  let sandbox: Sandbox;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'readfile-test-'));
    sandbox = new Sandbox([tmpDir]);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should read a normal file with content, version, and sensitivity', async () => {
    const filePath = path.join(tmpDir, 'hello.txt');
    await fs.writeFile(filePath, 'Hello, world!');

    const result = await readFile({ path: filePath }, sandbox);

    expect(result.ok).toBe(true);
    expect(result.output).toBeDefined();
    expect(result.output!.content).toBe('Hello, world!');
    expect(result.output!.path).toBe(filePath);
    expect(result.output!.version).toMatch(/^[0-9a-f]{16}$/);
    expect(result.output!.sensitivity).toBe('public');
  });

  it('should reject a file outside the workspace with AHA-SANDBOX-001', async () => {
    const outsideDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'outside-read-'),
    );
    try {
      const filePath = path.join(outsideDir, 'outside.txt');
      await fs.writeFile(filePath, 'should not read');

      const result = await readFile({ path: filePath }, sandbox);

      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe('AHA-SANDBOX-001');
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('should reject a .env file with AHA-SANDBOX-002', async () => {
    const filePath = path.join(tmpDir, '.env');
    await fs.writeFile(filePath, 'SECRET_KEY=abc123');

    const result = await readFile({ path: filePath }, sandbox);

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('AHA-SANDBOX-002');
  });

  it('should reject a .pem file with AHA-SANDBOX-002', async () => {
    const filePath = path.join(tmpDir, 'cert.pem');
    await fs.writeFile(filePath, '-----BEGIN CERTIFICATE-----');

    const result = await readFile({ path: filePath }, sandbox);

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('AHA-SANDBOX-002');
  });
});
