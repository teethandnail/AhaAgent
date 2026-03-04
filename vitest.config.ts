import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: ['packages/*/vitest.config.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**'],
      exclude: ['packages/*/src/**/*.test.ts', '**/node_modules/**', '**/dist/**'],
      reporter: ['text', 'lcov'],
    },
  },
});
