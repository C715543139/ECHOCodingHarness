import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      exclude: ['src/cli.ts'],
      include: ['src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      thresholds: {
        branches: 70,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
    environment: 'node',
    // Windows process integration tests exercise a shared, relatively expensive OS resource.
    // Serial files prevent runner contention from becoming part of their behavioral contract.
    fileParallelism: process.platform !== 'win32',
    include: ['tests/**/*.test.ts'],
  },
});
