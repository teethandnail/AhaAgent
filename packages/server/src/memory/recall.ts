import type { Database as SqliteDatabase } from 'better-sqlite3';
import { Jieba } from '@node-rs/jieba';

const jieba = new Jieba();

export interface RecallOptions {
  topK?: number;
  includeRestricted?: boolean;
  category?: string;
}

/**
 * Detect whether a string contains CJK (Chinese/Japanese/Korean) characters.
 * Covers CJK Unified Ideographs, Extension A, and Compatibility Ideographs.
 */
export function containsCJK(text: string): boolean {
  return /[\u4e00-\u9fff\u3400-\u4dbf\uF900-\uFAFF]/.test(text);
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

export interface RerankableMemory {
  id: string;
  content: string;
  category: string;
  sensitivity: string;
  accessCount: number;
  lastAccessedAt: string;
  createdAt: string;
}

/** Common Chinese stop words to filter out from LIKE searches. */
const CJK_STOP_WORDS = new Set([
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们',
  '这', '那', '有', '不', '也', '都', '会', '被', '把', '从',
  '到', '和', '与', '及', '或', '但', '因', '为', '所以', '如果',
  '虽然', '什么', '怎么', '哪些', '哪个', '吗', '呢', '吧', '啊',
]);

/**
 * Tokenize query using jieba word segmentation for accurate Chinese word boundaries.
 * Filters out stop words and whitespace/punctuation.
 * E.g. "喜欢吃什么" → ["喜欢", "吃"]
 *      "爱吃的食物" → ["爱", "吃", "食物"]
 *      "food preferences" → ["food", "preferences"]
 */
export function tokenizeForLike(query: string): string[] {
  const words = jieba.cut(query, true); // HMM enabled for better segmentation
  const result = words
    .map((w) => w.trim())
    .filter((w) => w.length > 0 && !/^\p{P}+$/u.test(w) && !CJK_STOP_WORDS.has(w));
  return [...new Set(result)];
}

/**
 * Recall memories using SQL LIKE for CJK queries on the memories table.
 * CJK tokens are split into bigrams for effective substring matching.
 * Uses OR logic: any bigram/token match returns the row.
 * Returns 0 as rank since LIKE does not provide BM25 scoring.
 */
export function recallWithLike(
  sqlite: SqliteDatabase,
  query: string,
  options: RecallOptions = {},
): FtsRecallRow[] {
  const { topK = 5, includeRestricted = false, category } = options;

  const tokens = tokenizeForLike(query);
  if (tokens.length === 0) return [];

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  // Token matching with OR logic: any token match qualifies the row
  const likeConditions = tokens.map(() => 'content LIKE ?');
  conditions.push(`(${likeConditions.join(' OR ')})`);
  for (const token of tokens) {
    params.push(`%${token}%`);
  }

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

  const sqlStr = `
    SELECT id, content, category, sensitivity, 0 AS rank
    FROM memories
    WHERE ${conditions.join(' AND ')}
    LIMIT ?
  `;

  return sqlite.prepare(sqlStr).all(...params) as FtsRecallRow[];
}

/**
 * Recall memories using FTS5 MATCH with BM25 ranking.
 * For queries containing CJK characters, falls back to LIKE-based matching
 * since the FTS5 trigram tokenizer does not handle CJK text correctly.
 * Supports sensitivity filtering (always excludes 'secret', optionally excludes 'restricted')
 * and optional category filtering.
 */
export function recallWithFts(
  sqlite: SqliteDatabase,
  query: string,
  options: RecallOptions = {},
): FtsRecallRow[] {
  // CJK queries use LIKE-based matching to avoid FTS5 trigram tokenizer issues
  if (containsCJK(query)) {
    return recallWithLike(sqlite, query, options);
  }

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

function extractQueryTerms(query: string): string[] {
  if (containsCJK(query)) {
    return tokenizeForLike(query).map((term) => term.toLowerCase());
  }

  return (
    query
      .match(/[\p{L}\p{N}_]+/gu)
      ?.map((term) => term.trim().toLowerCase())
      .filter((term) => term.length > 0) ?? []
  );
}

function inferCategoryBoost(query: string, category: string): number {
  const q = query.toLowerCase();
  if (/(prefer|preference|like|likes|habit|theme|style|喜欢|偏好|习惯)/i.test(q)) {
    return category === 'preference' ? 0.18 : 0;
  }
  if (/(project|stack|uses|config|architecture|项目|技术栈|配置|架构)/i.test(q)) {
    return category === 'fact' ? 0.16 : 0;
  }
  if (/(how to|workflow|skill|技巧|方法|流程)/i.test(q)) {
    return category === 'skill' ? 0.14 : 0;
  }
  if (/(session|conversation|previous|刚才|上次|对话)/i.test(q)) {
    return category === 'context' ? 0.12 : 0;
  }
  return 0;
}

export function rerankMemories<T extends RerankableMemory>(
  query: string,
  items: T[],
  baseRanks: Map<string, number>,
  vectorScores?: Map<string, number>,
): Array<T & { score: number }> {
  const terms = extractQueryTerms(query);
  const now = Date.now();

  return items
    .map((item) => {
      const contentLower = item.content.toLowerCase();
      const matchCount = terms.filter((term) => contentLower.includes(term)).length;
      const textScore =
        terms.length === 0 ? 0
        : matchCount === terms.length ? 0.45
        : (matchCount / terms.length) * 0.35;

      const exactPhraseScore = contentLower.includes(query.trim().toLowerCase()) ? 0.18 : 0;
      const baseRank = baseRanks.get(item.id);
      const baseScore =
        typeof baseRank === 'number' ? 1 / (1 + Math.max(0, baseRank)) : 0.1;

      const lastAccessedAt = new Date(item.lastAccessedAt).getTime();
      const recencyDays = Number.isFinite(lastAccessedAt)
        ? Math.max(0, (now - lastAccessedAt) / (1000 * 60 * 60 * 24))
        : 365;
      const recencyScore = 0.14 / (1 + recencyDays);
      const frequencyScore = Math.min(0.14, Math.log10(item.accessCount + 1) * 0.1);
      const categoryScore = inferCategoryBoost(query, item.category);
      const vectorScore = Math.max(0, vectorScores?.get(item.id) ?? 0) * 0.22;

      return {
        ...item,
        score:
          Number(
            (
              textScore +
              exactPhraseScore +
              baseScore * 0.18 +
              recencyScore +
              frequencyScore +
              categoryScore +
              vectorScore
            ).toFixed(4),
          ),
      };
    })
    .sort((a, b) => b.score - a.score);
}
