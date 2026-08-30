import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, devices } from '@playwright/test';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.join(os.tmpdir(), 'echo-p2-b4-playwright');
try {
  fs.rmSync(outputDir, { recursive: true, force: true });
} catch {
  // A previous run may still hold a handle; this run's scan still fail-closes leftovers.
}

process.env.ECHO_PW_OUTPUT_DIR = outputDir;
delete process.env.ECHO_RUN_PROVIDER_SMOKE;

export default defineConfig({
  testDir: path.join(repoRoot, 'tests/e2e/web'),
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 8_000 },
  outputDir: path.join(outputDir, 'test-results'),
  globalTeardown: path.join(repoRoot, 'tests/e2e/web/global-teardown.ts'),
  use: {
    baseURL: 'http://127.0.0.1:4177',
    headless: true,
    locale: 'zh-CN',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
    ignoreHTTPSErrors: true,
  },
  webServer: {
    command: 'pnpm exec vite --config tests/e2e/web/vite.config.ts --host 127.0.0.1 --port 4177',
    url: 'http://127.0.0.1:4177',
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
