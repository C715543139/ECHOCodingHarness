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
    include: ['tests/**/*.test.ts'],
    // Windows process-tree assertions race when many PowerShell fixtures spawn in parallel.
    ...(process.platform === 'win32' ? { maxWorkers: 1 } : {}),
  },
});
