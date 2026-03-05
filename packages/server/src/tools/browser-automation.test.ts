import { describe, it, expect } from 'vitest';
import { assertSafeBrowserUrl } from './browser-automation.js';

describe('assertSafeBrowserUrl', () => {
  it('rejects unsupported protocols', async () => {
    await expect(assertSafeBrowserUrl('file:///tmp/a.txt')).rejects.toThrow(
      'Unsupported URL protocol',
    );
  });

  it('rejects localhost', async () => {
    await expect(assertSafeBrowserUrl('http://localhost:3000')).rejects.toThrow(
      'Blocked local hostname',
    );
  });

  it('rejects hostnames resolving to private IP', async () => {
    await expect(
      assertSafeBrowserUrl(
        'https://example.com',
        async () => [{ address: '10.0.0.1', family: 4 }],
      ),
    ).rejects.toThrow('Blocked private resolved address');
  });
});
