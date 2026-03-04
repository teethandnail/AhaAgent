import Database, { type Database as SqliteDatabase } from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

export function createDatabase(dbPath: string): { db: ReturnType<typeof drizzle<typeof schema>>; sqlite: SqliteDatabase } {
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

export type AppDatabase = ReturnType<typeof createDatabase>['db'];
