import crypto from 'node:crypto';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { eq, sql } from 'drizzle-orm';
import type { AppDatabase } from '../db/client.js';
import { memories } from '../db/schema.js';
import { recallMemories, type RecallOptions } from './recall.js';

export interface MemoryEntry {
  id: string;
  content: string;
  category: 'preference' | 'fact' | 'skill' | 'context';
  sensitivity: 'public' | 'restricted' | 'secret';
  accessCount: number;
  lastAccessedAt: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

const CREATE_MEMORIES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    category TEXT NOT NULL,
    sensitivity TEXT NOT NULL DEFAULT 'public',
    access_count INTEGER NOT NULL DEFAULT 0,
    last_accessed_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    metadata TEXT
  );
`;

export class MemoryController {
  /** Short-term: in-memory session cache */
  private sessionCache: Map<string, MemoryEntry>;
  /** Long-term: SQLite via drizzle */
  private db: AppDatabase;
  private sqlite: SqliteDatabase;

  constructor(db: AppDatabase, sqlite: SqliteDatabase) {
    this.db = db;
    this.sqlite = sqlite;
    this.sessionCache = new Map();
  }

  /** Create the memories table if it does not already exist. */
  initSchema(): void {
    this.sqlite.exec(CREATE_MEMORIES_TABLE_SQL);
  }

  /** Store a new memory. Returns the created MemoryEntry with auto-generated id and timestamps. */
  store(
    entry: Omit<MemoryEntry, 'id' | 'accessCount' | 'lastAccessedAt' | 'createdAt'>,
  ): MemoryEntry {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    const memoryEntry: MemoryEntry = {
      id,
      content: entry.content,
      category: entry.category,
      sensitivity: entry.sensitivity,
      accessCount: 0,
      lastAccessedAt: now,
      createdAt: now,
      ...(entry.metadata != null ? { metadata: entry.metadata } : {}),
    };

    this.db
      .insert(memories)
      .values({
        id: memoryEntry.id,
        content: memoryEntry.content,
        category: memoryEntry.category,
        sensitivity: memoryEntry.sensitivity,
        accessCount: memoryEntry.accessCount,
        lastAccessedAt: memoryEntry.lastAccessedAt,
        createdAt: memoryEntry.createdAt,
        updatedAt: now,
        metadata: entry.metadata != null ? JSON.stringify(entry.metadata) : null,
      })
      .run();

    return memoryEntry;
  }

  /**
   * Recall memories by relevance (TopK, non-sensitive only).
   * Uses keyword-based scoring. Increments accessCount and updates lastAccessedAt on results.
   */
  recall(query: string, options?: RecallOptions): MemoryEntry[] {
    // Load all memories from DB
    const rows = this.db.select().from(memories).all();
    const allMemories = rows.map((row) => this.rowToEntry(row));

    // Apply recall strategy
    const results = recallMemories(allMemories, query, options);

    // Update access count and lastAccessedAt for returned memories
    const now = new Date().toISOString();
    for (const mem of results) {
      mem.accessCount++;
      mem.lastAccessedAt = now;
      this.db
        .update(memories)
        .set({
          accessCount: sql`${memories.accessCount} + 1`,
          lastAccessedAt: now,
        })
        .where(eq(memories.id, mem.id))
        .run();
    }

    return results;
  }

  /** Get a memory by ID. Returns null if not found. */
  get(id: string): MemoryEntry | null {
    const row = this.db.select().from(memories).where(eq(memories.id, id)).get();
    if (!row) return null;
    return this.rowToEntry(row);
  }

  /** Update a memory. Returns the updated entry or null if not found. */
  update(
    id: string,
    updates: Partial<Pick<MemoryEntry, 'content' | 'category' | 'sensitivity' | 'metadata'>>,
  ): MemoryEntry | null {
    const existing = this.get(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const setValues: Record<string, unknown> = { updatedAt: now };

    if (updates.content !== undefined) {
      setValues['content'] = updates.content;
    }
    if (updates.category !== undefined) {
      setValues['category'] = updates.category;
    }
    if (updates.sensitivity !== undefined) {
      setValues['sensitivity'] = updates.sensitivity;
    }
    if (updates.metadata !== undefined) {
      setValues['metadata'] = JSON.stringify(updates.metadata);
    }

    this.db.update(memories).set(setValues).where(eq(memories.id, id)).run();

    return this.get(id);
  }

  /** Delete a memory by ID. Returns true if the memory was found and deleted. */
  delete(id: string): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    this.db.delete(memories).where(eq(memories.id, id)).run();
    return true;
  }

  /** Add a memory to the in-memory session cache. */
  cacheToSession(entry: MemoryEntry): void {
    this.sessionCache.set(entry.id, entry);
  }

  /** Return all entries currently in the session cache. */
  getSessionCache(): MemoryEntry[] {
    return Array.from(this.sessionCache.values());
  }

  /** Clear the in-memory session cache. */
  clearSessionCache(): void {
    this.sessionCache.clear();
  }

  /**
   * Summarize the current session by compacting short-term memories into a single 'context' memory.
   * Clears the session cache after summarizing.
   */
  summarizeSession(summary: string): MemoryEntry {
    const entry = this.store({
      content: summary,
      category: 'context',
      sensitivity: 'public',
    });
    this.clearSessionCache();
    return entry;
  }

  /**
   * Evict least valuable memories until total count <= maxEntries.
   * Value score = accessCount / (daysSinceLastAccess + 1).
   * Memories with the lowest value score are evicted first.
   * Returns the count of evicted entries.
   */
  evict(maxEntries: number): number {
    const rows = this.db.select().from(memories).all();
    const total = rows.length;

    if (total <= maxEntries) return 0;

    const now = Date.now();
    const scored = rows.map((row) => {
      const lastAccessed = new Date(row.lastAccessedAt).getTime();
      const daysSinceLastAccess = (now - lastAccessed) / (1000 * 60 * 60 * 24);
      const valueScore = row.accessCount / (daysSinceLastAccess + 1);
      return { id: row.id, valueScore };
    });

    // Sort by value score ascending (lowest value first = evict first)
    scored.sort((a, b) => a.valueScore - b.valueScore);

    const toEvict = total - maxEntries;
    const evictIds = scored.slice(0, toEvict).map((s) => s.id);

    for (const evictId of evictIds) {
      this.db.delete(memories).where(eq(memories.id, evictId)).run();
    }

    return evictIds.length;
  }

  /** Convert a database row to a MemoryEntry. */
  private rowToEntry(row: typeof memories.$inferSelect): MemoryEntry {
    return {
      id: row.id,
      content: row.content,
      category: row.category as MemoryEntry['category'],
      sensitivity: row.sensitivity as MemoryEntry['sensitivity'],
      accessCount: row.accessCount,
      lastAccessedAt: row.lastAccessedAt,
      createdAt: row.createdAt,
      ...(row.metadata != null ? { metadata: JSON.parse(row.metadata) } : {}),
    };
  }
}
