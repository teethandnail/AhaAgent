import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema.js';
import { MemoryController } from './memory-controller.js';
import { buildFtsQuery } from './recall.js';

function createInMemoryDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

describe('MemoryController', () => {
  let sqlite: InstanceType<typeof Database>;
  let controller: MemoryController;

  beforeEach(() => {
    const result = createInMemoryDb();
    sqlite = result.sqlite;
    controller = new MemoryController(result.db, sqlite);
    controller.initSchema();
  });

  afterEach(() => {
    sqlite.close();
  });

  // --- initSchema ---

  it('initSchema creates memories table', () => {
    // initSchema already ran in beforeEach; calling again should be idempotent
    expect(() => controller.initSchema()).not.toThrow();

    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('memories');
  });

  // --- store ---

  it('store creates memory with auto-generated id and timestamps', () => {
    const entry = controller.store({
      content: 'User prefers dark mode',
      category: 'preference',
      sensitivity: 'public',
    });

    expect(entry.id).toBeDefined();
    expect(entry.id.length).toBeGreaterThan(0);
    expect(entry.content).toBe('User prefers dark mode');
    expect(entry.category).toBe('preference');
    expect(entry.sensitivity).toBe('public');
    expect(entry.accessCount).toBe(0);
    expect(entry.lastAccessedAt).toBeDefined();
    expect(entry.createdAt).toBeDefined();
  });

  it('store persists memory with correct sensitivity', () => {
    const entry = controller.store({
      content: 'API key location',
      category: 'fact',
      sensitivity: 'secret',
    });

    expect(entry.sensitivity).toBe('secret');
    const retrieved = controller.get(entry.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.sensitivity).toBe('secret');
  });

  // --- get ---

  it('get returns stored memory', () => {
    const stored = controller.store({
      content: 'TypeScript is preferred',
      category: 'preference',
      sensitivity: 'public',
      metadata: { source: 'user' },
    });

    const retrieved = controller.get(stored.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(stored.id);
    expect(retrieved!.content).toBe('TypeScript is preferred');
    expect(retrieved!.metadata).toEqual({ source: 'user' });
  });

  it('get returns null for unknown id', () => {
    const result = controller.get('nonexistent-id');
    expect(result).toBeNull();
  });

  // --- recall ---

  it('recall returns top-K public memories matching query', () => {
    controller.store({ content: 'User likes TypeScript', category: 'preference', sensitivity: 'public' });
    controller.store({ content: 'Project uses React', category: 'fact', sensitivity: 'public' });
    controller.store({ content: 'TypeScript strict mode enabled', category: 'fact', sensitivity: 'public' });
    controller.store({ content: 'Python is also available', category: 'fact', sensitivity: 'public' });

    const results = controller.recall('TypeScript');
    expect(results.length).toBeGreaterThanOrEqual(2);
    for (const r of results) {
      expect(r.content.toLowerCase()).toContain('typescript');
    }
  });

  it('recall excludes secret memories always', () => {
    controller.store({ content: 'Secret API key is abc123', category: 'fact', sensitivity: 'secret' });
    controller.store({ content: 'Public API endpoint', category: 'fact', sensitivity: 'public' });

    const results = controller.recall('API');
    expect(results.length).toBe(1);
    expect(results[0]!.sensitivity).toBe('public');
  });

  it('recall increments access count', () => {
    const stored = controller.store({
      content: 'User prefers vim keybindings',
      category: 'preference',
      sensitivity: 'public',
    });

    expect(stored.accessCount).toBe(0);

    controller.recall('vim');

    const updated = controller.get(stored.id);
    expect(updated).not.toBeNull();
    expect(updated!.accessCount).toBe(1);
  });

  it('recall with includeRestricted returns restricted memories', () => {
    controller.store({ content: 'Restricted internal docs path', category: 'fact', sensitivity: 'restricted' });
    controller.store({ content: 'Public docs path', category: 'fact', sensitivity: 'public' });

    // Without includeRestricted
    const publicOnly = controller.recall('docs');
    expect(publicOnly.length).toBe(1);
    expect(publicOnly[0]!.sensitivity).toBe('public');

    // With includeRestricted
    const withRestricted = controller.recall('docs', { includeRestricted: true });
    expect(withRestricted.length).toBe(2);
    const sensitivities = withRestricted.map((m) => m.sensitivity).sort();
    expect(sensitivities).toEqual(['public', 'restricted']);
  });

  // --- update ---

  it('update modifies memory fields', () => {
    const stored = controller.store({
      content: 'Original content',
      category: 'fact',
      sensitivity: 'public',
    });

    const updated = controller.update(stored.id, {
      content: 'Updated content',
      category: 'preference',
    });

    expect(updated).not.toBeNull();
    expect(updated!.content).toBe('Updated content');
    expect(updated!.category).toBe('preference');
    expect(updated!.sensitivity).toBe('public'); // unchanged
  });

  // --- delete ---

  it('delete removes memory', () => {
    const stored = controller.store({
      content: 'To be deleted',
      category: 'fact',
      sensitivity: 'public',
    });

    expect(controller.get(stored.id)).not.toBeNull();

    const result = controller.delete(stored.id);
    expect(result).toBe(true);
    expect(controller.get(stored.id)).toBeNull();
  });

  // --- session cache ---

  it('cacheToSession and getSessionCache work', () => {
    const entry = controller.store({
      content: 'Session item',
      category: 'context',
      sensitivity: 'public',
    });

    controller.cacheToSession(entry);
    const cached = controller.getSessionCache();

    expect(cached).toHaveLength(1);
    expect(cached[0]!.id).toBe(entry.id);
    expect(cached[0]!.content).toBe('Session item');
  });

  it('clearSessionCache clears cache', () => {
    const entry = controller.store({
      content: 'Temporary item',
      category: 'context',
      sensitivity: 'public',
    });

    controller.cacheToSession(entry);
    expect(controller.getSessionCache()).toHaveLength(1);

    controller.clearSessionCache();
    expect(controller.getSessionCache()).toHaveLength(0);
  });

  // --- summarizeSession ---

  it('summarizeSession creates a context memory', () => {
    const entry1 = controller.store({ content: 'Thing 1', category: 'fact', sensitivity: 'public' });
    const entry2 = controller.store({ content: 'Thing 2', category: 'fact', sensitivity: 'public' });

    controller.cacheToSession(entry1);
    controller.cacheToSession(entry2);
    expect(controller.getSessionCache()).toHaveLength(2);

    const summary = controller.summarizeSession('Session summary: discussed Thing 1 and Thing 2');

    expect(summary.content).toBe('Session summary: discussed Thing 1 and Thing 2');
    expect(summary.category).toBe('context');
    expect(summary.sensitivity).toBe('public');
    expect(summary.id).toBeDefined();

    // Session cache should be cleared after summarization
    expect(controller.getSessionCache()).toHaveLength(0);

    // Summary should be persisted in DB
    const retrieved = controller.get(summary.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.content).toBe('Session summary: discussed Thing 1 and Thing 2');
  });

  // --- evict ---

  it('evict removes lowest-value memories', () => {
    // Create 5 memories with unique, non-overlapping content
    const m1 = controller.store({ content: 'alpha', category: 'fact', sensitivity: 'public' });
    const m2 = controller.store({ content: 'bravo', category: 'fact', sensitivity: 'public' });
    const m3 = controller.store({ content: 'charlie', category: 'fact', sensitivity: 'public' });
    const m4 = controller.store({ content: 'delta', category: 'fact', sensitivity: 'public' });
    const m5 = controller.store({ content: 'echo', category: 'fact', sensitivity: 'public' });

    // Access m1 multiple times and m2, m3 once to increase their value scores
    controller.recall('alpha');
    controller.recall('alpha');
    controller.recall('alpha');
    controller.recall('bravo');
    controller.recall('charlie');

    // m4 and m5 have accessCount=0, lowest value scores
    // Evict down to 3
    const evictedCount = controller.evict(3);
    expect(evictedCount).toBe(2);

    // m1, m2, m3 should remain (highest value scores due to access)
    expect(controller.get(m1.id)).not.toBeNull();
    expect(controller.get(m2.id)).not.toBeNull();
    expect(controller.get(m3.id)).not.toBeNull();

    // m4 and m5 should have been evicted
    expect(controller.get(m4.id)).toBeNull();
    expect(controller.get(m5.id)).toBeNull();
  });

  // --- FTS5 schema ---

  it('initSchema creates memories_fts virtual table', () => {
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('memories_fts');
  });

  // --- FTS sync: store ---

  it('store syncs to FTS index', () => {
    controller.store({ content: 'TypeScript is great', category: 'fact', sensitivity: 'public' });

    const ftsRows = sqlite
      .prepare("SELECT id, content FROM memories_fts WHERE memories_fts MATCH '\"TypeScript\"'")
      .all() as Array<{ id: string; content: string }>;

    expect(ftsRows.length).toBe(1);
    expect(ftsRows[0]!.content).toContain('TypeScript');
  });

  // --- FTS sync: update ---

  it('update syncs FTS index', () => {
    const entry = controller.store({ content: 'old content alpha', category: 'fact', sensitivity: 'public' });
    controller.update(entry.id, { content: 'new content beta' });

    const oldRows = sqlite
      .prepare("SELECT id FROM memories_fts WHERE memories_fts MATCH '\"alpha\"'")
      .all();
    expect(oldRows.length).toBe(0);

    const newRows = sqlite
      .prepare("SELECT id FROM memories_fts WHERE memories_fts MATCH '\"beta\"'")
      .all();
    expect(newRows.length).toBe(1);
  });

  // --- FTS sync: delete ---

  it('delete syncs FTS index', () => {
    const entry = controller.store({ content: 'gamma content', category: 'fact', sensitivity: 'public' });
    controller.delete(entry.id);

    const rows = sqlite
      .prepare("SELECT id FROM memories_fts WHERE memories_fts MATCH '\"gamma\"'")
      .all();
    expect(rows.length).toBe(0);
  });

  // --- FTS sync: evict ---

  it('evict syncs FTS index', () => {
    controller.store({ content: 'evict-aaa', category: 'fact', sensitivity: 'public' });
    controller.store({ content: 'evict-bbb', category: 'fact', sensitivity: 'public' });
    controller.store({ content: 'keep-ccc', category: 'fact', sensitivity: 'public' });
    // Access keep-ccc to raise its value score
    controller.recall('keep-ccc');
    controller.recall('keep-ccc');

    controller.evict(1);

    const remaining = sqlite
      .prepare('SELECT id FROM memories_fts')
      .all();
    expect(remaining.length).toBe(1);
  });

  // --- FTS5 BM25 recall ---

  it('recall uses FTS5 BM25 for ranking', () => {
    controller.store({ content: 'TypeScript strict mode is enabled in this project', category: 'fact', sensitivity: 'public' });
    controller.store({ content: 'Python is used for scripting', category: 'fact', sensitivity: 'public' });
    controller.store({ content: 'TypeScript and React are the frontend stack', category: 'fact', sensitivity: 'public' });

    const results = controller.recall('TypeScript');
    expect(results.length).toBe(2);
    for (const r of results) {
      expect(r.content.toLowerCase()).toContain('typescript');
    }
  });

  it('recall with Chinese query works', () => {
    controller.store({ content: '用户喜欢暗色模式', category: 'preference', sensitivity: 'public' });
    controller.store({ content: '项目使用React框架', category: 'fact', sensitivity: 'public' });

    const results = controller.recall('暗色模式');
    expect(results.length).toBe(1);
    expect(results[0]!.content).toContain('暗色模式');
  });

  it('recall with sensitivity filter excludes secret from FTS results', () => {
    controller.store({ content: 'Secret database password is hunter2', category: 'fact', sensitivity: 'secret' });
    controller.store({ content: 'Public database host is localhost', category: 'fact', sensitivity: 'public' });

    const results = controller.recall('database');
    expect(results.length).toBe(1);
    expect(results[0]!.sensitivity).toBe('public');
  });

  it('recall with category filter returns only matching category', () => {
    controller.store({ content: 'User prefers dark theme', category: 'preference', sensitivity: 'public' });
    controller.store({ content: 'Dark theme is the default setting', category: 'fact', sensitivity: 'public' });

    const results = controller.recall('dark theme', { category: 'preference' });
    expect(results.length).toBe(1);
    expect(results[0]!.category).toBe('preference');
  });

  // --- buildFtsQuery ---

  it('buildFtsQuery extracts unicode tokens and joins with AND', () => {
    expect(buildFtsQuery('TypeScript React')).toBe('"TypeScript" AND "React"');
    expect(buildFtsQuery('hello world')).toBe('"hello" AND "world"');
    expect(buildFtsQuery('')).toBeNull();
    expect(buildFtsQuery('   ')).toBeNull();
    expect(buildFtsQuery('暗色模式')).toBe('"暗色模式"');
  });
});
