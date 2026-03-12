import crypto from 'node:crypto';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { eq, sql } from 'drizzle-orm';
import type { AppDatabase } from '../db/client.js';
import { memories, memoryEmbeddings } from '../db/schema.js';
import {
  buildEmbeddingInput,
  cosineSimilarity,
  hashEmbeddingInput,
  type EmbeddingProvider,
} from './embedding.js';
import { recallWithFts, rerankMemories, type RecallOptions } from './recall.js';

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

export interface RankedMemoryEntry extends MemoryEntry {
  score?: number;
}

const SENSITIVITY_WEIGHT: Record<MemoryEntry['sensitivity'], number> = {
  public: 0,
  restricted: 1,
  secret: 2,
};

function normalizeMemoryContent(content: string): string {
  return content
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
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

const CREATE_MEMORIES_FTS_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content,
    id UNINDEXED,
    category UNINDEXED,
    sensitivity UNINDEXED,
    tokenize='trigram'
  );
`;

const CREATE_MEMORY_EMBEDDINGS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS memory_embeddings (
    memory_id TEXT PRIMARY KEY REFERENCES memories(id),
    embedding_model TEXT NOT NULL,
    embedding_dim INTEGER NOT NULL,
    embedding_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

interface MemoryControllerOptions {
  embeddingProvider?: EmbeddingProvider;
}

interface VectorCandidateRow {
  id: string;
  content: string;
  category: string;
  sensitivity: string;
  access_count: number;
  last_accessed_at: string;
  created_at: string;
  metadata: string | null;
  embedding_json: string;
}

export class MemoryController {
  /** Short-term: in-memory session cache */
  private sessionCache: Map<string, MemoryEntry>;
  /** Long-term: SQLite via drizzle */
  private db: AppDatabase;
  private sqlite: SqliteDatabase;
  private embeddingProvider?: EmbeddingProvider;
  private pendingEmbeddingJobs = new Set<Promise<void>>();

  constructor(db: AppDatabase, sqlite: SqliteDatabase, options: MemoryControllerOptions = {}) {
    this.db = db;
    this.sqlite = sqlite;
    this.sessionCache = new Map();
    this.embeddingProvider = options.embeddingProvider;
  }

  /** Create the memories table and FTS5 index if they do not already exist. */
  initSchema(): void {
    this.sqlite.exec(CREATE_MEMORIES_TABLE_SQL);
    this.sqlite.exec(CREATE_MEMORIES_FTS_SQL);
    this.sqlite.exec(CREATE_MEMORY_EMBEDDINGS_TABLE_SQL);
  }

  /** Store a new memory. Returns the created MemoryEntry with auto-generated id and timestamps. */
  store(
    entry: Omit<MemoryEntry, 'id' | 'accessCount' | 'lastAccessedAt' | 'createdAt'>,
  ): MemoryEntry {
    const duplicate = this.findDuplicate(entry);
    if (duplicate) {
      const mergedMetadata = {
        ...(duplicate.metadata ?? {}),
        ...(entry.metadata ?? {}),
      };
      const upgradedSensitivity =
        SENSITIVITY_WEIGHT[entry.sensitivity] > SENSITIVITY_WEIGHT[duplicate.sensitivity]
          ? entry.sensitivity
          : duplicate.sensitivity;

      const updated = this.update(duplicate.id, {
        content: entry.content.trim(),
        sensitivity: upgradedSensitivity,
        metadata: Object.keys(mergedMetadata).length > 0 ? mergedMetadata : undefined,
      });

      if (updated) {
        return updated;
      }
    }

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

    // Sync to FTS index
    this.sqlite
      .prepare('INSERT INTO memories_fts(content, id, category, sensitivity) VALUES (?, ?, ?, ?)')
      .run(memoryEntry.content, memoryEntry.id, memoryEntry.category, memoryEntry.sensitivity);

    this.scheduleEmbeddingSync(memoryEntry);

    return memoryEntry;
  }

  /**
   * Recall memories by relevance (TopK, non-sensitive only).
   * Uses FTS5 BM25 ranking. Increments accessCount and updates lastAccessedAt on results.
   */
  recall(query: string, options?: RecallOptions): MemoryEntry[] {
    const rows = recallWithFts(this.sqlite, query, options);
    return this.materializeAndTouchResults(query, rows, new Map());
  }

  async recallHybrid(query: string, options?: RecallOptions): Promise<MemoryEntry[]> {
    const rows = recallWithFts(this.sqlite, query, options);
    if (!this.embeddingProvider || query.trim().length === 0) {
      return this.materializeAndTouchResults(query, rows, new Map());
    }

    const vectorScores = await this.computeVectorScores(query, options);
    if (vectorScores.size === 0) {
      return this.materializeAndTouchResults(query, rows, new Map());
    }

    const baseRanks = new Map<string, number>();
    const entries = new Map<string, MemoryEntry>();

    for (const row of rows) {
      baseRanks.set(row.id, row.rank);
      const entry = this.get(row.id);
      if (entry) {
        entries.set(entry.id, entry);
      }
    }

    for (const id of vectorScores.keys()) {
      const entry = this.get(id);
      if (entry) {
        entries.set(entry.id, entry);
      }
    }

    const ranked = rerankMemories(query, [...entries.values()], baseRanks, vectorScores);
    const topK = Math.max(1, options?.topK ?? 5);
    return this.touchResults(ranked.slice(0, topK));
  }

  list(options?: {
    query?: string;
    category?: MemoryEntry['category'];
    sensitivity?: MemoryEntry['sensitivity'];
    limit?: number;
  }): RankedMemoryEntry[] {
    const limit = Math.max(1, Math.min(200, options?.limit ?? 50));

    if (options?.query?.trim()) {
      return this.recall(options.query, {
        topK: limit,
        includeRestricted: options.sensitivity === 'restricted',
        category: options.category,
      }).filter((entry) =>
        options?.sensitivity ? entry.sensitivity === options.sensitivity : true,
      );
    }

    const rows = this.db.select().from(memories).all();
    return rows
      .map((row) => this.rowToEntry(row))
      .filter((entry) => (options?.category ? entry.category === options.category : true))
      .filter((entry) => (options?.sensitivity ? entry.sensitivity === options.sensitivity : true))
      .sort((a, b) => {
        const aTime = new Date(a.lastAccessedAt).getTime();
        const bTime = new Date(b.lastAccessedAt).getTime();
        return bTime - aTime;
      })
      .slice(0, limit);
  }

  async awaitIdle(): Promise<void> {
    if (this.pendingEmbeddingJobs.size === 0) {
      return;
    }
    await Promise.all([...this.pendingEmbeddingJobs]);
  }

  isEmbeddingEnabled(): boolean {
    return this.embeddingProvider != null;
  }

  getEmbeddingCount(): number {
    const row = this.sqlite
      .prepare('SELECT COUNT(*) AS count FROM memory_embeddings')
      .get() as { count: number };
    return row.count;
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

    // Sync FTS index on content/category/sensitivity changes
    if (updates.content !== undefined || updates.category !== undefined || updates.sensitivity !== undefined) {
      this.sqlite.prepare('DELETE FROM memories_fts WHERE id = ?').run(id);
      const updated = this.get(id)!;
      this.sqlite
        .prepare('INSERT INTO memories_fts(content, id, category, sensitivity) VALUES (?, ?, ?, ?)')
        .run(updated.content, updated.id, updated.category, updated.sensitivity);
    }

    const updated = this.get(id);
    if (updated) {
      this.scheduleEmbeddingSync(updated);
    }

    return updated;
  }

  /** Delete a memory by ID. Returns true if the memory was found and deleted. */
  delete(id: string): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    // Sync FTS index before deleting
    this.sqlite.prepare('DELETE FROM memories_fts WHERE id = ?').run(id);
    this.sqlite.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?').run(id);
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
      // Sync FTS index before deleting
      this.sqlite.prepare('DELETE FROM memories_fts WHERE id = ?').run(evictId);
      this.sqlite.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?').run(evictId);
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

  private materializeAndTouchResults(
    query: string,
    rows: Array<{ id: string; rank: number }>,
    vectorScores: Map<string, number>,
  ): MemoryEntry[] {
    const baseRanks = new Map<string, number>();
    const results: MemoryEntry[] = [];

    for (const row of rows) {
      baseRanks.set(row.id, row.rank);
      const entry = this.get(row.id);
      if (entry) {
        results.push(entry);
      }
    }

    return this.touchResults(rerankMemories(query, results, baseRanks, vectorScores));
  }

  private touchResults(results: MemoryEntry[]): MemoryEntry[] {
    const now = new Date().toISOString();
    const touched: MemoryEntry[] = [];

    for (const entry of results) {
      this.db
        .update(memories)
        .set({
          accessCount: sql`${memories.accessCount} + 1`,
          lastAccessedAt: now,
        })
        .where(eq(memories.id, entry.id))
        .run();

      touched.push({
        ...entry,
        accessCount: entry.accessCount + 1,
        lastAccessedAt: now,
      });
    }

    return touched;
  }

  private findDuplicate(
    entry: Omit<MemoryEntry, 'id' | 'accessCount' | 'lastAccessedAt' | 'createdAt'>,
  ): MemoryEntry | null {
    const normalized = normalizeMemoryContent(entry.content);
    if (!normalized) return null;

    const rows = this.db.select().from(memories).all();
    for (const row of rows) {
      if (row.category !== entry.category) {
        continue;
      }
      if (normalizeMemoryContent(row.content) === normalized) {
        return this.rowToEntry(row);
      }
    }
    return null;
  }

  private scheduleEmbeddingSync(entry: Pick<MemoryEntry, 'id' | 'content' | 'category' | 'sensitivity'>): void {
    if (!this.embeddingProvider) {
      return;
    }

    const job = this.syncEmbedding(entry).catch((error: unknown) => {
      console.warn('Failed to sync memory embedding', {
        memoryId: entry.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    this.pendingEmbeddingJobs.add(job);
    void job.finally(() => {
      this.pendingEmbeddingJobs.delete(job);
    });
  }

  private async syncEmbedding(
    entry: Pick<MemoryEntry, 'id' | 'content' | 'category' | 'sensitivity'>,
  ): Promise<void> {
    if (!this.embeddingProvider) {
      return;
    }

    if (entry.sensitivity === 'secret') {
      this.sqlite.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?').run(entry.id);
      return;
    }

    const embeddingInput = buildEmbeddingInput(entry.category, entry.content);
    const contentHash = hashEmbeddingInput(embeddingInput);
    const existing = this.sqlite
      .prepare('SELECT content_hash AS contentHash FROM memory_embeddings WHERE memory_id = ?')
      .get(entry.id) as { contentHash: string } | undefined;

    if (existing?.contentHash === contentHash) {
      return;
    }

    const vectors = await this.embeddingProvider.embed([embeddingInput]);
    const vector = vectors[0];
    if (!vector || vector.length === 0) {
      return;
    }

    const now = new Date().toISOString();
    this.db
      .insert(memoryEmbeddings)
      .values({
        memoryId: entry.id,
        embeddingModel: this.embeddingProvider.model,
        embeddingDim: vector.length,
        embeddingJson: JSON.stringify(vector),
        contentHash,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: memoryEmbeddings.memoryId,
        set: {
          embeddingModel: this.embeddingProvider.model,
          embeddingDim: vector.length,
          embeddingJson: JSON.stringify(vector),
          contentHash,
          updatedAt: now,
        },
      })
      .run();
  }

  private async computeVectorScores(
    query: string,
    options?: RecallOptions,
  ): Promise<Map<string, number>> {
    if (!this.embeddingProvider) {
      return new Map();
    }

    const vectors = await this.embeddingProvider.embed([
      buildEmbeddingInput(options?.category ?? 'context', query),
    ]);
    const queryVector = vectors[0];
    if (!queryVector || queryVector.length === 0) {
      return new Map();
    }

    const conditions: string[] = ["m.sensitivity != 'secret'"];
    const params: Array<string | number> = [];
    if (!options?.includeRestricted) {
      conditions.push("m.sensitivity != 'restricted'");
    }
    if (options?.category) {
      conditions.push('m.category = ?');
      params.push(options.category);
    }

    const rows = this.sqlite
      .prepare(
        `
          SELECT
            m.id,
            m.content,
            m.category,
            m.sensitivity,
            m.access_count,
            m.last_accessed_at,
            m.created_at,
            m.metadata,
            me.embedding_json
          FROM memories AS m
          JOIN memory_embeddings AS me ON me.memory_id = m.id
          WHERE ${conditions.join(' AND ')}
        `,
      )
      .all(...params) as VectorCandidateRow[];

    const ranked = rows
      .map((row) => ({
        id: row.id,
        score: cosineSimilarity(queryVector, JSON.parse(row.embedding_json) as number[]),
      }))
      .filter((row) => row.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(5, (options?.topK ?? 5) * 3));

    return new Map(ranked.map((row) => [row.id, row.score]));
  }
}
