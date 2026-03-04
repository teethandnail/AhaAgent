import { describe, it, expect } from 'vitest';
import { LLMRouter } from './router.js';

describe('LLMRouter', () => {
  it('should format chat completion request', () => {
    const router = new LLMRouter({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'gpt-4',
      baseUrl: 'https://api.openai.com/v1',
    });
    const request = router.buildRequest([{ role: 'user', content: 'hello' }]);
    expect(request.model).toBe('gpt-4');
    expect(request.messages).toHaveLength(1);
  });

  it('should include traceId in request metadata', () => {
    const router = new LLMRouter({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'gpt-4',
      baseUrl: 'https://api.openai.com/v1',
    });
    const request = router.buildRequest([], 'trace-123');
    expect(request.traceId).toBe('trace-123');
  });

  it('should include model from config', () => {
    const router = new LLMRouter({
      provider: 'deepseek',
      apiKey: 'test-key',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com/v1',
    });
    const request = router.buildRequest([{ role: 'system', content: 'You are helpful' }]);
    expect(request.model).toBe('deepseek-chat');
  });
});
