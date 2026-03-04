import path from 'node:path';

/**
 * Check whether targetPath is inside the given workspace directory.
 * Both paths are resolved to absolute before comparison.
 */
export function isPathInWorkspace(targetPath: string, workspace: string): boolean {
  const resolved = path.resolve(targetPath);
  const resolvedWorkspace = path.resolve(workspace);
  // The resolved path must start with the workspace path followed by a separator
  // or be exactly the workspace path itself.
  return resolved === resolvedWorkspace || resolved.startsWith(resolvedWorkspace + path.sep);
}

/**
 * Check whether a path contains traversal sequences (`..`).
 */
export function hasPathTraversal(targetPath: string): boolean {
  // Normalise separators to forward-slash for uniform detection
  const normalised = targetPath.replace(/\\/g, '/');
  const segments = normalised.split('/');
  return segments.some((seg) => seg === '..');
}
