import type { Database as SqliteDatabase } from 'better-sqlite3';

export interface RecallOptions {
  topK?: number;
  includeRestricted?: boolean;
  category?: string;
}

/**
 * Build an FTS5 MATCH query from a raw user query string.
 * Extracts unicode word tokens, wraps each in quotes, joins with AND.
 * Returns null if no valid tokens are found.
 */
export function buildFtsQuery(raw: string): string | null {
  const tokens = raw
    .match(/[\p{L}\p{N}_]+/gu)
    ?.map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (!tokens || tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(' AND ');
}

export interface FtsRecallRow {
  id: string;
  content: string;
  category: string;
  sensitivity: string;
  rank: number;
}

/**
 * Recall memories using FTS5 MATCH with BM25 ranking.
 * Supports sensitivity filtering (always excludes 'secret', optionally excludes 'restricted')
 * and optional category filtering.
 */
export function recallWithFts(
  sqlite: SqliteDatabase,
  query: string,
  options: RecallOptions = {},
): FtsRecallRow[] {
  const { topK = 5, includeRestricted = false, category } = options;

  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];

  // Build WHERE clauses
  const conditions: string[] = ['memories_fts MATCH ?'];
  const params: (string | number)[] = [ftsQuery];

  // Sensitivity filter: always exclude secret
  conditions.push("sensitivity != 'secret'");
  if (!includeRestricted) {
    conditions.push("sensitivity != 'restricted'");
  }

  // Category filter
  if (category) {
    conditions.push('category = ?');
    params.push(category);
  }

  params.push(topK);

  const sql = `
    SELECT id, content, category, sensitivity, bm25(memories_fts) AS rank
    FROM memories_fts
    WHERE ${conditions.join(' AND ')}
    ORDER BY rank ASC
    LIMIT ?
  `;

  return sqlite.prepare(sql).all(...params) as FtsRecallRow[];
}
