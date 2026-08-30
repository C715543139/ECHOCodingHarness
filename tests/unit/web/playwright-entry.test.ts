import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('independent Playwright entry', () => {
  it('keeps Chromium Fake-Provider specs out of package scripts and paid URLs', async () => {
    const names = await readdir(path.join(ROOT, 'tests', 'e2e', 'web'));
    const config = await readFile(path.join(ROOT, 'playwright.config.ts'), 'utf8');
    const teardown = await readFile(
      path.join(ROOT, 'tests', 'e2e', 'web', 'global-teardown.ts'),
      'utf8',
    );
    const pack = await readFile(path.join(ROOT, 'package.json'), 'utf8');
    const ci = await readFile(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

    expect(config).toContain('tests/e2e/web');
    expect(config).toContain('echo-p2-b4-playwright');
    expect(config).toContain('global-teardown.ts');
    expect(config).toContain('tests/e2e/web/vite.config.ts');
    expect(config).toContain('ECHO_RUN_PROVIDER_SMOKE');
    expect(teardown).toContain('scan-web-artifacts.mjs');
    expect(config).not.toContain('api.openai.com');
    expect(pack).not.toContain('test:web:e2e');
    expect(ci).not.toContain('playwright');

    const specs = names.filter((name) => name.endsWith('.spec.ts')).sort();
    expect(specs).toEqual([
      'accessibility.spec.ts',
      'approval.spec.ts',
      'bootstrap.spec.ts',
      'keyboard.spec.ts',
      'provider-secret.spec.ts',
      'reconnect.spec.ts',
      'responsive.spec.ts',
      'session-flow.spec.ts',
      'trace-large-session.spec.ts',
    ]);
  });
});
