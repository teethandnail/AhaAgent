import fs from 'node:fs';
import path from 'node:path';
import { sanitize } from './sanitizer.js';

export interface AuditEntry {
  traceId: string;
  taskId?: string;
  requestId?: string;
  actor: string;
  action: string;
  result: string;
  details?: Record<string, unknown>;
}

export class AuditLogger {
  private readonly logDir: string;

  constructor(logDir: string) {
    this.logDir = logDir;
    fs.mkdirSync(logDir, { recursive: true });
  }

  audit(entry: AuditEntry): void {
    const record = {
      timestamp: new Date().toISOString(),
      ...entry,
    };
    this.appendLine('aha-audit.log', record);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    const record = {
      timestamp: new Date().toISOString(),
      level: 'info' as const,
      message,
      ...meta,
    };
    this.appendLine('aha-info.log', record);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    const record = {
      timestamp: new Date().toISOString(),
      level: 'error' as const,
      message,
      ...meta,
    };
    this.appendLine('aha-error.log', record);
  }

  private appendLine(filename: string, record: Record<string, unknown>): void {
    const raw = JSON.stringify(record);
    const sanitized = sanitize(raw);
    fs.appendFileSync(path.join(this.logDir, filename), sanitized + '\n', 'utf-8');
  }
}
