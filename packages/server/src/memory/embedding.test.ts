import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildEmbeddingInput,
  cosineSimilarity,
  hashEmbeddingInput,
  loadEmbeddingConfig,
} from './embedding.js';

describe('embedding helpers', () => {
  afterEach(() => {
    delete process.env.AHA_EMBEDDING_API_KEY;
    delete process.env.AHA_EMBEDDING_MODEL;
    delete process.env.AHA_EMBEDDING_BASE_URL;
    vi.unstubAllEnvs();
  });

  it('loadEmbeddingConfig returns undefined without configuration', () => {
    delete process.env.AHA_EMBEDDING_API_KEY;
    delete process.env.AHA_EMBEDDING_MODEL;
    delete process.env.AHA_EMBEDDING_BASE_URL;
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('missing');
    });
    expect(loadEmbeddingConfig()).toBeUndefined();
  });

  it('loadEmbeddingConfig reads environment variables', () => {
    vi.stubEnv('AHA_EMBEDDING_API_KEY', 'test-key');
    vi.stubEnv('AHA_EMBEDDING_MODEL', 'text-embedding-3-large');
    vi.stubEnv('AHA_EMBEDDING_BASE_URL', 'https://example.test/v1');

    expect(loadEmbeddingConfig()).toEqual({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'text-embedding-3-large',
      baseUrl: 'https://example.test/v1',
    });
  });

  it('buildEmbeddingInput normalizes whitespace', () => {
    expect(buildEmbeddingInput('fact', '  project   uses TypeScript  ')).toBe(
      'fact: project uses TypeScript',
    );
  });

  it('hashEmbeddingInput is stable', () => {
    expect(hashEmbeddingInput('fact: project uses TypeScript')).toBe(
      hashEmbeddingInput('fact: project uses TypeScript'),
    );
  });

  it('cosineSimilarity returns higher score for aligned vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 5);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 5);
  });
});
