import { describe, it, expect } from 'vitest';
import { isPathInWorkspace, hasPathTraversal } from './path-rules.js';

describe('isPathInWorkspace', () => {
  it('should allow a file directly inside the workspace', () => {
    expect(isPathInWorkspace('/workspace/project/file.ts', '/workspace/project')).toBe(true);
  });

  it('should allow a file in a sub-directory of the workspace', () => {
    expect(isPathInWorkspace('/workspace/project/src/index.ts', '/workspace/project')).toBe(true);
  });

  it('should allow the workspace root itself', () => {
    expect(isPathInWorkspace('/workspace/project', '/workspace/project')).toBe(true);
  });

  it('should deny a path outside the workspace', () => {
    expect(isPathInWorkspace('/other/dir/file.ts', '/workspace/project')).toBe(false);
  });

  it('should deny a sibling directory with a matching prefix', () => {
    // /workspace/project-extra should NOT be inside /workspace/project
    expect(isPathInWorkspace('/workspace/project-extra/file.ts', '/workspace/project')).toBe(false);
  });

  it('should deny a parent of the workspace', () => {
    expect(isPathInWorkspace('/workspace', '/workspace/project')).toBe(false);
  });
});

describe('hasPathTraversal', () => {
  it('should detect ".." in the middle of a path', () => {
    expect(hasPathTraversal('/workspace/project/../../../etc/passwd')).toBe(true);
  });

  it('should detect ".." at the start of a relative path', () => {
    expect(hasPathTraversal('../secret.txt')).toBe(true);
  });

  it('should detect ".." with backslashes', () => {
    expect(hasPathTraversal('C:\\workspace\\..\\secret')).toBe(true);
  });

  it('should not flag normal paths', () => {
    expect(hasPathTraversal('/workspace/project/src/index.ts')).toBe(false);
  });

  it('should not flag dots in filenames', () => {
    expect(hasPathTraversal('/workspace/.env.local')).toBe(false);
    expect(hasPathTraversal('/workspace/file..name.txt')).toBe(false);
  });

  it('should not flag single dot segments', () => {
    expect(hasPathTraversal('/workspace/./src/index.ts')).toBe(false);
  });
});
