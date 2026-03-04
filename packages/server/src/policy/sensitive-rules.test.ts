import { describe, it, expect } from 'vitest';
import { isSensitivePath } from './sensitive-rules.js';

describe('isSensitivePath', () => {
  it('should match .env', () => {
    expect(isSensitivePath('/project/.env')).toBe(true);
  });

  it('should match .env.local', () => {
    expect(isSensitivePath('/project/.env.local')).toBe(true);
  });

  it('should match .env.production', () => {
    expect(isSensitivePath('/project/.env.production')).toBe(true);
  });

  it('should match *.pem files', () => {
    expect(isSensitivePath('/project/certs/server.pem')).toBe(true);
  });

  it('should match *.key files', () => {
    expect(isSensitivePath('/project/ssl/private.key')).toBe(true);
  });

  it('should match id_rsa', () => {
    expect(isSensitivePath('/home/user/.ssh/id_rsa')).toBe(true);
  });

  it('should match id_rsa.pub', () => {
    expect(isSensitivePath('/home/user/.ssh/id_rsa.pub')).toBe(true);
  });

  it('should match .ssh/ directory contents', () => {
    expect(isSensitivePath('/home/user/.ssh/config')).toBe(true);
  });

  it('should match .npmrc', () => {
    expect(isSensitivePath('/project/.npmrc')).toBe(true);
  });

  it('should match secrets.yaml', () => {
    expect(isSensitivePath('/project/secrets.yaml')).toBe(true);
  });

  it('should match secrets.json', () => {
    expect(isSensitivePath('/project/secrets.json')).toBe(true);
  });

  it('should not match normal source files', () => {
    expect(isSensitivePath('/project/src/index.ts')).toBe(false);
  });

  it('should not match README.md', () => {
    expect(isSensitivePath('/project/README.md')).toBe(false);
  });

  it('should not match package.json', () => {
    expect(isSensitivePath('/project/package.json')).toBe(false);
  });

  it('should not match environment.ts (not .env)', () => {
    expect(isSensitivePath('/project/src/environment.ts')).toBe(false);
  });
});
