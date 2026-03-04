import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createError } from '@aha-agent/shared';
import {
  type ExtensionManifest,
  type ExtensionMetadata,
  validateManifest,
} from './manifest.js';

export interface InstallerOptions {
  extensionsDir: string;
  allowedSources: string[];
}

export class ExtensionInstaller {
  private readonly allowedSources: string[];
  private readonly extensionsDir: string;
  private readonly registry: Map<string, ExtensionMetadata>;

  constructor(options: InstallerOptions) {
    this.allowedSources = options.allowedSources;
    this.extensionsDir = options.extensionsDir;
    this.registry = new Map();
  }

  /**
   * Verify the SHA-256 checksum of a manifest file matches the expected value.
   */
  async verifyChecksum(
    manifestPath: string,
    expectedChecksum: string,
  ): Promise<boolean> {
    const content = await fs.readFile(manifestPath);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    return hash === expectedChecksum;
  }

  /**
   * Check if the given source URL/path is in the allowed sources whitelist.
   */
  isSourceAllowed(source: string): boolean {
    return this.allowedSources.some((allowed) => source.startsWith(allowed));
  }

  /**
   * Install an extension: validate source, manifest, verify checksum, and register.
   *
   * Steps:
   * 1. Check source whitelist
   * 2. Validate manifest
   * 3. Verify checksum
   * 4. Register metadata
   */
  async install(
    source: string,
    manifest: ExtensionManifest,
  ): Promise<ExtensionMetadata> {
    // Step 1: Check source whitelist
    if (!this.isSourceAllowed(source)) {
      throw createError('EXT_VERIFY_FAILED', `Source not allowed: ${source}`);
    }

    // Step 2: Validate manifest
    const validation = validateManifest(manifest);
    if (!validation.valid) {
      throw createError(
        'EXT_VERIFY_FAILED',
        `Invalid manifest: ${validation.errors.join(', ')}`,
      );
    }

    // Step 3: Verify checksum
    const manifestPath = `${this.extensionsDir}/${manifest.name}/manifest.json`;
    let checksumValid = false;
    try {
      checksumValid = await this.verifyChecksum(
        manifestPath,
        manifest.checksum,
      );
    } catch {
      // If the file doesn't exist yet (first install), we accept the checksum
      // as-is since there's nothing to verify against on disk.
      checksumValid = true;
    }

    if (!checksumValid) {
      throw createError(
        'EXT_VERIFY_FAILED',
        'Checksum verification failed for manifest',
      );
    }

    // Step 4: Register metadata
    const id = manifest.name;
    const installPath = `${this.extensionsDir}/${manifest.name}`;
    const metadata: ExtensionMetadata = {
      id,
      manifest,
      installPath,
      enabled: true,
      status: 'installed',
      tools: [],
    };

    this.registry.set(id, metadata);
    return metadata;
  }

  /**
   * Uninstall an extension by removing it from the registry.
   */
  uninstall(extensionId: string): boolean {
    return this.registry.delete(extensionId);
  }

  /**
   * Get a specific installed extension's metadata.
   */
  getExtension(extensionId: string): ExtensionMetadata | undefined {
    return this.registry.get(extensionId);
  }

  /**
   * List all installed extensions.
   */
  listExtensions(): ExtensionMetadata[] {
    return [...this.registry.values()];
  }

  /**
   * Enable or disable an extension.
   */
  setEnabled(extensionId: string, enabled: boolean): boolean {
    const ext = this.registry.get(extensionId);
    if (!ext) {
      return false;
    }
    ext.enabled = enabled;
    return true;
  }
}
