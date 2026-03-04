import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditLogger } from './audit-logger.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aha-audit-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('AuditLogger', () => {
  it('should create log directory if it does not exist', () => {
    const nested = path.join(tmpDir, 'a', 'b', 'c');
    new AuditLogger(nested);
    expect(fs.existsSync(nested)).toBe(true);
  });

  describe('audit()', () => {
    it('should write structured JSON entry with correct fields', () => {
      const logger = new AuditLogger(tmpDir);
      logger.audit({
        traceId: 'trace-1',
        taskId: 'task-1',
        actor: 'user:alice',
        action: 'file.write',
        result: 'success',
        details: { path: '/tmp/test.txt' },
      });

      const logFile = path.join(tmpDir, 'aha-audit.log');
      expect(fs.existsSync(logFile)).toBe(true);

      const line = fs.readFileSync(logFile, 'utf-8').trim();
      const parsed: Record<string, unknown> = JSON.parse(line) as Record<string, unknown>;

      expect(parsed).toHaveProperty('timestamp');
      expect(parsed.traceId).toBe('trace-1');
      expect(parsed.taskId).toBe('task-1');
      expect(parsed.actor).toBe('user:alice');
      expect(parsed.action).toBe('file.write');
      expect(parsed.result).toBe('success');
      expect(parsed.details).toEqual({ path: '/tmp/test.txt' });
    });
  });

  describe('info()', () => {
    it('should write to aha-info.log with level info', () => {
      const logger = new AuditLogger(tmpDir);
      logger.info('Server started', { port: 3000 });

      const logFile = path.join(tmpDir, 'aha-info.log');
      expect(fs.existsSync(logFile)).toBe(true);

      const line = fs.readFileSync(logFile, 'utf-8').trim();
      const parsed: Record<string, unknown> = JSON.parse(line) as Record<string, unknown>;

      expect(parsed).toHaveProperty('timestamp');
      expect(parsed.level).toBe('info');
      expect(parsed.message).toBe('Server started');
      expect(parsed.port).toBe(3000);
    });
  });

  describe('error()', () => {
    it('should write to aha-error.log with level error', () => {
      const logger = new AuditLogger(tmpDir);
      logger.error('Connection failed', { code: 'ECONNREFUSED' });

      const logFile = path.join(tmpDir, 'aha-error.log');
      expect(fs.existsSync(logFile)).toBe(true);

      const line = fs.readFileSync(logFile, 'utf-8').trim();
      const parsed: Record<string, unknown> = JSON.parse(line) as Record<string, unknown>;

      expect(parsed).toHaveProperty('timestamp');
      expect(parsed.level).toBe('error');
      expect(parsed.message).toBe('Connection failed');
      expect(parsed.code).toBe('ECONNREFUSED');
    });
  });

  describe('sanitization', () => {
    it('should sanitize sensitive content in audit log output', () => {
      const logger = new AuditLogger(tmpDir);
      logger.audit({
        traceId: 'trace-2',
        actor: 'system',
        action: 'llm.call',
        result: 'success',
        details: { apiKey: 'sk-abcdefghij1234567890' },
      });

      const line = fs.readFileSync(path.join(tmpDir, 'aha-audit.log'), 'utf-8').trim();
      expect(line).not.toContain('sk-abcdefghij1234567890');
      expect(line).toContain('[REDACTED]');
    });

    it('should sanitize sensitive content in info log output', () => {
      const logger = new AuditLogger(tmpDir);
      logger.info('Auth header: Bearer eyJhbGciOiJIUzI1NiJ9.payload');

      const line = fs.readFileSync(path.join(tmpDir, 'aha-info.log'), 'utf-8').trim();
      expect(line).not.toContain('eyJ');
      expect(line).toContain('[REDACTED]');
    });

    it('should sanitize sensitive content in error log output', () => {
      const logger = new AuditLogger(tmpDir);
      logger.error('Failed with key sk-secretkey1234567890');

      const line = fs.readFileSync(path.join(tmpDir, 'aha-error.log'), 'utf-8').trim();
      expect(line).not.toContain('sk-secretkey1234567890');
      expect(line).toContain('[REDACTED]');
    });
  });
});
