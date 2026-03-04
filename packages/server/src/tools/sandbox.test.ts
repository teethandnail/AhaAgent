import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Sandbox } from './sandbox.js';

describe('Sandbox', () => {
  let tmpDir: string;
  let sandbox: Sandbox;

  beforeEach(async () => {
    // Create a real temp directory as the workspace
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-test-'));
    sandbox = new Sandbox([tmpDir]);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('validatePath', () => {
    it('should allow a file inside the workspace', async () => {
      const filePath = path.join(tmpDir, 'hello.txt');
      await fs.writeFile(filePath, 'hello');

      const result = await sandbox.validatePath(filePath);
      expect(result).toBe(true);
    });

    it('should allow a non-existent file inside the workspace (write target)', async () => {
      const filePath = path.join(tmpDir, 'new-file.txt');

      const result = await sandbox.validatePath(filePath);
      expect(result).toBe(true);
    });

    it('should reject a file outside the workspace', async () => {
      const outsideDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'outside-test-'),
      );
      try {
        const filePath = path.join(outsideDir, 'secret.txt');
        await fs.writeFile(filePath, 'secret');

        const result = await sandbox.validatePath(filePath);
        expect(result).toBe(false);
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });

    it('should reject a symlink that escapes the workspace', async () => {
      const outsideDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'symlink-target-'),
      );
      try {
        const outsideFile = path.join(outsideDir, 'target.txt');
        await fs.writeFile(outsideFile, 'secret data');

        const symlinkPath = path.join(tmpDir, 'escape-link');
        await fs.symlink(outsideFile, symlinkPath);

        const result = await sandbox.validatePath(symlinkPath);
        expect(result).toBe(false);
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });

    it('should reject path traversal attempts', async () => {
      const traversalPath = path.join(tmpDir, '..', '..', 'etc', 'passwd');

      const result = await sandbox.validatePath(traversalPath);
      expect(result).toBe(false);
    });
  });

  describe('classifySensitivity', () => {
    it('should classify .env as secret', () => {
      expect(sandbox.classifySensitivity('/project/.env')).toBe('secret');
    });

    it('should classify .env.local as secret', () => {
      expect(sandbox.classifySensitivity('/project/.env.local')).toBe('secret');
    });

    it('should classify .env.production as secret', () => {
      expect(sandbox.classifySensitivity('/project/.env.production')).toBe(
        'secret',
      );
    });

    it('should classify .pem files as secret', () => {
      expect(sandbox.classifySensitivity('/keys/server.pem')).toBe('secret');
    });

    it('should classify .key files as secret', () => {
      expect(sandbox.classifySensitivity('/keys/private.key')).toBe('secret');
    });

    it('should classify id_rsa as secret', () => {
      expect(sandbox.classifySensitivity('/home/user/id_rsa')).toBe('secret');
    });

    it('should classify id_rsa.pub as secret', () => {
      expect(sandbox.classifySensitivity('/home/user/id_rsa.pub')).toBe(
        'secret',
      );
    });

    it('should classify .ssh directory contents as secret', () => {
      expect(
        sandbox.classifySensitivity('/home/user/.ssh/authorized_keys'),
      ).toBe('secret');
    });

    it('should classify .npmrc as secret', () => {
      expect(sandbox.classifySensitivity('/project/.npmrc')).toBe('secret');
    });

    it('should classify secrets.* files as secret', () => {
      expect(sandbox.classifySensitivity('/project/secrets.json')).toBe(
        'secret',
      );
      expect(sandbox.classifySensitivity('/project/secrets.yaml')).toBe(
        'secret',
      );
    });

    it('should classify normal files as public', () => {
      expect(sandbox.classifySensitivity('/project/src/index.ts')).toBe(
        'public',
      );
    });

    it('should classify README.md as public', () => {
      expect(sandbox.classifySensitivity('/project/README.md')).toBe('public');
    });

    it('should classify package.json as public', () => {
      expect(sandbox.classifySensitivity('/project/package.json')).toBe(
        'public',
      );
    });
  });
});
