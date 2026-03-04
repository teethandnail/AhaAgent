import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { type Sensitivity } from '@aha-agent/shared';

/**
 * Patterns that classify a file as 'secret'.
 * Matching is done against the basename and full path segments.
 */
const SECRET_PATTERNS: RegExp[] = [
  /^\.env($|\.)/, // .env, .env.local, .env.production, etc.
  /\.pem$/,
  /\.key$/,
  /^id_rsa/,
  /^\.npmrc$/,
  /^secrets\./,
];

const SECRET_DIR_SEGMENTS = ['.ssh'];

export class Sandbox {
  private workspaceRealpaths: string[] | undefined;
  private readonly workspaces: string[];

  constructor(workspaces: string[]) {
    this.workspaces = workspaces;
  }

  /**
   * Lazily resolve workspace paths to their real (canonical) paths.
   */
  private async getWorkspaceRealpaths(): Promise<string[]> {
    if (this.workspaceRealpaths) {
      return this.workspaceRealpaths;
    }
    this.workspaceRealpaths = await Promise.all(
      this.workspaces.map((w) => fs.realpath(path.resolve(w))),
    );
    return this.workspaceRealpaths;
  }

  /**
   * Validate that a target path resides within one of the allowed workspaces.
   *
   * - Resolves the path (handles relative components).
   * - For existing paths: follows symlinks via realpath and compares.
   * - For non-existing paths (e.g. write targets): checks the parent directory.
   * - Rejects symlinks that escape the workspace.
   * - Rejects path traversal attempts.
   */
  async validatePath(targetPath: string): Promise<boolean> {
    const resolved = path.resolve(targetPath);
    const workspaces = await this.getWorkspaceRealpaths();

    try {
      // Path exists -- resolve to its real path (follows symlinks)
      const real = await fs.realpath(resolved);
      return workspaces.some(
        (ws) => real === ws || real.startsWith(ws + path.sep),
      );
    } catch {
      // Path does not exist -- check parent directory
      const parentDir = path.dirname(resolved);
      try {
        const parentReal = await fs.realpath(parentDir);
        return workspaces.some(
          (ws) =>
            parentReal === ws || parentReal.startsWith(ws + path.sep),
        );
      } catch {
        // Parent doesn't exist either -- reject
        return false;
      }
    }
  }

  /**
   * Classify a file path's sensitivity based on its name and path segments.
   */
  classifySensitivity(filePath: string): Sensitivity {
    const basename = path.basename(filePath);
    const segments = filePath.split(path.sep);

    // Check directory segments for secret directories
    for (const segment of segments) {
      if (SECRET_DIR_SEGMENTS.includes(segment)) {
        return 'secret';
      }
    }

    // Check basename against secret patterns
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(basename)) {
        return 'secret';
      }
    }

    return 'public';
  }
}
