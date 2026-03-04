import { defineProject } from 'vitest/config';
export default defineProject({
  test: { name: 'server', environment: 'node', globals: true, include: ['src/**/*.test.ts'] },
});
