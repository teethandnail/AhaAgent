import type { MemoryEntry } from './memory-controller.js';

export interface RecallOptions {
  topK?: number;
  includeRestricted?: boolean;
}

/**
 * Score a memory against a query using simple keyword-based relevance.
 * Returns the count of distinct query words that appear in the memory content (case-insensitive).
 */
export function scoreMemory(query: string, content: string): number {
  const queryWords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const lowerContent = content.toLowerCase();

  let score = 0;
  for (const word of queryWords) {
    if (lowerContent.includes(word)) {
      score++;
    }
  }
  return score;
}

/**
 * Filter, score, sort, and return the top-K memories matching a query.
 *
 * - Sensitivity filter: never returns 'secret' memories.
 *   Returns 'public' by default; also 'restricted' if includeRestricted is true.
 * - Scoring: count of query words found in memory content (case-insensitive).
 * - Sort: by score descending, then by accessCount descending.
 * - Returns at most topK results (default 5).
 */
export function recallMemories(
  memories: MemoryEntry[],
  query: string,
  options: RecallOptions = {},
): MemoryEntry[] {
  const { topK = 5, includeRestricted = false } = options;

  // Filter by sensitivity
  const filtered = memories.filter((m) => {
    if (m.sensitivity === 'secret') return false;
    if (m.sensitivity === 'restricted' && !includeRestricted) return false;
    return true;
  });

  // Score each memory
  const scored = filtered.map((m) => ({
    memory: m,
    score: scoreMemory(query, m.content),
  }));

  // Only include memories with a positive score
  const matched = scored.filter((s) => s.score > 0);

  // Sort by score descending, then accessCount descending
  matched.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.memory.accessCount - a.memory.accessCount;
  });

  return matched.slice(0, topK).map((s) => s.memory);
}
