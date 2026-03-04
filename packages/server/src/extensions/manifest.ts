export interface ExtensionPermission {
  type: 'file_read' | 'file_write' | 'network' | 'command' | 'directory';
  scope: string; // glob pattern or specific resource
}

export interface ExtensionManifest {
  name: string;
  version: string;
  description: string;
  author: string;
  entry: string; // relative path to main script
  permissions: ExtensionPermission[];
  checksum: string; // SHA-256 hex
  signature?: string; // base64 encoded signature
}

export interface ExtensionTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
}

export interface ExtensionMetadata {
  id: string;
  manifest: ExtensionManifest;
  installPath: string;
  enabled: boolean;
  status: 'installed' | 'running' | 'stopped' | 'failed';
  lastHealthCheck?: string;
  tools: ExtensionTool[];
}

/**
 * Simple semver-like check: allows x.y.z patterns where x, y, z are non-negative integers.
 */
const SEMVER_REGEX = /^\d+\.\d+\.\d+$/;

/**
 * SHA-256 hex string: exactly 64 hex characters.
 */
const CHECKSUM_REGEX = /^[0-9a-f]{64}$/;

/**
 * Validate an unknown value as an ExtensionManifest.
 * Returns whether the value is valid and any validation errors found.
 */
export function validateManifest(data: unknown): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (data === null || data === undefined || typeof data !== 'object') {
    return { valid: false, errors: ['Manifest must be a non-null object'] };
  }

  const obj = data as Record<string, unknown>;

  // name: non-empty string
  if (typeof obj['name'] !== 'string' || obj['name'].trim() === '') {
    errors.push('name must be a non-empty string');
  }

  // version: semver-like
  if (
    typeof obj['version'] !== 'string' ||
    !SEMVER_REGEX.test(obj['version'])
  ) {
    errors.push('version must be a valid semver string (e.g. 1.0.0)');
  }

  // entry: non-empty string
  if (typeof obj['entry'] !== 'string' || obj['entry'].trim() === '') {
    errors.push('entry must be a non-empty string');
  }

  // permissions: array
  if (!Array.isArray(obj['permissions'])) {
    errors.push('permissions must be an array');
  }

  // checksum: 64-char hex string
  if (
    typeof obj['checksum'] !== 'string' ||
    !CHECKSUM_REGEX.test(obj['checksum'])
  ) {
    errors.push('checksum must be a 64-character hex string');
  }

  return { valid: errors.length === 0, errors };
}
