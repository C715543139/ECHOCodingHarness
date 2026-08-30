import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      exclude: ['src/cli.ts', 'src/web/client/main.tsx', 'src/web/client/vite-env.d.ts'],
      include: ['src/**/*.{ts,tsx}'],
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
    include: ['tests/**/*.test.{ts,tsx}'],
    // Windows process-tree assertions race when many PowerShell fixtures spawn in parallel.
    ...(process.platform === 'win32' ? { maxWorkers: 1 } : {}),
  },
});
