import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { type ExtensionManifest, validateManifest } from './manifest.js';
import { ExtensionInstaller } from './installer.js';

function createValidManifest(
  overrides?: Partial<ExtensionManifest>,
): ExtensionManifest {
  return {
    name: 'test-extension',
    version: '1.0.0',
    description: 'A test extension',
    author: 'Test Author',
    entry: 'index.js',
    permissions: [{ type: 'file_read', scope: '**/*.ts' }],
    checksum: 'a'.repeat(64),
    ...overrides,
  };
}

describe('validateManifest', () => {
  it('should accept a valid manifest', () => {
    const result = validateManifest(createValidManifest());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should reject missing name', () => {
    const result = validateManifest(createValidManifest({ name: '' }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('name must be a non-empty string');
  });

  it('should reject invalid checksum format', () => {
    const result = validateManifest(
      createValidManifest({ checksum: 'not-a-valid-checksum' }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'checksum must be a 64-character hex string',
    );
  });

  it('should reject non-object data', () => {
    const result = validateManifest(null);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Manifest must be a non-null object');
  });

  it('should reject invalid version', () => {
    const result = validateManifest(createValidManifest({ version: 'abc' }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'version must be a valid semver string (e.g. 1.0.0)',
    );
  });

  it('should reject empty entry', () => {
    const result = validateManifest(createValidManifest({ entry: '' }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('entry must be a non-empty string');
  });

  it('should reject non-array permissions', () => {
    const manifest = { ...createValidManifest() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (manifest as any).permissions = 'not-an-array';
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('permissions must be an array');
  });
});

describe('ExtensionInstaller', () => {
  let installer: ExtensionInstaller;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'ext-installer-test-'),
    );
    installer = new ExtensionInstaller({
      extensionsDir: tmpDir,
      allowedSources: [
        'https://registry.aha-agent.dev/',
        'https://github.com/aha-agent/',
      ],
    });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('isSourceAllowed', () => {
    it('should accept a whitelisted source', () => {
      expect(
        installer.isSourceAllowed(
          'https://registry.aha-agent.dev/my-extension',
        ),
      ).toBe(true);
    });

    it('should reject an unknown source', () => {
      expect(
        installer.isSourceAllowed('https://evil.example.com/malware'),
      ).toBe(false);
    });
  });

  describe('verifyChecksum', () => {
    it('should succeed with correct hash', async () => {
      const content = JSON.stringify(createValidManifest());
      const filePath = path.join(tmpDir, 'manifest.json');
      await fs.writeFile(filePath, content);

      const expectedHash = crypto
        .createHash('sha256')
        .update(Buffer.from(content))
        .digest('hex');

      const result = await installer.verifyChecksum(filePath, expectedHash);
      expect(result).toBe(true);
    });

    it('should fail with wrong hash', async () => {
      const content = JSON.stringify(createValidManifest());
      const filePath = path.join(tmpDir, 'manifest.json');
      await fs.writeFile(filePath, content);

      const result = await installer.verifyChecksum(filePath, 'b'.repeat(64));
      expect(result).toBe(false);
    });
  });

  describe('install', () => {
    it('should succeed with valid source and manifest', async () => {
      const manifest = createValidManifest();
      const metadata = await installer.install(
        'https://registry.aha-agent.dev/test-extension',
        manifest,
      );

      expect(metadata.id).toBe('test-extension');
      expect(metadata.manifest).toBe(manifest);
      expect(metadata.enabled).toBe(true);
      expect(metadata.status).toBe('installed');
      expect(metadata.installPath).toBe(
        `${tmpDir}/test-extension`,
      );
    });

    it('should reject a non-whitelisted source', async () => {
      const manifest = createValidManifest();
      await expect(
        installer.install('https://evil.example.com/ext', manifest),
      ).rejects.toMatchObject({
        code: 'AHA-EXT-001',
      });
    });

    it('should reject an invalid manifest', async () => {
      const manifest = createValidManifest({ name: '' });
      await expect(
        installer.install(
          'https://registry.aha-agent.dev/bad-ext',
          manifest,
        ),
      ).rejects.toMatchObject({
        code: 'AHA-EXT-001',
      });
    });
  });

  describe('uninstall', () => {
    it('should remove an installed extension', async () => {
      const manifest = createValidManifest();
      await installer.install(
        'https://registry.aha-agent.dev/test-extension',
        manifest,
      );

      expect(installer.uninstall('test-extension')).toBe(true);
      expect(installer.getExtension('test-extension')).toBeUndefined();
    });

    it('should return false for non-existent extension', () => {
      expect(installer.uninstall('nonexistent')).toBe(false);
    });
  });

  describe('listExtensions', () => {
    it('should return all installed extensions', async () => {
      const m1 = createValidManifest({ name: 'ext-a' });
      const m2 = createValidManifest({ name: 'ext-b' });

      await installer.install(
        'https://registry.aha-agent.dev/ext-a',
        m1,
      );
      await installer.install(
        'https://registry.aha-agent.dev/ext-b',
        m2,
      );

      const list = installer.listExtensions();
      expect(list).toHaveLength(2);
      expect(list.map((e) => e.id)).toContain('ext-a');
      expect(list.map((e) => e.id)).toContain('ext-b');
    });
  });

  describe('setEnabled', () => {
    it('should toggle extension enabled state', async () => {
      const manifest = createValidManifest();
      await installer.install(
        'https://registry.aha-agent.dev/test-extension',
        manifest,
      );

      expect(installer.setEnabled('test-extension', false)).toBe(true);
      expect(installer.getExtension('test-extension')?.enabled).toBe(false);

      expect(installer.setEnabled('test-extension', true)).toBe(true);
      expect(installer.getExtension('test-extension')?.enabled).toBe(true);
    });

    it('should return false for non-existent extension', () => {
      expect(installer.setEnabled('nonexistent', true)).toBe(false);
    });
  });
});
